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

pub fn now() -> i64 {
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
             CREATE TABLE IF NOT EXISTS members (doc TEXT NOT NULL, account TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (doc, account));
             CREATE TABLE IF NOT EXISTS stripe_customers (customer TEXT PRIMARY KEY, account TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS admin_log (doc TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (doc, seq));
             CREATE TABLE IF NOT EXISTS join_requests (doc TEXT NOT NULL, account TEXT NOT NULL, pub TEXT NOT NULL, name TEXT NOT NULL, time INTEGER NOT NULL, PRIMARY KEY (doc, account));",
        )?;
        // Spalten, die erst später dazukamen (bestehende Datenbanken werden erweitert)
        for (table, column, ddl) in [
            ("accounts", "plan", "TEXT NOT NULL DEFAULT 'free'"),
            ("accounts", "paid_until", "INTEGER"),
            ("accounts", "quota", "INTEGER NOT NULL DEFAULT 0"),
            ("docs", "owner", "TEXT"),
        ] {
            let have: i64 = c.query_row(&format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"), [], |r| r.get(0))?;
            if have == 0 { c.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"), [])?; }
        }
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

    pub fn all_docs(&self) -> rusqlite::Result<Vec<DocInfo>> {
        let c = self.conn();
        let mut s = c.prepare("SELECT id, name, updated FROM docs ORDER BY updated DESC")?;
        let rows = s.query_map([], |r| Ok(DocInfo { id: r.get(0)?, name: r.get(1)?, updated: r.get(2)? }))?;
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

    // ---------- Identität des Servers ----------

    /// Geheimer Schlüssel des Servers (Ed25519-Startwert, beim ersten Start erzeugt). Clients merken sich den öffentlichen Teil.
    pub fn server_key(&self) -> rusqlite::Result<[u8; 32]> {
        let c = self.conn();
        if let Some(v) = c.query_row("SELECT value FROM meta WHERE key = 'server_key'", [], |r| r.get::<_, Vec<u8>>(0)).optional()? {
            if let Ok(k) = v.try_into() { return Ok(k); }
        }
        let mut k = [0u8; 32];
        getrandom::fill(&mut k).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        c.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('server_key', ?1)", [&k[..]])?;
        Ok(k)
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
            .query_row("SELECT id, pub, status, created, plan, paid_until, quota FROM accounts WHERE id = ?1", [id], Account::from_row)
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
        let mut s = c.prepare("SELECT id, pub, status, created, plan, paid_until, quota FROM accounts ORDER BY created")?;
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

    pub fn set_plan(&self, id: &str, plan: &str, paid_until: Option<i64>, quota: i64) -> rusqlite::Result<()> {
        self.conn().execute("UPDATE accounts SET plan = ?2, paid_until = ?3, quota = ?4 WHERE id = ?1", params![id, plan, paid_until, quota])?;
        Ok(())
    }

    // ---------- Zahlungsanbieter (Stripe) ----------

    pub fn link_stripe_customer(&self, customer: &str, account: &str) -> rusqlite::Result<()> {
        self.conn().execute("INSERT OR REPLACE INTO stripe_customers (customer, account) VALUES (?1, ?2)", params![customer, account])?;
        Ok(())
    }

    pub fn stripe_account(&self, customer: &str) -> rusqlite::Result<Option<String>> {
        self.conn().query_row("SELECT account FROM stripe_customers WHERE customer = ?1", [customer], |r| r.get(0)).optional()
    }

    pub fn remove_account(&self, id: &str) -> rusqlite::Result<()> {
        let c = self.conn();
        c.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        c.execute("DELETE FROM members WHERE account = ?1", [id])?;
        Ok(())
    }

    // ---------- Zugriff auf Dokumente ----------

    // ---------- Besitzer und Speicherverbrauch ----------

    pub fn owner(&self, doc: &str) -> rusqlite::Result<Option<String>> {
        Ok(self.conn().query_row("SELECT owner FROM docs WHERE id = ?1", [doc], |r| r.get::<_, Option<String>>(0)).optional()?.flatten().filter(|o| !o.is_empty()))
    }

    /// Hält den Besitzer fest (legt die Zeile des Dokuments bei Bedarf an); ein vorhandener bleibt.
    pub fn set_owner(&self, doc: &str, account: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO docs (id, name, updated, owner) VALUES (?1, '', ?3, ?2)
             ON CONFLICT(id) DO UPDATE SET owner = COALESCE(NULLIF(owner, ''), ?2)",
            params![doc, account, now()],
        )?;
        Ok(())
    }

    /// Belegter Speicher eines Dokuments (Protokoll plus Dateien) in Bytes.
    pub fn doc_bytes(&self, doc: &str) -> rusqlite::Result<i64> {
        self.conn().query_row(
            "SELECT (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM log WHERE doc = ?1) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM blobs WHERE doc = ?1)",
            [doc], |r| r.get(0),
        )
    }

    /// Belegter Speicher aller Dokumente, die dem Konto gehören.
    pub fn owned_bytes(&self, account: &str) -> rusqlite::Result<i64> {
        self.conn().query_row(
            "SELECT COALESCE(SUM((SELECT COALESCE(SUM(LENGTH(data)), 0) FROM log WHERE log.doc = docs.id)
                               + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM blobs WHERE blobs.doc = docs.id)), 0)
             FROM docs WHERE owner = ?1",
            [account], |r| r.get(0),
        )
    }

    // ---------- Admin-Protokoll und Beitrittsanfragen ----------

    pub fn admin_log(&self, doc: &str) -> rusqlite::Result<Vec<String>> {
        let c = self.conn();
        let mut s = c.prepare("SELECT entry FROM admin_log WHERE doc = ?1 ORDER BY seq")?;
        let rows = s.query_map([doc], |r| r.get(0))?;
        rows.collect()
    }

    /// Hängt einen Eintrag an; scheitert, wenn die Nummer schon vergeben ist.
    pub fn append_admin(&self, doc: &str, seq: u64, json: &str) -> rusqlite::Result<()> {
        self.conn().execute("INSERT INTO admin_log (doc, seq, entry) VALUES (?1, ?2, ?3)", params![doc, seq as i64, json])?;
        Ok(())
    }

    /// Mehrere Einträge auf einmal (Umzug eines Dokuments auf diesen Server); alles oder nichts.
    pub fn append_admin_all(&self, doc: &str, entries: &[(u64, String)]) -> rusqlite::Result<()> {
        let mut c = self.conn();
        let t = c.transaction()?;
        for (seq, json) in entries {
            t.execute("INSERT INTO admin_log (doc, seq, entry) VALUES (?1, ?2, ?3)", params![doc, *seq as i64, json])?;
        }
        t.commit()
    }

    /// Mitglieder nach dem älteren Verfahren (ohne Protokoll): (Konto, Rolle)
    pub fn legacy_members(&self, doc: &str) -> rusqlite::Result<Vec<(String, String)>> {
        let c = self.conn();
        let mut s = c.prepare("SELECT account, role FROM members WHERE doc = ?1")?;
        let rows = s.query_map([doc], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    pub fn doc_exists(&self, doc: &str) -> rusqlite::Result<bool> {
        self.conn().query_row("SELECT 1 FROM docs WHERE id = ?1", [doc], |_| Ok(())).optional().map(|r| r.is_some())
    }

    pub fn add_request(&self, doc: &str, account: &str, pubkey: &str, name: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO join_requests (doc, account, pub, name, time) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![doc, account, pubkey, name, now()],
        )?;
        Ok(())
    }

    pub fn requests(&self, doc: &str) -> rusqlite::Result<Vec<Request>> {
        let c = self.conn();
        let mut s = c.prepare("SELECT account, pub, name, time FROM join_requests WHERE doc = ?1 ORDER BY time")?;
        let rows = s.query_map([doc], |r| Ok(Request { account: r.get(0)?, pubkey: r.get(1)?, name: r.get(2)?, time: r.get(3)? }))?;
        rows.collect()
    }

    pub fn has_request(&self, doc: &str, account: &str) -> rusqlite::Result<bool> {
        self.conn().query_row("SELECT 1 FROM join_requests WHERE doc = ?1 AND account = ?2", params![doc, account], |_| Ok(())).optional().map(|r| r.is_some())
    }

    pub fn remove_request(&self, doc: &str, account: &str) -> rusqlite::Result<()> {
        self.conn().execute("DELETE FROM join_requests WHERE doc = ?1 AND account = ?2", params![doc, account])?;
        Ok(())
    }
}

#[derive(serde::Serialize)]
pub struct Request {
    pub account: String,
    #[serde(rename = "pub")]
    pub pubkey: String,
    pub name: String,
    pub time: i64,
}

#[derive(Clone, Debug)]
pub struct Account {
    pub id: String,
    pub pubkey: String,
    pub status: String,
    pub created: i64,
    /// `free` oder `paid`
    pub plan: String,
    /// Ende des bezahlten Zeitraums (Unix-Sekunden); `None` = unbefristet
    pub paid_until: Option<i64>,
    /// Speicher in Bytes, den das Abo umfasst
    pub quota: i64,
}

impl Account {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
        Ok(Account { id: r.get(0)?, pubkey: r.get(1)?, status: r.get(2)?, created: r.get(3)?, plan: r.get(4)?, paid_until: r.get(5)?, quota: r.get(6)? })
    }
    pub fn approved(&self) -> bool { self.status == "approved" }
    /// Bezahltes Abo, das gerade läuft?
    pub fn paid_now(&self) -> bool { self.plan == "paid" && self.paid_until.is_none_or(|t| t > now()) }
}
