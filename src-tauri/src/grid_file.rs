//! Das .grid-Dateiformat (Version 2): eine einzige SQLite-Datenbank.
//!
//!   meta         Metadaten (Schlüssel `meta` = JSON: Format, Version, Dokument-ID, Titel, Speicherzeit)
//!   ydoc_log     CRDT-Zustand (maßgeblich): Yjs-Updates in der Reihenfolge ihres Eintreffens; beim Öffnen
//!                werden sie nacheinander angewendet. Gelegentlich ersetzt ein Gesamtzustand das Protokoll.
//!   assets       hochgeladene Dateien (Schlüssel = SHA-256, `<hash>.thumb` = Vorschaubild) als Blobs
//!   tables, columns, options, files
//!                Verzeichnis der Tabellen (lesbar, für Auswertungen mit normalen SQLite-Werkzeugen)
//!   d_<tabelle>  echte Datentabelle: `id`, `pos` und je Spalte `c_<spalte>`
//!   l_<spalte>   Verknüpfungen einer Relationsspalte: `row_id`, `target_id`, `pos`
//!
//! Gespeichert wird inkrementell: je Änderung kommen die neuen Yjs-Updates ins Protokoll und die betroffenen
//! Zeilen werden in den Datentabellen aktualisiert, beides in einer Transaktion. Die Oberfläche liefert dazu
//! eine Liste von Operationen (`Ops`). Ältere Dateien (ZIP mit data.sqlite) lassen sich noch öffnen und
//! werden beim ersten Speichern in dieses Format umgewandelt.
//!
//! Die Oberfläche übergibt alles in einem Binärpaket (siehe `split_bundle`), weil Dateien groß
//! sein können und nicht als JSON durch die IPC-Schnittstelle sollen.

use rusqlite::{params, params_from_iter, types::Value as Sql, Connection, OpenFlags, Transaction};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};
use zip::ZipArchive;

const MAGIC: &[u8] = b"SQLite format 3\0";
/// `PRAGMA application_id`: „GRID“
const APPLICATION_ID: i64 = 0x4752_4944;
const FORMAT_VERSION: i64 = 2;

#[derive(Deserialize)]
struct AssetIn {
    key: String,
    len: usize,
}

#[derive(Deserialize)]
struct OptionP { id: String, name: String, color: String }

#[derive(Deserialize)]
struct ColSpec {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    target: Option<String>,
    width: Option<i64>,
    /// Hat die Spalte eine Spalte in der Datentabelle (nicht bei Relationen, Dateien und berechneten Spalten)?
    #[serde(default)]
    data: bool,
    #[serde(default)]
    options: Vec<OptionP>,
}

type RowSpec = (String, i64, Vec<Value>);

/// Eine Tabelle mit ihren Spalten; `rows` und `links` nur beim vollständigen Neuaufbau.
#[derive(Deserialize)]
struct TableSpec {
    id: String,
    name: String,
    pos: i64,
    columns: Vec<ColSpec>,
    #[serde(default)]
    rows: Vec<RowSpec>,
    /// (Zeile, Spalte, Zielzeile, Position)
    #[serde(default)]
    links: Vec<(String, String, String, f64)>,
}

#[derive(Deserialize)]
struct RowsOp { table: String, cols: Vec<String>, rows: Vec<RowSpec> }

#[derive(Deserialize)]
struct IdsOp { table: String, ids: Vec<String> }

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Ops {
    drop_tables: Vec<String>,
    /// Tabelle komplett neu aufbauen (neu, Spalten geändert)
    rebuild: Vec<TableSpec>,
    /// nur das Verzeichnis (Namen, Breiten, Optionen) auffrischen
    catalog: Vec<TableSpec>,
    upsert_rows: Vec<RowsOp>,
    delete_rows: Vec<IdsOp>,
    /// Zeilenreihenfolge neu schreiben
    positions: Vec<IdsOp>,
    /// (Tabelle, Zeile, Spalte, Zielzeile, Position)
    links_put: Vec<(String, String, String, String, f64)>,
    links_del: Vec<(String, String, String, String)>,
    /// (Tabelle, Zeile, Spalte, Hash, Name, Größe, MIME)
    files_put: Vec<(String, String, String, String, String, i64, String)>,
    files_del: Vec<(String, String, String, String)>,
    table_pos: Vec<(String, i64)>,
    /// Gesetzt: alle Assets, die nicht in dieser Liste stehen, werden gelöscht
    prune_assets: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveHeader {
    meta: Value,
    #[serde(default)]
    ops: Ops,
    /// Längen der Yjs-Updates, die im Binärteil hintereinander stehen
    updates: Vec<usize>,
    /// Das erste Update ist ein Gesamtzustand und ersetzt das Protokoll
    #[serde(default)]
    compact: bool,
    /// Datei neu anlegen (statt anzuhängen)
    #[serde(default)]
    full: bool,
    assets: Vec<AssetIn>,
}

fn err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{what}: {e}")
}

