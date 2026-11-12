//! Das .grid-Dateiformat: ein ZIP-Archiv mit
//!
//!   meta.json        Metadaten (Format, Version, Dokument-ID, Titel, Speicherzeit)
//!   data.sqlite      SQLite-Datenbank: `ydoc` (CRDT-Zustand, maßgeblich) und eine lesbare
//!                    relationale Abbildung (tables, columns, options, rows, cells, links, files)
//!   assets/<hash>    hochgeladene Dateien (Hash = SHA-256), `assets/<hash>.thumb` = Vorschaubild
//!
//! Die Oberfläche übergibt alles in einem Binärpaket (siehe `split_bundle`), weil Dateien groß
//! sein können und nicht als JSON durch die IPC-Schnittstelle sollen.

use rusqlite::{params, types::Value as Sql, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

#[derive(Deserialize)]
struct AssetIn {
    key: String,
    len: usize,
    /// Datei steht schon im Archiv am Zielpfad und wird von dort übernommen (kein erneutes Senden).
    #[serde(default)]
    keep: bool,
}

#[derive(Deserialize)]
struct OptionP { id: String, name: String, color: String }

#[derive(Deserialize)]
struct ColumnP {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    target: Option<String>,
    width: Option<i64>,
    #[serde(default)]
    options: Vec<OptionP>,
}

#[derive(Deserialize)]
struct TableP { id: String, name: String, columns: Vec<ColumnP>, rows: Vec<String> }

#[derive(Deserialize, Default)]
struct Projection {
    tables: Vec<TableP>,
    /// (Tabelle, Zeile, Spalte, Wert)
    cells: Vec<(String, String, String, Value)>,
    /// (Tabelle, Zeile, Spalte, Zielzeile)
    links: Vec<(String, String, String, String)>,
    /// (Tabelle, Zeile, Spalte, Hash, Name, Größe, MIME)
    files: Vec<(String, String, String, String, String, i64, String)>,
}

#[derive(Deserialize)]
struct SaveHeader {
    meta: Value,
    projection: Projection,
    #[serde(rename = "ydocLen")]
    ydoc_len: usize,
    assets: Vec<AssetIn>,
}

fn err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{what}: {e}")
}

/// Paket: u32 (Big Endian) Länge des JSON, JSON, dann die Binärdaten (ydoc, danach die Assets).
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

const SCHEMA: &str = "
CREATE TABLE ydoc    (id INTEGER PRIMARY KEY CHECK (id = 1), state BLOB NOT NULL);
CREATE TABLE tables  (id TEXT PRIMARY KEY, name TEXT NOT NULL, pos INTEGER NOT NULL);
CREATE TABLE columns (table_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
                      target_table TEXT, width INTEGER, pos INTEGER NOT NULL, PRIMARY KEY (table_id, id));
CREATE TABLE options (table_id TEXT NOT NULL, column_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
                      color TEXT NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (table_id, column_id, id));
CREATE TABLE rows    (table_id TEXT NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (table_id, id));
CREATE TABLE cells   (table_id TEXT NOT NULL, row_id TEXT NOT NULL, column_id TEXT NOT NULL, value,
                      PRIMARY KEY (table_id, row_id, column_id));
CREATE TABLE links   (table_id TEXT NOT NULL, row_id TEXT NOT NULL, column_id TEXT NOT NULL,
                      target_row_id TEXT NOT NULL, PRIMARY KEY (table_id, row_id, column_id, target_row_id));
CREATE TABLE files   (table_id TEXT NOT NULL, row_id TEXT NOT NULL, column_id TEXT NOT NULL, hash TEXT NOT NULL,
                      name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
                      PRIMARY KEY (table_id, row_id, column_id, hash));
";

