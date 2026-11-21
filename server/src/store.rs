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
             CREATE TABLE IF NOT EXISTS blobs (doc TEXT NOT NULL, key TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (doc, key));",
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

    pub fn docs(&self) -> rusqlite::Result<Vec<DocInfo>> {
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
}
