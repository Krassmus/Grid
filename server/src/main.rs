//! Server starten:      grid-server [--listen 127.0.0.1:8787] [--data ./data] [--open-registration]
//! Konten verwalten:    grid-server accounts list|approve <Kennung>|remove <Kennung> [--data ./data]
//!                      grid-server accounts plan <Kennung> paid [--until 2027-12-31] [--quota 5GB]
//!                      grid-server accounts plan <Kennung> free
//! Ohne `--open-registration` (oder GRID_OPEN_REGISTRATION=1) warten neue Konten auf `approve`.
//! Speicherplatz: `grid-server status` zeigt freien Platz und vergebenen Speicher; unter `GRID_MIN_FREE` (Standard 5GB) freiem Platz nimmt der Server nichts Neues an.
//! In-App-Kauf (App Store): GRID_APPLE_BUNDLE_ID, GRID_APPLE_PRODUCTS="produkt=5GB,…", optional GRID_APPLE_SANDBOX=1, GRID_TERMS_URL, GRID_PRIVACY_URL.
//! Neue Dokumente müssen Ende-zu-Ende-verschlüsselt sein (docs/E2E.md); `--allow-plaintext` (GRID_ALLOW_PLAINTEXT=1) erlaubt auch unverschlüsselte.
//! Mit `--billing` (GRID_BILLING=1) braucht das Schreiben ein Abo und freien Speicher (Cloud); ohne ist alles frei.
//! Weitere Umgebungsvariablen: GRID_NAME (Anzeigename des Servers), GRID_CHECKOUT_URL / GRID_STRIPE_WEBHOOK_SECRET / GRID_STRIPE_QUOTA (Stripe), GRID_ADMIN_KEY (schaltet /admin/… ein), GRID_MANAGE_URL (Link „Abo verwalten“).

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
        if matches!(a.as_str(), "--data" | "--listen" | "--until" | "--quota") { it.next(); } else if !a.starts_with("--") { out.push(a.clone()); }
    }
    out
}

/// „5GB“, „500MB“, „100KB“ oder eine Zahl in Bytes.
fn parse_size(s: &str) -> Result<i64, String> {
    let t = s.trim().to_ascii_uppercase();
    let (num, mult) = if let Some(n) = t.strip_suffix("GB") { (n, 1_000_000_000) } else if let Some(n) = t.strip_suffix("MB") { (n, 1_000_000) } else if let Some(n) = t.strip_suffix("KB") { (n, 1_000) } else { (t.as_str(), 1) };
    num.trim().parse::<f64>().map(|v| (v * mult as f64) as i64).map_err(|_| format!("Größe „{s}“ nicht verständlich (z. B. 5GB)"))
}

/// „2027-12-31“ → Unix-Sekunden (Ende dieses Tages, UTC).
fn parse_date(s: &str) -> Result<i64, String> {
    let bad = || format!("Datum „{s}“ nicht verständlich (JJJJ-MM-TT)");
    let p: Vec<i64> = s.split('-').map(|x| x.parse().map_err(|_| bad())).collect::<Result<_, _>>()?;
    let [y, m, d] = p[..] else { return Err(bad()) };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) { return Err(bad()); }
    // Tage seit 1970-01-01 (bürgerlicher Kalender)
    let (y, m) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
    let days = 365 * y + y / 4 - y / 100 + y / 400 + (153 * (m - 3) + 2) / 5 + d - 1 - 719_468;
    Ok((days + 1) * 86_400 - 1)
}

fn gb(b: i64) -> String { format!("{:.1} GB", b as f64 / 1e9) }

