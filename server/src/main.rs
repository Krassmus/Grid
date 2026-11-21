//! Aufruf: grid-server [--listen 127.0.0.1:8787] [--data ./data]
//! Der Zugangsschlüssel steht in der Umgebungsvariable GRID_TOKEN (Zwischenstand, siehe docs/SYNC.md).

use std::path::PathBuf;

fn arg(name: &str, env: &str, default: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
        .or_else(|| std::env::var(env).ok())
        .unwrap_or_else(|| default.to_string())
}

#[tokio::main]
async fn main() {
    let listen = arg("--listen", "GRID_LISTEN", "127.0.0.1:8787");
    let data = PathBuf::from(arg("--data", "GRID_DATA", "./data"));
    let Ok(token) = std::env::var("GRID_TOKEN") else {
        eprintln!("GRID_TOKEN fehlt: ein langer, zufälliger Zugangsschlüssel muss gesetzt sein.");
        std::process::exit(2);
    };
    if token.len() < 16 {
        eprintln!("GRID_TOKEN ist zu kurz (mindestens 16 Zeichen).");
        std::process::exit(2);
    }
    std::fs::create_dir_all(&data).expect("Datenordner anlegen");
    let app = grid_server::app(&data.join("grid.db"), &token).expect("Datenbank öffnen");
    let listener = tokio::net::TcpListener::bind(&listen).await.expect("Adresse belegt");
    println!("Grid-Server hört auf {listen}, Daten in {}", data.display());
    axum::serve(listener, app)
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await
        .expect("Server");
}
