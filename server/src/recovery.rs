//! E-Mail zum Konto: Adresse bestätigen und das Konto auf einem neuen Gerät wiederherstellen.
//!
//! Der Server speichert nur den **mit einem Passwort verschlüsselten** Kontotext (wie „Sichern oder übertragen“) und
//! gibt ihn erst heraus, wenn der Besitzer der Adresse einen per E-Mail geschickten Code nennt. Das Passwort kennt
//! der Server nie: Ohne es nützt der Text niemandem etwas. Hintergrund: docs/SYNC.md, Abschnitt „Konto und E-Mail“.

use axum::{Json, extract::State, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::{Shared, auth, current, store};

/// So lange gilt ein Code (Sekunden).
const CODE_TTL: i64 = 15 * 60;
/// So viele Codes je Konto bzw. Adresse und Stunde.
const MAX_PER_HOUR: usize = 5;

fn valid_email(e: &str) -> bool {
    let e = e.trim();
    e.len() <= 254 && e.len() >= 5 && !e.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | ',' | ';' | '"'))
        && e.split_once('@').is_some_and(|(l, d)| !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !d.contains('@'))
}

fn code_hash(s: &crate::AppState, key: &str, code: &str) -> String {
    auth::hex(&Sha256::digest(format!("{}|{key}|{code}", auth::hex(&s.secret))))
}

fn new_code() -> String {
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    format!("{:06}", u32::from_le_bytes(b) % 1_000_000)
}

fn allowed(s: &crate::AppState, who: &str) -> bool {
    let mut log = s.mail_log.lock().unwrap_or_else(|e| e.into_inner());
    let list = log.entry(who.to_string()).or_default();
    let now = store::now();
    list.retain(|t| now - t < 3600);
    if list.len() >= MAX_PER_HOUR { return false; }
    list.push(now);
    true
}

/// Schickt eine E-Mail über das eingestellte Programm (Standard sendmail). Der Text geht über die Standardeingabe.
async fn send(s: &crate::AppState, to: &str, subject: &str, body: &str) -> Result<(), String> {
    let from = s.cfg.mail_from.as_deref().ok_or("E-Mail ist auf diesem Server nicht eingerichtet")?;
    let cmd = s.cfg.mail_command.clone().unwrap_or_else(|| "/usr/sbin/sendmail -t -i".into());
    let mut parts = cmd.split_whitespace();
    let program = parts.next().ok_or("Kein Mailprogramm")?;
    let mut child = tokio::process::Command::new(program).args(parts)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map_err(|e| format!("Mailprogramm startet nicht: {e}"))?;
    let message = format!("From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n");
    if let Some(mut stdin) = child.stdin.take() { stdin.write_all(message.as_bytes()).await.map_err(|e| e.to_string())?; }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("Das Mailprogramm meldet einen Fehler".into()) }
}

fn bad(msg: &str) -> Response { (StatusCode::BAD_REQUEST, msg.to_string()).into_response() }
fn enabled(s: &crate::AppState) -> bool { s.cfg.mail_from.is_some() }

#[derive(serde::Deserialize)]
pub struct EmailBody { email: String }

/// Adresse zum Konto angeben: der Server schickt einen Code, der sie bestätigt.
pub async fn set_email(State(s): State<Shared>, h: HeaderMap, Json(b): Json<EmailBody>) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !enabled(&s) { return (StatusCode::NOT_FOUND, "E-Mail ist auf diesem Server nicht eingerichtet").into_response(); }
    let email = b.email.trim().to_string();
    if !valid_email(&email) { return bad("Die E-Mail-Adresse ist ungültig"); }
    if !allowed(&s, &format!("acct:{id}")) || !allowed(&s, &format!("mail:{}", email.to_lowercase())) { return (StatusCode::TOO_MANY_REQUESTS, "Zu viele Codes, bitte später noch einmal").into_response(); }
    let code = new_code();
    let key = format!("verify:{id}");
    if let Err(e) = s.store.put_code(&key, &code_hash(&s, &key, &code), store::now() + CODE_TTL, &email) { return crate::fail(e); }
    let name = s.cfg.name.clone().unwrap_or_else(|| "Grid".into());
    match send(&s, &email, &format!("{name}: Dein Bestätigungscode"), &format!("Dein Code zum Bestätigen dieser Adresse: {code}\n\nEr gilt 15 Minuten. Hast du das nicht angefordert, kannst du diese Nachricht ignorieren.")).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, e).into_response(),
    }
}

