//! In-App-Kauf (App Store): Käufe schalten das Abo eines Kontos frei, ohne dass jemand am Server etwas bestätigt.
//! Die App schickt die von Apple signierte Transaktion; der Server prüft sie selbst (src/apple.rs). Apples
//! Server-Benachrichtigungen (optional) halten Verlängerungen und Rückerstattungen aktuell. docs/SYNC.md, „In-App-Kauf“.

use axum::{Json, extract::State, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}};

use crate::{Shared, apple, current, store};

/// So viele Tage über das Ende des bezahlten Zeitraums hinaus gilt das Abo noch (Apple wiederholt fehlgeschlagene Zahlungen).
const GRACE_DAYS: i64 = 3;

fn bad(msg: &str) -> Response { (StatusCode::BAD_REQUEST, msg.to_string()).into_response() }

/// Prüft den Beleg (Signatur, Kette, App) und liest die Transaktion.
fn check(s: &crate::AppState, jws: &str) -> Result<apple::Transaction, String> {
    let bundle = s.cfg.apple_bundle.as_deref().ok_or("In-App-Käufe sind auf diesem Server nicht eingerichtet")?;
    let (root, oids) = match &s.cfg.apple_root_override { Some(r) => (r.as_slice(), false), None => (apple::APPLE_ROOT_G3, true) };
    let tx = apple::transaction(&apple::verify_jws(jws, root, oids)?, bundle)?;
    if tx.sandbox && !s.cfg.apple_sandbox { return Err("Belege der Testumgebung nimmt dieser Server nicht an".into()); }
    Ok(tx)
}

fn quota_of(s: &crate::AppState, product: &str) -> Result<i64, String> {
    s.cfg.apple_products.iter().find(|(id, _)| id == product).map(|(_, q)| *q).ok_or_else(|| "Dieses Produkt schaltet hier nichts frei".to_string())
}

/// Konto, dem die Transaktion gehört (aus dem `appAccountToken`, den die App beim Kauf mitgibt).
fn owner(s: &crate::AppState, tx: &apple::Transaction) -> Result<String, String> {
    let account = tx.account.clone().ok_or("Der Beleg gehört zu keinem Grid-Konto")?;
    if !matches!(s.store.account(&account), Ok(Some(_))) { return Err("Dieses Konto gibt es auf diesem Server nicht".into()); }
    // Eine Transaktion zählt für genau ein Konto (ein Kauf lässt sich nicht an mehrere weitergeben)
    match s.store.claim_apple_tx(&tx.original_id, &account) {
        Ok(first) if first == account => Ok(account),
        Ok(_) => Err("Dieser Kauf gehört zu einem anderen Konto".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Abo aus dem Beleg setzen. Ein von Hand gesetztes, noch laufendes Abo bleibt unberührt (außer der Kauf reicht weiter).
fn grant(s: &crate::AppState, account: &str, tx: &apple::Transaction) -> Result<(), String> {
    let quota = quota_of(s, &tx.product)?;
    let until = tx.expires.ok_or("Der Beleg hat kein Ablaufdatum (kein Abo)")? + GRACE_DAYS * 86_400;
    let a = s.store.account(account).map_err(|e| e.to_string())?.ok_or("Konto fehlt")?;
    if a.paid_now() && s.store.plan_source(account) == "manual" && a.paid_until.is_none_or(|u| u >= until) && a.quota >= quota { return Ok(()); }
    s.store.set_plan_from(account, "paid", Some(until), quota, "apple").map_err(|e| e.to_string())
}

/// Ende des Abos durch den App Store (abgelaufen, erstattet, widerrufen): nur, wenn es aus einem Kauf stammt.
fn end(s: &crate::AppState, account: &str) {
    if s.store.plan_source(account) == "apple" { let _ = s.store.set_plan_from(account, "free", None, 0, "manual"); }
}

#[derive(serde::Deserialize)]
pub struct Jws { jws: String }

/// Die App meldet eine Transaktion (nach dem Kauf, beim Wiederherstellen und bei jedem Start). Wirkt nur für das angemeldete Konto.
pub async fn transaction(State(s): State<Shared>, h: HeaderMap, Json(b): Json<Jws>) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    let tx = match check(&s, &b.jws) { Ok(t) => t, Err(e) => return bad(&e) };
    if tx.account.as_deref() != Some(id.to_ascii_lowercase().as_str()) { return (StatusCode::FORBIDDEN, "Der Kauf wurde mit einem anderen Grid-Konto gemacht").into_response(); }
    let account = match owner(&s, &tx) { Ok(a) => a, Err(e) => return (StatusCode::FORBIDDEN, e).into_response() };
    if tx.revoked { end(&s, &account); return bad("Der Kauf wurde erstattet oder widerrufen"); }
    if tx.expires.is_none_or(|e| e <= store::now()) { return bad("Das Abo ist abgelaufen"); }
    if let Err(e) = grant(&s, &account, &tx) { return bad(&e); }
    let a = s.store.account(&account).ok().flatten();
    Json(serde_json::json!({ "active": a.as_ref().is_some_and(|a| a.paid_now()), "paidUntil": a.as_ref().and_then(|a| a.paid_until), "quota": a.map(|a| a.quota) })).into_response()
}

#[derive(serde::Deserialize)]
pub struct Notice { #[serde(rename = "signedPayload")] signed: String }

/// Server-Benachrichtigung von Apple (App Store Server Notifications V2). In App Store Connect als Adresse eintragen.
pub async fn notify(State(s): State<Shared>, Json(b): Json<Notice>) -> Response {
    if s.cfg.apple_bundle.is_none() { return StatusCode::NOT_FOUND.into_response(); }
    let (root, oids) = match &s.cfg.apple_root_override { Some(r) => (r.as_slice(), false), None => (apple::APPLE_ROOT_G3, true) };
    let outer = match apple::verify_jws(&b.signed, root, oids) { Ok(v) => v, Err(e) => return bad(&e) };
    let kind = outer["notificationType"].as_str().unwrap_or("");
    let Some(inner) = outer["data"]["signedTransactionInfo"].as_str() else { return StatusCode::OK.into_response() }; // z. B. Testmeldung
    let tx = match check(&s, inner) { Ok(t) => t, Err(e) => return bad(&e) };
    let Ok(account) = owner(&s, &tx) else { return StatusCode::OK.into_response() }; // unbekanntes Konto: nichts zu tun, Apple soll nicht wiederholen
    match kind {
        "SUBSCRIBED" | "DID_RENEW" | "OFFER_REDEEMED" | "RENEWAL_EXTENDED" if !tx.revoked && tx.expires.is_some_and(|e| e > store::now()) => { let _ = grant(&s, &account, &tx); }
        "EXPIRED" | "GRACE_PERIOD_EXPIRED" | "REFUND" | "REVOKE" => end(&s, &account),
        _ => {}
    }
    StatusCode::OK.into_response()
}