/// Paket: u32 (Big Endian) Länge des JSON, JSON, dann die Binärdaten (Updates, danach die Assets).
fn split_bundle(body: &[u8]) -> Result<(SaveHeader, &[u8]), String> {
    let n = body.get(..4).ok_or("Paket zu kurz")?;
    let n = u32::from_be_bytes([n[0], n[1], n[2], n[3]]) as usize;
    let json = body.get(4..4 + n).ok_or("Paketkopf unvollständig")?;
    let header: SaveHeader = serde_json::from_slice(json).map_err(err("Paketkopf ungültig"))?;
    Ok((header, &body[4 + n..]))
}

fn sql_value(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn temp_path(ext: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("grid-{}-{nanos}.{ext}", std::process::id()))
}

// ---------- Namen ----------

/// Bezeichner in doppelten Anführungszeichen (IDs sind meist hexadezimal, aber nicht garantiert).
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn data_table(id: &str) -> String { quoted(&format!("d_{id}")) }
fn link_table(col: &str) -> String { quoted(&format!("l_{col}")) }
fn data_col(col: &str) -> String { quoted(&format!("c_{col}")) }
fn sql_type(kind: &str) -> &'static str {
    match kind {
        "number" => "REAL",
        "checkbox" => "INTEGER",
        _ => "TEXT",
    }
}