#[derive(serde::Deserialize)]
pub struct CodeBody { code: String }

/// Code aus der E-Mail einlösen: die Adresse gilt danach als bestätigt.
pub async fn confirm_email(State(s): State<Shared>, h: HeaderMap, Json(b): Json<CodeBody>) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    let key = format!("verify:{id}");
    let Ok(Some((hash, email))) = s.store.try_code(&key) else { return bad("Der Code ist abgelaufen oder zu oft falsch eingegeben worden") };
    if hash != code_hash(&s, &key, b.code.trim()) { return bad("Der Code stimmt nicht"); }
    let _ = s.store.drop_code(&key);
    match s.store.set_email(&id, &email) { Ok(()) => StatusCode::NO_CONTENT.into_response(), Err(e) => crate::fail(e) }
}

/// Adresse und Wiederherstellungsdaten entfernen.
pub async fn remove_email(State(s): State<Shared>, h: HeaderMap) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    match s.store.clear_email(&id) { Ok(()) => StatusCode::NO_CONTENT.into_response(), Err(e) => crate::fail(e) }
}

/// Wiederherstellungsdaten ablegen: der mit Passwort verschlüsselte Kontotext (nur mit bestätigter Adresse).
pub async fn put_recovery(State(s): State<Shared>, h: HeaderMap, body: String) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !body.starts_with("grid-account:1:") || body.len() > 16_384 { return bad("Das ist kein verschlüsseltes Grid-Konto"); }
    match s.store.email_of(&id) { Ok((Some(_), true, _)) => {} Ok(_) => return bad("Bestätige zuerst deine E-Mail-Adresse"), Err(e) => return crate::fail(e) }
    match s.store.set_recovery(&id, &body) { Ok(()) => StatusCode::NO_CONTENT.into_response(), Err(e) => crate::fail(e) }
}

/// Auf einem neuen Gerät: Code an die Adresse schicken lassen. Die Antwort verrät nicht, ob es die Adresse gibt.
pub async fn recover_start(State(s): State<Shared>, Json(b): Json<EmailBody>) -> Response {
    if !enabled(&s) { return (StatusCode::NOT_FOUND, "E-Mail ist auf diesem Server nicht eingerichtet").into_response(); }
    let email = b.email.trim().to_string();
    if !valid_email(&email) { return bad("Die E-Mail-Adresse ist ungültig"); }
    if !allowed(&s, &format!("mail:{}", email.to_lowercase())) { return (StatusCode::TOO_MANY_REQUESTS, "Zu viele Codes, bitte später noch einmal").into_response(); }
    if let Ok(Some(_)) = s.store.recovery_for(&email) {
        let code = new_code();
        let key = format!("recover:{}", email.to_lowercase());
        if s.store.put_code(&key, &code_hash(&s, &key, &code), store::now() + CODE_TTL, "").is_ok() {
            let name = s.cfg.name.clone().unwrap_or_else(|| "Grid".into());
            let _ = send(&s, &email, &format!("{name}: Konto wiederherstellen"), &format!("Dein Code zum Wiederherstellen deines Grid-Kontos: {code}\n\nEr gilt 15 Minuten. Hast du das nicht angefordert, kannst du diese Nachricht ignorieren; dein Konto bleibt unverändert.")).await;
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(serde::Deserialize)]
pub struct FinishBody { email: String, code: String }

/// Code einlösen: liefert den verschlüsselten Kontotext (das Passwort dazu kennt nur die Person).
pub async fn recover_finish(State(s): State<Shared>, Json(b): Json<FinishBody>) -> Response {
    if !enabled(&s) { return StatusCode::NOT_FOUND.into_response(); }
    let email = b.email.trim().to_lowercase();
    let key = format!("recover:{email}");
    let Ok(Some((hash, _))) = s.store.try_code(&key) else { return bad("Der Code ist abgelaufen oder zu oft falsch eingegeben worden") };
    if hash != code_hash(&s, &key, b.code.trim()) { return bad("Der Code stimmt nicht"); }
    let _ = s.store.drop_code(&key);
    match s.store.recovery_for(&email) {
        Ok(Some((id, blob))) => Json(serde_json::json!({ "id": id, "account": blob })).into_response(),
        Ok(None) => bad("Keine Wiederherstellungsdaten"),
        Err(e) => crate::fail(e),
    }
}