fn build_sqlite(p: &Projection, ydoc: &[u8]) -> Result<Vec<u8>, String> {
    let path = temp_path("sqlite");
    let result = (|| -> Result<Vec<u8>, String> {
        let mut db = Connection::open(&path).map_err(err("SQLite"))?;
        db.execute_batch(SCHEMA).map_err(err("Schema"))?;
        let tx = db.transaction().map_err(err("SQLite"))?;
        tx.execute("INSERT INTO ydoc (id, state) VALUES (1, ?1)", params![ydoc]).map_err(err("ydoc"))?;
        for (ti, t) in p.tables.iter().enumerate() {
            tx.execute("INSERT INTO tables VALUES (?1, ?2, ?3)", params![t.id, t.name, ti as i64]).map_err(err("tables"))?;
            for (ci, c) in t.columns.iter().enumerate() {
                tx.execute(
                    "INSERT INTO columns VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![t.id, c.id, c.name, c.kind, c.target, c.width, ci as i64],
                ).map_err(err("columns"))?;
                for (oi, o) in c.options.iter().enumerate() {
                    tx.execute("INSERT INTO options VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![t.id, c.id, o.id, o.name, o.color, oi as i64])
                        .map_err(err("options"))?;
                }
            }
            for (ri, r) in t.rows.iter().enumerate() {
                tx.execute("INSERT INTO rows VALUES (?1, ?2, ?3)", params![t.id, r, ri as i64]).map_err(err("rows"))?;
            }
        }
        for (t, r, c, v) in &p.cells {
            tx.execute("INSERT OR REPLACE INTO cells VALUES (?1, ?2, ?3, ?4)", params![t, r, c, sql_value(v)]).map_err(err("cells"))?;
        }
        for (t, r, c, x) in &p.links {
            tx.execute("INSERT OR IGNORE INTO links VALUES (?1, ?2, ?3, ?4)", params![t, r, c, x]).map_err(err("links"))?;
        }
        for (t, r, c, h, n, s, m) in &p.files {
            tx.execute("INSERT OR REPLACE INTO files VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![t, r, c, h, n, s, m]).map_err(err("files"))?;
        }
        tx.commit().map_err(err("SQLite"))?;
        db.close().map_err(|(_, e)| format!("SQLite: {e}"))?;
        fs::read(&path).map_err(err("SQLite lesen"))
    })();
    let _ = fs::remove_file(&path);
    result
}

/// Schreibt die Datei atomar (erst daneben, dann umbenennen), damit ein Absturz die alte nicht zerstört.
pub fn save_grid(path: &Path, body: &[u8]) -> Result<(), String> {
    let (header, bin) = split_bundle(body)?;
    let ydoc = bin.get(..header.ydoc_len).ok_or("ydoc fehlt im Paket")?;
    let mut rest = &bin[header.ydoc_len..];

    let sqlite = build_sqlite(&header.projection, ydoc)?;
    let mut old = File::open(path).ok().and_then(|f| ZipArchive::new(f).ok());

    let tmp = path.with_extension("grid.tmp");
    let mut write = || -> Result<(), String> {
        let mut z = ZipWriter::new(File::create(&tmp).map_err(err("Datei anlegen"))?);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

        z.start_file("meta.json", deflated).map_err(err("ZIP"))?;
        z.write_all(serde_json::to_string_pretty(&header.meta).map_err(err("meta"))?.as_bytes()).map_err(err("ZIP"))?;
        z.start_file("data.sqlite", deflated).map_err(err("ZIP"))?;
        z.write_all(&sqlite).map_err(err("ZIP"))?;

        for a in &header.assets {
            let name = format!("assets/{}", a.key);
            if a.keep {
                if let Some(old) = old.as_mut() {
                    if let Ok(entry) = old.by_name(&name) {
                        z.raw_copy_file(entry).map_err(err("ZIP"))?;
                    }
                }
                continue;
            }
            let bytes = rest.get(..a.len).ok_or("Asset fehlt im Paket")?;
            rest = &rest[a.len..];
            z.start_file(&name, stored).map_err(err("ZIP"))?;
            z.write_all(bytes).map_err(err("ZIP"))?;
        }
        z.finish().map_err(err("ZIP"))?.sync_all().map_err(err("Datei sichern"))?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    drop(old);
    fs::rename(&tmp, path).map_err(err("Datei ersetzen"))
}

/// Liest eine .grid-Datei und liefert ein Paket: u32 Länge, JSON {meta, ydocLen, assets[{key,len}]}, ydoc, Assets.
pub fn open_grid(path: &Path) -> Result<Vec<u8>, String> {
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

    let header = serde_json::json!({
        "meta": meta,
        "ydocLen": ydoc.len(),
        "assets": assets.iter().map(|(k, b)| serde_json::json!({ "key": k, "len": b.len() })).collect::<Vec<_>>(),
    })
    .to_string();
    let mut out = Vec::with_capacity(4 + header.len() + ydoc.len() + assets.iter().map(|a| a.1.len()).sum::<usize>());
    out.extend_from_slice(&(header.len() as u32).to_be_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&ydoc);
    for (_, b) in assets {
        out.extend_from_slice(&b);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(json: Value, bin: &[u8]) -> Vec<u8> {
        let j = json.to_string();
        let mut v = (j.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(j.as_bytes());
        v.extend_from_slice(bin);
        v
    }

    fn sample(assets: Value, ydoc: &[u8], assets_bin: &[u8]) -> Vec<u8> {
        let mut bin = ydoc.to_vec();
        bin.extend_from_slice(assets_bin);
        bundle(
            serde_json::json!({
                "meta": { "format": "grid", "formatVersion": 1, "docId": "d1" },
                "ydocLen": ydoc.len(),
                "assets": assets,
                "projection": {
                    "tables": [{ "id": "t1", "name": "Personen", "columns": [
                        { "id": "c1", "name": "Name", "type": "text", "target": null, "width": 210, "options": [] },
                        { "id": "c2", "name": "Status", "type": "select", "target": null, "width": null,
                          "options": [{ "id": "o1", "name": "Offen", "color": "sand" }] }
                    ], "rows": ["r1"] }],
                    "cells": [["t1", "r1", "c1", "Anna"], ["t1", "r1", "c2", 3.5]],
                    "links": [["t1", "r1", "c3", "r9"]],
                    "files": [["t1", "r1", "c4", "abc", "foto.png", 3, "image/png"]]
                }
            }),
            &bin,
        )
    }

    #[test]
    fn roundtrip_und_lesbare_sqlite_tabellen() {
        let dir = std::env::temp_dir().join(format!("gridtest-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.grid");
        let body = sample(
            serde_json::json!([{ "key": "abc", "len": 3 }, { "key": "abc.thumb", "len": 2 }]),
            b"YDOC",
            b"xyzth",
        );
        save_grid(&path, &body).unwrap();
        assert!(!dir.join("a.grid.tmp").exists());

        let out = open_grid(&path).unwrap();
        let n = u32::from_be_bytes(out[..4].try_into().unwrap()) as usize;
        let h: Value = serde_json::from_slice(&out[4..4 + n]).unwrap();
        assert_eq!(h["meta"]["docId"], "d1");
        assert_eq!(h["ydocLen"], 4);
        let bin = &out[4 + n..];
        assert_eq!(&bin[..4], b"YDOC");
        let keys: Vec<_> = h["assets"].as_array().unwrap().iter().map(|a| a["key"].as_str().unwrap().to_string()).collect();
        assert_eq!(keys, ["abc", "abc.thumb"]);
        assert_eq!(&bin[4..9], b"xyzth");

        // Die SQLite-Datei im ZIP lässt sich mit normalen Mitteln lesen.
        let mut z = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let tmp = temp_path("sqlite");
        std::io::copy(&mut z.by_name("data.sqlite").unwrap(), &mut File::create(&tmp).unwrap()).unwrap();
        let db = Connection::open(&tmp).unwrap();
        let v: String = db.query_row("SELECT value FROM cells WHERE column_id='c1'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "Anna");
        let f: f64 = db.query_row("SELECT value FROM cells WHERE column_id='c2'", [], |r| r.get(0)).unwrap();
        assert_eq!(f, 3.5);
        let w: i64 = db.query_row("SELECT width FROM columns WHERE id='c1'", [], |r| r.get(0)).unwrap();
        assert_eq!(w, 210);
        let name: String = db.query_row("SELECT name FROM files WHERE hash='abc'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "foto.png");
        drop(db);
        let _ = fs::remove_file(&tmp);

        // Zweites Speichern: "abc" wird aus der vorhandenen Datei übernommen, "neu" kommt dazu, "abc.thumb" entfällt.
        let body = sample(
            serde_json::json!([{ "key": "abc", "len": 0, "keep": true }, { "key": "neu", "len": 1 }]),
            b"YDO2",
            b"n",
        );
        save_grid(&path, &body).unwrap();
        let out = open_grid(&path).unwrap();
        let n = u32::from_be_bytes(out[..4].try_into().unwrap()) as usize;
        let h: Value = serde_json::from_slice(&out[4..4 + n]).unwrap();
        let bin = &out[4 + n..];
        assert_eq!(&bin[..4], b"YDO2");
        let keys: Vec<_> = h["assets"].as_array().unwrap().iter().map(|a| a["key"].as_str().unwrap().to_string()).collect();
        assert_eq!(keys, ["abc", "neu"]);
        assert_eq!(&bin[4..8], b"xyzn");
        let _ = fs::remove_dir_all(&dir);
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
