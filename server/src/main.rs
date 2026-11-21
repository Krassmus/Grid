//! Server starten:      grid-server [--listen 127.0.0.1:8787] [--data ./data] [--open-registration]
//! Konten verwalten:    grid-server accounts list|approve <Kennung>|remove <Kennung> [--data ./data]
//! Ohne `--open-registration` (oder GRID_OPEN_REGISTRATION=1) warten neue Konten auf `approve`.

use std::path::PathBuf;

fn arg(name: &str, env: &str, default: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
        .or_else(|| std::env::var(env).ok())
        .unwrap_or_else(|| default.to_string())
}

fn flag(name: &str, env: &str) -> bool {
    std::env::args().any(|a| a == name) || std::env::var(env).is_ok_and(|v| v == "1" || v == "true")
}

/// Argumente ohne Optionen (`--data <Ordner>` und andere `--…`).
fn positional(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--data" || a == "--listen" { it.next(); } else if !a.starts_with("--") { out.push(a.clone()); }
    }
    out
}

fn data_dir() -> PathBuf { PathBuf::from(arg("--data", "GRID_DATA", "./data")) }

fn accounts(args: &[String]) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let store = grid_server::Store::open(&dir.join("grid.db")).map_err(|e| e.to_string())?;
    let one = |prefix: Option<&String>| -> Result<grid_server::store::Account, String> {
        let prefix = prefix.ok_or("Kennung (oder der Anfang davon) fehlt")?;
        let mut found = store.find_accounts(prefix).map_err(|e| e.to_string())?;
        match found.len() {
            0 => Err(format!("Kein Konto mit Kennung „{prefix}…“")),
            1 => Ok(found.remove(0)),
            n => Err(format!("{n} Konten passen, bitte mehr von der Kennung angeben")),
        }
    };
    match args.first().map(String::as_str) {
        Some("list") | None => {
            let list = store.accounts().map_err(|e| e.to_string())?;
            if list.is_empty() { println!("Noch keine Konten."); }
            for a in list {
                let label = if a.approved() { "freigegeben" } else { "WARTET" };
                println!("{}  {}  {}…", label, a.id, &a.pubkey[..16]);
            }
            Ok(())
        }
        Some("approve") => { let a = one(args.get(1))?; store.set_status(&a.id, "approved").map_err(|e| e.to_string())?; println!("Freigegeben: {}", a.id); Ok(()) }
        Some("remove") => { let a = one(args.get(1))?; store.remove_account(&a.id).map_err(|e| e.to_string())?; println!("Entfernt: {}", a.id); Ok(()) }
        Some(other) => Err(format!("Unbekannter Befehl „{other}“ (list, approve, remove)")),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("accounts") {
        if let Err(e) = accounts(&positional(&args[1..])) {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }
    let listen = arg("--listen", "GRID_LISTEN", "127.0.0.1:8787");
    let data = data_dir();
    let open = flag("--open-registration", "GRID_OPEN_REGISTRATION");
    std::fs::create_dir_all(&data).expect("Datenordner anlegen");
    let app = grid_server::app(&data.join("grid.db"), open).expect("Datenbank öffnen");
    let listener = tokio::net::TcpListener::bind(&listen).await.expect("Adresse belegt");
    println!("Grid-Server hört auf {listen}, Daten in {}{}", data.display(), if open { " (offene Registrierung)" } else { "" });
    axum::serve(listener, app)
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await
        .expect("Server");
}