/// Lage des Servers: Datenträger, Konten, vergebener Speicher gegenüber freiem Platz.
fn status() -> Result<(), String> {
    let dir = data_dir();
    let store = grid_server::Store::open(&dir.join("grid.db")).map_err(|e| e.to_string())?;
    let list = store.accounts().map_err(|e| e.to_string())?;
    let paid: Vec<_> = list.iter().filter(|a| a.approved() && a.paid_now()).collect();
    let granted: i64 = paid.iter().map(|a| a.quota).sum();
    let used: i64 = list.iter().map(|a| store.owned_bytes(&a.id).unwrap_or(0)).sum();
    let (free, total) = (grid_server::disk_free(&dir), grid_server::disk_total(&dir));
    println!("Datenträger:  {} frei von {}", free.map(|b| gb(b as i64)).unwrap_or("?".into()), total.map(|b| gb(b as i64)).unwrap_or("?".into()));
    println!("Konten:       {} ({} warten auf Freigabe), {} mit Abo", list.len(), list.iter().filter(|a| !a.approved()).count(), paid.len());
    println!("Speicher:     {} vergeben, {} belegt", gb(granted), gb(used));
    if let Some(f) = free {
        let open = (granted - used).max(0);
        if open as u64 > f { println!("ACHTUNG: Wenn alle ihren Speicher ausnutzen ({} offen), reicht der freie Platz nicht.", gb(open)); }
    }
    Ok(())
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
                let plan = if a.paid_now() { format!("Abo ({}) bis {}, Speicher {}", store.plan_source(&a.id), a.paid_until.map(|t| t.to_string()).unwrap_or("unbefristet".into()), gb(a.quota)) } else { "kostenlos".into() };
                println!("{}  {}  {}…  {}  belegt {}", label, a.id, &a.pubkey[..16], plan, gb(store.owned_bytes(&a.id).unwrap_or(0)));
            }
            Ok(())
        }
        Some("approve") => { let a = one(args.get(1))?; store.set_status(&a.id, "approved").map_err(|e| e.to_string())?; println!("Freigegeben: {}", a.id); Ok(()) }
        Some("plan") => {
            let a = one(args.get(1))?;
            match args.get(2).map(String::as_str) {
                Some("paid") => {
                    let until = std::env::args().skip_while(|x| x != "--until").nth(1).map(|d| parse_date(&d)).transpose()?;
                    let quota = parse_size(&std::env::args().skip_while(|x| x != "--quota").nth(1).unwrap_or_else(|| "5GB".into()))?;
                    store.set_plan(&a.id, "paid", until, quota).map_err(|e| e.to_string())?;
                    println!("{} hat jetzt ein Abo ({} Speicher{})", a.id, quota, until.map(|t| format!(", bis Unix-Zeit {t}")).unwrap_or_default());
                }
                Some("free") => { store.set_plan(&a.id, "free", None, 0).map_err(|e| e.to_string())?; println!("{} ist jetzt kostenlos", a.id); }
                _ => return Err("accounts plan <Kennung> paid [--until JJJJ-MM-TT] [--quota 5GB]  oder  free".into()),
            }
            Ok(())
        }
        Some("remove") => { let a = one(args.get(1))?; store.remove_account(&a.id).map_err(|e| e.to_string())?; println!("Entfernt: {}", a.id); Ok(()) }
        Some(other) => Err(format!("Unbekannter Befehl „{other}“ (list, approve, plan, remove)")),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("status") {
        if let Err(e) = status() { eprintln!("{e}"); std::process::exit(1); }
        return;
    }
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
    let billing = flag("--billing", "GRID_BILLING");
    let cfg = grid_server::Config {
        open_registration: open,
        billing,
        apple_bundle: std::env::var("GRID_APPLE_BUNDLE_ID").ok().filter(|b| !b.is_empty()),
        apple_products: std::env::var("GRID_APPLE_PRODUCTS").ok().map(|v| v.split(',').filter_map(|p| { let (id, q) = p.split_once('=')?; Some((id.trim().to_string(), parse_size(q).ok()?)) }).collect()).unwrap_or_default(),
        apple_sandbox: flag("--apple-sandbox", "GRID_APPLE_SANDBOX"),
        apple_root_override: None,
        terms_url: std::env::var("GRID_TERMS_URL").ok().filter(|u| u.starts_with("http")),
        privacy_url: std::env::var("GRID_PRIVACY_URL").ok().filter(|u| u.starts_with("http")),
        min_free: std::env::var("GRID_MIN_FREE").ok().and_then(|v| parse_size(&v).ok()).unwrap_or(5_000_000_000),
        mail_from: std::env::var("GRID_MAIL_FROM").ok().filter(|m| m.contains('@')),
        mail_command: std::env::var("GRID_MAIL_COMMAND").ok().filter(|m| !m.trim().is_empty()),
        require_enc: !flag("--allow-plaintext", "GRID_ALLOW_PLAINTEXT"),
        admin_key: std::env::var("GRID_ADMIN_KEY").ok().filter(|k| k.len() >= 16),
        manage_url: std::env::var("GRID_MANAGE_URL").ok().filter(|u| !u.is_empty()),
        name: std::env::var("GRID_NAME").ok().filter(|n| !n.is_empty()),
        stripe_webhook_secret: std::env::var("GRID_STRIPE_WEBHOOK_SECRET").ok().filter(|k| !k.is_empty()),
        checkout_url: std::env::var("GRID_CHECKOUT_URL").ok().filter(|u| u.starts_with("http")),
        stripe_quota: std::env::var("GRID_STRIPE_QUOTA").ok().and_then(|q| parse_size(&q).ok()),
    };
    if std::env::var("GRID_ADMIN_KEY").is_ok_and(|k| k.len() < 16) { eprintln!("GRID_ADMIN_KEY ist zu kurz (mindestens 16 Zeichen) und wird ignoriert."); }
    let app = grid_server::app_with(&data.join("grid.db"), cfg).expect("Datenbank öffnen");
    let listener = tokio::net::TcpListener::bind(&listen).await.expect("Adresse belegt");
    println!("Grid-Server hört auf {listen}, Daten in {}{}{}", data.display(), if open { " (offene Registrierung)" } else { "" }, if billing { " (Abo erforderlich)" } else { "" });
    axum::serve(listener, app)
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await
        .expect("Server");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sizes_and_dates() {
        assert_eq!(parse_size("5GB").unwrap(), 5_000_000_000);
        assert_eq!(parse_size("1.5gb").unwrap(), 1_500_000_000);
        assert_eq!(parse_size("500MB").unwrap(), 500_000_000);
        assert_eq!(parse_size("1234").unwrap(), 1234);
        assert!(parse_size("viel").is_err());
        assert_eq!(parse_date("2027-12-31").unwrap(), 1_830_297_599); // 23:59:59 UTC
        assert_eq!(parse_date("1970-01-01").unwrap(), 86_399);
        assert_eq!(parse_date("2024-02-29").unwrap(), 1_709_251_199);
        assert!(parse_date("2027-13-01").is_err());
        assert!(parse_date("morgen").is_err());
    }
}