// ---------- Schema ----------

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ydoc_log  (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS assets    (key TEXT PRIMARY KEY, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS tables    (id TEXT PRIMARY KEY, name TEXT NOT NULL, pos INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS columns   (table_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
                                      target_table TEXT, width INTEGER, pos INTEGER NOT NULL, PRIMARY KEY (table_id, id));
CREATE TABLE IF NOT EXISTS options   (table_id TEXT NOT NULL, column_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
                                      color TEXT NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (table_id, column_id, id));
CREATE TABLE IF NOT EXISTS files     (table_id TEXT NOT NULL, row_id TEXT NOT NULL, column_id TEXT NOT NULL, hash TEXT NOT NULL,
                                      name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
                                      PRIMARY KEY (table_id, row_id, column_id, hash));
";

fn init(db: &Connection) -> Result<(), String> {
    db.execute_batch(SCHEMA).map_err(err("Schema"))?;
    db.execute_batch(&format!("PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {FORMAT_VERSION};")).map_err(err("Schema"))
}

fn table_exists(tx: &Transaction, name: &str) -> Result<bool, String> {
    tx.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", params![name], |_| Ok(()))
        .map(|_| true)
        .or_else(|e| if matches!(e, rusqlite::Error::QueryReturnedNoRows) { Ok(false) } else { Err(format!("SQLite: {e}")) })
}

/// Ein fehlender Tabelle wird gemeldet, damit die Oberfläche die Datei komplett neu schreibt.
fn need_table(tx: &Transaction, id: &str) -> Result<(), String> {
    if table_exists(tx, &format!("d_{id}"))? { Ok(()) } else { Err(format!("Datentabelle {id} fehlt")) }
}

fn write_catalog(tx: &Transaction, t: &TableSpec) -> Result<(), String> {
    tx.execute("DELETE FROM options WHERE table_id = ?1", params![t.id]).map_err(err("options"))?;
    tx.execute("DELETE FROM columns WHERE table_id = ?1", params![t.id]).map_err(err("columns"))?;
    tx.execute("INSERT OR REPLACE INTO tables VALUES (?1, ?2, ?3)", params![t.id, t.name, t.pos]).map_err(err("tables"))?;
    for (ci, c) in t.columns.iter().enumerate() {
        tx.execute("INSERT INTO columns VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![t.id, c.id, c.name, c.kind, c.target, c.width, ci as i64])
            .map_err(err("columns"))?;
        for (oi, o) in c.options.iter().enumerate() {
            tx.execute("INSERT INTO options VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![t.id, c.id, o.id, o.name, o.color, oi as i64])
                .map_err(err("options"))?;
        }
    }
    Ok(())
}

/// Entfernt Datentabelle und Verknüpfungstabellen einer Tabelle (die Spalten kennt das Verzeichnis).
fn drop_objects(tx: &Transaction, id: &str) -> Result<(), String> {
    let rel: Vec<String> = {
        let mut st = tx.prepare("SELECT id FROM columns WHERE table_id = ?1 AND type = 'relation'").map_err(err("columns"))?;
        let rows = st.query_map(params![id], |r| r.get::<_, String>(0)).map_err(err("columns"))?;
        rows.collect::<Result<_, _>>().map_err(err("columns"))?
    };
    for c in rel {
        tx.execute(&format!("DROP TABLE IF EXISTS {}", link_table(&c)), []).map_err(err("DROP"))?;
    }
    tx.execute(&format!("DROP TABLE IF EXISTS {}", data_table(id)), []).map_err(err("DROP"))?;
    Ok(())
}

fn ensure_link_table(tx: &Transaction, col: &str) -> Result<(), String> {
    tx.execute(
        &format!("CREATE TABLE IF NOT EXISTS {} (row_id TEXT NOT NULL, target_id TEXT NOT NULL, pos REAL NOT NULL DEFAULT 0, PRIMARY KEY (row_id, target_id))", link_table(col)),
        [],
    )
    .map_err(err("Verknüpfungstabelle"))?;
    Ok(())
}

fn insert_rows(tx: &Transaction, table: &str, cols: &[String], rows: &[RowSpec]) -> Result<(), String> {
    let names: String = cols.iter().map(|c| format!(", {}", data_col(c))).collect();
    let marks: String = (0..cols.len()).map(|i| format!(", ?{}", i + 3)).collect();
    let mut st = tx
        .prepare(&format!("INSERT OR REPLACE INTO {} (id, pos{names}) VALUES (?1, ?2{marks})", data_table(table)))
        .map_err(err("Zeilen"))?;
    for (id, pos, values) in rows {
        if values.len() != cols.len() {
            return Err(format!("Zeile {id}: {} Werte für {} Spalten", values.len(), cols.len()));
        }
        let args = [Sql::Text(id.clone()), Sql::Integer(*pos)].into_iter().chain(values.iter().map(sql_value));
        st.execute(params_from_iter(args)).map_err(err("Zeile schreiben"))?;
    }
    Ok(())
}

fn rebuild(tx: &Transaction, t: &TableSpec) -> Result<(), String> {
    drop_objects(tx, &t.id)?;
    write_catalog(tx, t)?;
    let data: Vec<&ColSpec> = t.columns.iter().filter(|c| c.data).collect();
    let defs: String = data.iter().map(|c| format!(", {} {}", data_col(&c.id), sql_type(&c.kind))).collect();
    tx.execute(&format!("CREATE TABLE {} (id TEXT PRIMARY KEY, pos INTEGER NOT NULL{defs})", data_table(&t.id)), [])
        .map_err(err("Datentabelle anlegen"))?;
    let ids: Vec<String> = data.iter().map(|c| c.id.clone()).collect();
    insert_rows(tx, &t.id, &ids, &t.rows)?;
    for c in t.columns.iter().filter(|c| c.kind == "relation") {
        ensure_link_table(tx, &c.id)?;
    }
    for (row, col, target, pos) in &t.links {
        ensure_link_table(tx, col)?;
        tx.execute(&format!("INSERT OR REPLACE INTO {} VALUES (?1, ?2, ?3)", link_table(col)), params![row, target, pos]).map_err(err("Verknüpfung"))?;
    }
    Ok(())
}

fn apply_ops(tx: &Transaction, ops: &Ops) -> Result<(), String> {
    for id in &ops.drop_tables {
        drop_objects(tx, id)?;
        tx.execute("DELETE FROM options WHERE table_id = ?1", params![id]).map_err(err("options"))?;
        tx.execute("DELETE FROM columns WHERE table_id = ?1", params![id]).map_err(err("columns"))?;
        tx.execute("DELETE FROM tables WHERE id = ?1", params![id]).map_err(err("tables"))?;
        tx.execute("DELETE FROM files WHERE table_id = ?1", params![id]).map_err(err("files"))?;
    }
    for t in &ops.rebuild {
        rebuild(tx, t)?;
    }
    for t in &ops.catalog {
        write_catalog(tx, t)?;
    }
    for op in &ops.upsert_rows {
        need_table(tx, &op.table)?;
        insert_rows(tx, &op.table, &op.cols, &op.rows)?;
    }
    for op in &ops.delete_rows {
        need_table(tx, &op.table)?;
        let mut st = tx.prepare(&format!("DELETE FROM {} WHERE id = ?1", data_table(&op.table))).map_err(err("Zeilen löschen"))?;
        for id in &op.ids {
            st.execute(params![id]).map_err(err("Zeile löschen"))?;
        }
    }
    for op in &ops.positions {
        need_table(tx, &op.table)?;
        let mut st = tx.prepare(&format!("UPDATE {} SET pos = ?1 WHERE id = ?2", data_table(&op.table))).map_err(err("Reihenfolge"))?;
        for (i, id) in op.ids.iter().enumerate() {
            st.execute(params![i as i64, id]).map_err(err("Reihenfolge"))?;
        }
    }
    for (_, row, col, target, pos) in &ops.links_put {
        ensure_link_table(tx, col)?;
        tx.execute(&format!("INSERT OR REPLACE INTO {} VALUES (?1, ?2, ?3)", link_table(col)), params![row, target, pos]).map_err(err("Verknüpfung"))?;
    }
    for (_, row, col, target) in &ops.links_del {
        ensure_link_table(tx, col)?;
        tx.execute(&format!("DELETE FROM {} WHERE row_id = ?1 AND target_id = ?2", link_table(col)), params![row, target]).map_err(err("Verknüpfung"))?;
    }
    for (t, r, c, h, n, s, m) in &ops.files_put {
        tx.execute("INSERT OR REPLACE INTO files VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![t, r, c, h, n, s, m]).map_err(err("files"))?;
    }
    for (t, r, c, h) in &ops.files_del {
        tx.execute("DELETE FROM files WHERE table_id = ?1 AND row_id = ?2 AND column_id = ?3 AND hash = ?4", params![t, r, c, h]).map_err(err("files"))?;
    }
    for (id, pos) in &ops.table_pos {
        tx.execute("UPDATE tables SET pos = ?1 WHERE id = ?2", params![pos, id]).map_err(err("tables"))?;
    }
    Ok(())
}

// ---------- Speichern ----------

fn write_into(db: &mut Connection, header: &SaveHeader, bin: &[u8]) -> Result<u64, String> {
    let tx = db.transaction().map_err(err("SQLite"))?;
    let mut rest = bin;
    if header.compact || header.full {
        tx.execute("DELETE FROM ydoc_log", []).map_err(err("ydoc"))?;
    }
    for len in &header.updates {
        let data = rest.get(..*len).ok_or("Update fehlt im Paket")?;
        rest = &rest[*len..];
        tx.execute("INSERT INTO ydoc_log (data) VALUES (?1)", params![data]).map_err(err("ydoc"))?;
    }
    for a in &header.assets {
        let data = rest.get(..a.len).ok_or("Asset fehlt im Paket")?;
        rest = &rest[a.len..];
        tx.execute("INSERT OR REPLACE INTO assets (key, data) VALUES (?1, ?2)", params![a.key, data]).map_err(err("Asset"))?;
    }
    if let Some(keep) = &header.ops.prune_assets {
        tx.execute("CREATE TEMP TABLE IF NOT EXISTS keep_assets (key TEXT PRIMARY KEY)", []).map_err(err("Assets"))?;
        tx.execute("DELETE FROM keep_assets", []).map_err(err("Assets"))?;
        for k in keep {
            tx.execute("INSERT OR IGNORE INTO keep_assets VALUES (?1)", params![k]).map_err(err("Assets"))?;
        }
        tx.execute("DELETE FROM assets WHERE key NOT IN (SELECT key FROM keep_assets)", []).map_err(err("Assets"))?;
    }
    apply_ops(&tx, &header.ops)?;
    tx.execute("INSERT OR REPLACE INTO meta VALUES ('meta', ?1)", params![header.meta.to_string()]).map_err(err("meta"))?;
    let n: i64 = tx.query_row("SELECT COUNT(*) FROM ydoc_log", [], |r| r.get(0)).map_err(err("ydoc"))?;
    tx.commit().map_err(err("Speichern"))?;
    Ok(n as u64)
}

/// Schreibt das Paket. `full`: die Datei wird neu angelegt (atomar: erst daneben, dann umbenennen);
/// sonst werden die Änderungen an die vorhandene SQLite-Datei angehängt. Liefert die Zahl der Updates im Protokoll.
pub fn save_grid(path: &Path, body: &[u8]) -> Result<u64, String> {
    let (header, bin) = split_bundle(body)?;
    if header.full {
        let tmp = path.with_extension("grid.tmp");
        let _ = fs::remove_file(&tmp);
        let result = (|| -> Result<u64, String> {
            let mut db = Connection::open(&tmp).map_err(err("Datei anlegen"))?;
            init(&db)?;
            let n = write_into(&mut db, &header, bin)?;
            db.close().map_err(|(_, e)| format!("SQLite: {e}"))?;
            File::open(&tmp).and_then(|f| f.sync_all()).map_err(err("Datei sichern"))?;
            Ok(n)
        })();
        match result {
            Ok(n) => {
                fs::rename(&tmp, path).map_err(err("Datei ersetzen"))?;
                Ok(n)
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e)
            }
        }
    } else {
        if !is_sqlite(path) {
            return Err("Datei ist keine SQLite-Datei (neu schreiben)".into());
        }
        let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(err("Datei öffnen"))?;
        write_into(&mut db, &header, bin)
    }
}

fn is_sqlite(path: &Path) -> bool {
    let mut magic = [0u8; 16];
    File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && magic == MAGIC
}

// ---------- Öffnen ----------

fn bundle_out(meta: Value, updates: Vec<Vec<u8>>, assets: Vec<(String, Vec<u8>)>, legacy: bool) -> Vec<u8> {
    let header = serde_json::json!({
        "meta": meta,
        "legacy": legacy,
        "updates": updates.iter().map(|u| u.len()).collect::<Vec<_>>(),
        "assets": assets.iter().map(|(k, b)| serde_json::json!({ "key": k, "len": b.len() })).collect::<Vec<_>>(),
    })
    .to_string();
    let total: usize = updates.iter().map(|u| u.len()).sum::<usize>() + assets.iter().map(|a| a.1.len()).sum::<usize>();
    let mut out = Vec::with_capacity(4 + header.len() + total);
    out.extend_from_slice(&(header.len() as u32).to_be_bytes());
    out.extend_from_slice(header.as_bytes());
    for u in updates {
        out.extend_from_slice(&u);
    }
    for (_, b) in assets {
        out.extend_from_slice(&b);
    }
    out
}

/// Liest eine .grid-Datei und liefert ein Paket: u32 Länge, JSON {meta, legacy, updates[len], assets[{key,len}]}, Updates, Assets.
pub fn open_grid(path: &Path) -> Result<Vec<u8>, String> {
    if is_sqlite(path) {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err("Datei öffnen"))?;
        let meta: String = db.query_row("SELECT value FROM meta WHERE key = 'meta'", [], |r| r.get(0)).map_err(err("meta"))?;
        let meta: Value = serde_json::from_str(&meta).map_err(err("meta ungültig"))?;
        let updates: Vec<Vec<u8>> = {
            let mut st = db.prepare("SELECT data FROM ydoc_log ORDER BY id").map_err(err("ydoc"))?;
            let rows = st.query_map([], |r| r.get::<_, Vec<u8>>(0)).map_err(err("ydoc"))?;
            rows.collect::<Result<_, _>>().map_err(err("ydoc"))?
        };
        let assets: Vec<(String, Vec<u8>)> = {
            let mut st = db.prepare("SELECT key, data FROM assets ORDER BY key").map_err(err("Assets"))?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))).map_err(err("Assets"))?;
            rows.collect::<Result<_, _>>().map_err(err("Assets"))?
        };
        return Ok(bundle_out(meta, updates, assets, false));
    }
    open_legacy(path)
}

/// Format 1: ZIP mit meta.json, data.sqlite (Tabelle `ydoc`) und assets/.
fn open_legacy(path: &Path) -> Result<Vec<u8>, String> {
    let mut z = ZipArchive::new(File::open(path).map_err(err("Datei öffnen"))?).map_err(err("Keine gültige .grid-Datei"))?;

    let mut meta = String::new();
    z.by_name("meta.json").map_err(err("meta.json fehlt"))?.read_to_string(&mut meta).map_err(err("meta.json"))?;
    let meta: Value = serde_json::from_str(&meta).map_err(err("meta.json ungültig"))?;

    let tmp = temp_path("sqlite");
    let ydoc = (|| -> Result<Vec<u8>, String> {
        let mut f = File::create(&tmp).map_err(err("Temp"))?;
        std::io::copy(&mut z.by_name("data.sqlite").map_err(err("data.sqlite fehlt"))?, &mut f).map_err(err("data.sqlite"))?;
        drop(f);
        let db = Connection::open_with_flags(&tmp, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err("SQLite"))?;
        db.query_row("SELECT state FROM ydoc WHERE id = 1", [], |r| r.get::<_, Vec<u8>>(0)).map_err(err("ydoc"))
    })();
    let _ = fs::remove_file(&tmp);
    let ydoc = ydoc?;

    let mut assets: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..z.len() {
        let mut entry = z.by_index(i).map_err(err("ZIP"))?;
        let name = entry.name().map_err(err("ZIP"))?.to_string();
        if let Some(key) = name.strip_prefix("assets/").filter(|k| !k.is_empty() && !entry.is_dir()) {
            let key = key.to_string();
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes).map_err(err("Asset lesen"))?;
            assets.push((key, bytes));
        }
    }
    Ok(bundle_out(meta, vec![ydoc], assets, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    fn bundle(json: Value, bin: &[u8]) -> Vec<u8> {
        let j = json.to_string();
        let mut v = (j.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(j.as_bytes());
        v.extend_from_slice(bin);
        v
    }

    fn table_spec(rows: Value) -> Value {
        serde_json::json!({
            "id": "t1", "name": "Personen", "pos": 0,
            "columns": [
                { "id": "c1", "name": "Name", "type": "text", "target": null, "width": 210, "data": true },
                { "id": "c2", "name": "Alter", "type": "number", "target": null, "width": null, "data": true },
                { "id": "c3", "name": "Chef", "type": "relation", "target": "t1", "width": null, "data": false },
                { "id": "c4", "name": "Status", "type": "select", "target": null, "width": null, "data": true,
                  "options": [{ "id": "o1", "name": "Offen", "color": "sand" }] }
            ],
            "rows": rows,
            "links": [["r1", "c3", "r2", 1.5]]
        })
    }

    fn full(path: &Path) {
        let body = bundle(
            serde_json::json!({
                "meta": { "format": "grid", "formatVersion": 2, "docId": "d1" },
                "full": true, "updates": [4], "assets": [{ "key": "abc", "len": 3 }, { "key": "abc.thumb", "len": 2 }],
                "ops": {
                    "rebuild": [table_spec(serde_json::json!([["r1", 0, ["Anna", 3.5, "o1"]], ["r2", 1, ["Bob", 40, null]]]))],
                    "filesPut": [["t1", "r1", "c9", "abc", "foto.png", 3, "image/png"]]
                }
            }),
            b"YDOCxyzth",
        );
        save_grid(path, &body).unwrap();
    }

    fn open_header(path: &Path) -> (Value, Vec<u8>) {
        let out = open_grid(path).unwrap();
        let n = u32::from_be_bytes(out[..4].try_into().unwrap()) as usize;
        (serde_json::from_slice(&out[4..4 + n]).unwrap(), out[4 + n..].to_vec())
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gridtest-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn neu_anlegen_und_lesen_mit_echten_datentabellen() {
        let d = dir("neu");
        let path = d.join("a.grid");
        full(&path);
        assert!(!d.join("a.grid.tmp").exists());
        assert!(is_sqlite(&path));

        let (h, bin) = open_header(&path);
        assert_eq!(h["meta"]["docId"], "d1");
        assert_eq!(h["legacy"], false);
        assert_eq!(h["updates"], serde_json::json!([4]));
        assert_eq!(&bin[..4], b"YDOC");
        assert_eq!(&bin[4..7], b"xyz");
        assert_eq!(&bin[7..9], b"th");

        let db = Connection::open(&path).unwrap();
        let (name, age, status): (String, f64, String) =
            db.query_row("SELECT c_c1, c_c2, c_c4 FROM d_t1 WHERE id = 'r1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((name.as_str(), age, status.as_str()), ("Anna", 3.5, "o1"));
        let pos: i64 = db.query_row("SELECT pos FROM d_t1 WHERE id = 'r2'", [], |r| r.get(0)).unwrap();
        assert_eq!(pos, 1);
        let (to, lp): (String, f64) = db.query_row("SELECT target_id, pos FROM l_c3 WHERE row_id = 'r1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((to.as_str(), lp), ("r2", 1.5));
        let w: i64 = db.query_row("SELECT width FROM columns WHERE id = 'c1'", [], |r| r.get(0)).unwrap();
        assert_eq!(w, 210);
        let f: String = db.query_row("SELECT name FROM files WHERE hash = 'abc'", [], |r| r.get(0)).unwrap();
        assert_eq!(f, "foto.png");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn inkrementell_anhaengen_und_verdichten() {
        let d = dir("inkr");
        let path = d.join("a.grid");
        full(&path);
        let append = |ops: Value, updates: Vec<&[u8]>, compact: bool, assets: Value, extra: &[u8]| {
            let mut bin = updates.concat();
            bin.extend_from_slice(extra);
            save_grid(
                &path,
                &bundle(
                    serde_json::json!({
                        "meta": { "format": "grid", "formatVersion": 2, "docId": "d1" },
                        "compact": compact, "updates": updates.iter().map(|u| u.len()).collect::<Vec<_>>(),
                        "assets": assets, "ops": ops
                    }),
                    &bin,
                ),
            )
        };
        // eine Zelle ändern, eine Zeile löschen, eine Verknüpfung entfernen, neues Asset
        let n = append(
            serde_json::json!({
                "upsertRows": [{ "table": "t1", "cols": ["c1", "c2", "c4"], "rows": [["r1", 0, ["Anne", 4, "o1"]]] }],
                "deleteRows": [{ "table": "t1", "ids": ["r2"] }],
                "linksDel": [["t1", "r1", "c3", "r2"]],
                "linksPut": [["t1", "r1", "c3", "r1", 3.0]],
                "tablePos": [["t1", 5]]
            }),
            vec![b"U1", b"U22"], false, serde_json::json!([{ "key": "neu", "len": 1 }]), b"n",
        )
        .unwrap();
        assert_eq!(n, 3); // 1 aus dem Anlegen + 2
        let db = Connection::open(&path).unwrap();
        let name: String = db.query_row("SELECT c_c1 FROM d_t1 WHERE id = 'r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Anne");
        let rows: i64 = db.query_row("SELECT COUNT(*) FROM d_t1", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        let links: Vec<String> = db.prepare("SELECT target_id FROM l_c3").unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect();
        assert_eq!(links, ["r1"]);
        let tp: i64 = db.query_row("SELECT pos FROM tables WHERE id = 't1'", [], |r| r.get(0)).unwrap();
        assert_eq!(tp, 5);
        drop(db);
        let (h, bin) = open_header(&path);
        assert_eq!(h["updates"], serde_json::json!([4, 2, 3]));
        assert_eq!(&bin[..9], b"YDOCU1U22");

        // Verdichten: ein Gesamtzustand ersetzt das Protokoll; nicht aufgeführte Assets entfallen
        let n = append(serde_json::json!({ "pruneAssets": ["abc", "neu"] }), vec![b"ALL"], true, serde_json::json!([]), b"").unwrap();
        assert_eq!(n, 1);
        let (h, bin) = open_header(&path);
        assert_eq!(h["updates"], serde_json::json!([3]));
        assert_eq!(&bin[..3], b"ALL");
        let keys: Vec<_> = h["assets"].as_array().unwrap().iter().map(|a| a["key"].as_str().unwrap().to_string()).collect();
        assert_eq!(keys, ["abc", "neu"]);

        // Spalten ändern sich: Neuaufbau ersetzt Datentabelle und Verknüpfungen
        let spec = serde_json::json!({
            "id": "t1", "name": "Personen", "pos": 0,
            "columns": [{ "id": "c1", "name": "Name", "type": "text", "target": null, "width": null, "data": true }],
            "rows": [["r1", 0, ["Anne"]]]
        });
        append(serde_json::json!({ "rebuild": [spec] }), vec![], false, serde_json::json!([]), b"").unwrap();
        let db = Connection::open(&path).unwrap();
        assert!(db.query_row("SELECT c_c2 FROM d_t1", [], |_| Ok(())).is_err());
        assert!(db.query_row("SELECT * FROM l_c3", [], |_| Ok(())).is_err());
        // Tabelle löschen
        drop(db);
        append(serde_json::json!({ "dropTables": ["t1"] }), vec![], false, serde_json::json!([]), b"").unwrap();
        let db = Connection::open(&path).unwrap();
        assert!(db.query_row("SELECT * FROM d_t1", [], |_| Ok(())).is_err());
        let n: i64 = db.query_row("SELECT COUNT(*) FROM tables", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn fehlende_datentabelle_meldet_fehler_zum_neuschreiben() {
        let d = dir("fehl");
        let path = d.join("a.grid");
        full(&path);
        let body = bundle(
            serde_json::json!({
                "meta": {}, "updates": [], "assets": [],
                "ops": { "upsertRows": [{ "table": "gibtsnicht", "cols": [], "rows": [["r", 0, []]] }] }
            }),
            b"",
        );
        assert!(save_grid(&path, &body).is_err());
        // fehlgeschlagene Transaktion hinterlässt nichts
        let (h, _) = open_header(&path);
        assert_eq!(h["updates"], serde_json::json!([4]));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn altes_zip_format_laesst_sich_oeffnen() {
        let d = dir("zip");
        let path = d.join("alt.grid");
        let sq = temp_path("sqlite");
        {
            let db = Connection::open(&sq).unwrap();
            db.execute_batch("CREATE TABLE ydoc (id INTEGER PRIMARY KEY, state BLOB NOT NULL)").unwrap();
            db.execute("INSERT INTO ydoc VALUES (1, ?1)", params![b"ALT".to_vec()]).unwrap();
        }
        let mut z = ZipWriter::new(File::create(&path).unwrap());
        let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        z.start_file("meta.json", o).unwrap();
        z.write_all(br#"{"format":"grid","formatVersion":1,"docId":"alt"}"#).unwrap();
        z.start_file("data.sqlite", o).unwrap();
        z.write_all(&fs::read(&sq).unwrap()).unwrap();
        z.start_file("assets/h1", o).unwrap();
        z.write_all(b"bild").unwrap();
        z.finish().unwrap();
        let _ = fs::remove_file(&sq);

        let (h, bin) = open_header(&path);
        assert_eq!(h["legacy"], true);
        assert_eq!(h["meta"]["docId"], "alt");
        assert_eq!(h["updates"], serde_json::json!([3]));
        assert_eq!(&bin[..3], b"ALT");
        assert_eq!(&bin[3..], b"bild");
        // Anhängen an ein ZIP geht nicht: die Oberfläche muss neu schreiben
        let body = bundle(serde_json::json!({ "meta": {}, "updates": [], "assets": [] }), b"");
        assert!(save_grid(&path, &body).is_err());
        // Neu schreiben wandelt es um
        full(&path);
        assert!(is_sqlite(&path));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn kaputte_dateien_geben_fehler_statt_absturz() {
        let p = temp_path("grid");
        fs::write(&p, b"kein zip").unwrap();
        assert!(open_grid(&p).is_err());
        let _ = fs::remove_file(&p);
        assert!(save_grid(&p, b"\0\0").is_err());
    }
}
