//! Speicher: ein SQLite-Datei mit Dokumenten, Update-Protokoll und Dateien (Assets).

use rusqlite::{params, Connection, OptionalExtension};
use std::{path::Path, sync::Mutex};

pub struct Store(Mutex<Connection>);

#[derive(serde::Serialize)]
pub struct DocInfo {
    pub id: String,
    pub name: String,
    pub updated: i64,
}

/// Ab so vielen Einträgen ersetzt ein Gesamtzustand das Protokoll eines Dokuments.
pub const COMPACT_AT: i64 = 200;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        let c = Connection::open(path)?;
        c.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS log (doc TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (doc, seq));
             CREATE TABLE IF NOT EXISTS blobs (doc TEXT NOT NULL, key TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (doc, key));
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, pub TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS members (doc TEXT NOT NULL, account TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (doc, account));",
        )?;
        Ok(Store(Mutex::new(c)))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn touch_doc(&self, id: &str, name: Option<&str>) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO docs (id, name, updated) VALUES (?1, COALESCE(?2, ''), ?3)
             ON CONFLICT(id) DO UPDATE SET name = COALESCE(NULLIF(?2, ''), name), updated = ?3",
            params![id, name, now()],
        )?;
        Ok(())
    }

    /// Dokumente, in denen das Konto Mitglied ist.
    pub fn docs(&self, account: &str) -> rusqlite::Result<Vec<DocInfo>> {
        let c = self.conn();
        let mut s = c.prepare(
            "SELECT d.id, d.name, d.updated FROM docs d JOIN members m ON m.doc = d.id WHERE m.account = ?1 ORDER BY d.updated DESC",
        )?;
        let rows = s.query_map([account], |r| Ok(DocInfo { id: r.get(0)?, name: r.get(1)?, updated: r.get(2)? }))?;
        rows.collect()
    }

    pub fn log(&self, doc: &str) -> rusqlite::Result<Vec<Vec<u8>>> {
        let c = self.conn();
        let mut s = c.prepare("SELECT data FROM log WHERE doc = ?1 ORDER BY seq")?;
        let rows = s.query_map([doc], |r| r.get(0))?;
        rows.collect()
    }

    /// Hängt ein Update an. Liefert die Zahl der Einträge danach.
    pub fn append(&self, doc: &str, data: &[u8]) -> rusqlite::Result<i64> {
        let c = self.conn();
        c.execute(
            "INSERT INTO log (doc, seq, data) VALUES (?1, COALESCE((SELECT MAX(seq) FROM log WHERE doc = ?1), 0) + 1, ?2)",
            params![doc, data],
        )?;
        c.execute("UPDATE docs SET updated = ?2 WHERE id = ?1", params![doc, now()])?;
        c.query_row("SELECT COUNT(*) FROM log WHERE doc = ?1", [doc], |r| r.get(0))
    }

    /// Ersetzt das ganze Protokoll durch einen Gesamtzustand.
    pub fn compact(&self, doc: &str, full: &[u8]) -> rusqlite::Result<()> {
        let mut c = self.conn();
        let t = c.transaction()?;
        t.execute("DELETE FROM log WHERE doc = ?1", [doc])?;
        t.execute("INSERT INTO log (doc, seq, data) VALUES (?1, 1, ?2)", params![doc, full])?;
        t.commit()
    }

    pub fn blob_keys(&self, doc: &str) -> rusqlite::Result<Vec<String>> {
        let c = self.conn();
        let mut s = c.prepare("SELECT key FROM blobs WHERE doc = ?1 ORDER BY key")?;
        let rows = s.query_map([doc], |r| r.get(0))?;
        rows.collect()
    }

    pub fn blob(&self, doc: &str, key: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        self.conn().query_row("SELECT data FROM blobs WHERE doc = ?1 AND key = ?2", params![doc, key], |r| r.get(0)).optional()
    }

    pub fn put_blob(&self, doc: &str, key: &str, data: &[u8]) -> rusqlite::Result<()> {
        self.conn().execute("INSERT OR REPLACE INTO blobs (doc, key, data) VALUES (?1, ?2, ?3)", params![doc, key, data])?;
        Ok(())
    }

    // ---------- Server-Geheimnis ----------

    /// Das Geheimnis, mit dem Anmelde-Rätsel und Sitzungsschlüssel beglaubigt werden (beim ersten Start erzeugt).
    pub fn secret(&self) -> rusqlite::Result<Vec<u8>> {
        let c = self.conn();
        if let Some(v) = c.query_row("SELECT value FROM meta WHERE key = 'secret'", [], |r| r.get::<_, Vec<u8>>(0)).optional()? {
            return Ok(v);
        }
        let mut v = vec![0u8; 32];
        getrandom::fill(&mut v).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        c.execute("INSERT INTO meta (key, value) VALUES ('secret', ?1)", [&v])?;
        Ok(v)
    }

    // ---------- Konten ----------

    pub fn account(&self, id: &str) -> rusqlite::Result<Option<Account>> {
        self.conn()
            .query_row("SELECT id, pub, status, created FROM accounts WHERE id = ?1", [id], Account::from_row)
            .optional()
    }

    /// Legt ein Konto an (wartend oder gleich freigegeben).
    pub fn add_account(&self, id: &str, pubkey: &str, approved: bool) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT OR IGNORE INTO accounts (id, pub, status, created) VALUES (?1, ?2, ?3, ?4)",
            params![id, pubkey, if approved { "approved" } else { "pending" }, now()],
        )?;
        Ok(())
    }

    pub fn accounts(&self) -> rusqlite::Result<Vec<Account>> {
        let c = self.conn();
        let mut s = c.prepare("SELECT id, pub, status, created FROM accounts ORDER BY created")?;
        let rows = s.query_map([], Account::from_row)?;
        rows.collect()
    }

    /// Konten, deren Kennung mit `prefix` beginnt.
    pub fn find_accounts(&self, prefix: &str) -> rusqlite::Result<Vec<Account>> {
        Ok(self.accounts()?.into_iter().filter(|a| !prefix.is_empty() && a.id.starts_with(prefix)).collect())
    }

    pub fn set_status(&self, id: &str, status: &str) -> rusqlite::Result<()> {
        self.conn().execute("UPDATE accounts SET status = ?2 WHERE id = ?1", params![id, status])?;
        Ok(())
    }

    pub fn remove_account(&self, id: &str) -> rusqlite::Result<()> {
        let c = self.conn();
        c.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        c.execute("DELETE FROM members WHERE account = ?1", [id])?;
        Ok(())
    }

    // ---------- Zugriff auf Dokumente ----------

    /// Darf das Konto auf das Dokument zugreifen? Ein Dokument ohne Mitglieder gehört dem ersten Konto, das es braucht.
    pub fn access(&self, doc: &str, account: &str) -> rusqlite::Result<bool> {
        let c = self.conn();
        c.execute(
            "INSERT INTO members (doc, account, role) SELECT ?1, ?2, 'admin' WHERE NOT EXISTS (SELECT 1 FROM members WHERE doc = ?1)",
            params![doc, account],
        )?;
        c.query_row("SELECT 1 FROM members WHERE doc = ?1 AND account = ?2", params![doc, account], |_| Ok(())).optional().map(|r| r.is_some())
    }
}

#[derive(Clone, Debug)]
pub struct Account {
    pub id: String,
    pub pubkey: String,
    pub status: String,
    pub created: i64,
}

impl Account {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
        Ok(Account { id: r.get(0)?, pubkey: r.get(1)?, status: r.get(2)?, created: r.get(3)? })
    }
    pub fn approved(&self) -> bool { self.status == "approved" }
}
