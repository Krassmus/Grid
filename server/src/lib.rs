//! Grid-Sync-Server: Yjs-Dokumente über WebSocket abgleichen, Protokoll und Dateien speichern.
//! Protokoll und Hintergrund: docs/SYNC.md

mod adminlog;
mod apple;
mod auth;
mod disk;
mod iap;
mod recovery;
pub mod store;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
pub use store::Store;
/// Freier Platz und Gesamtgröße des Datenträgers (für `grid-server status`).
pub fn disk_free(dir: &std::path::Path) -> Option<u64> { disk::free_bytes(dir) }
pub fn disk_total(dir: &std::path::Path) -> Option<u64> { disk::total_bytes(dir) }
use store::COMPACT_AT;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use yrs::{
    Doc, ReadTxn, StateVector, Transact, Update,
    updates::{decoder::Decode, encoder::Encode},
};

const MSG_STEP1: u8 = 0;
const MSG_UPDATE: u8 = 1;
/// Verschlüsselte Dokumente (docs/E2E.md): Client → Server Eintrag / Gesamtzustand, Server → Client nummerierter Eintrag
const MSG_ENC_PUT: u8 = 4;
const MSG_ENC_ENTRY: u8 = 5;
const MSG_ENC_SNAPSHOT: u8 = 6;
const MAX_BLOB: usize = 256 * 1024 * 1024;
const MAX_WS_MESSAGE: usize = 128 * 1024 * 1024;

/// Ein Dokument im Speicher: Yjs-Zustand und Verteiler an die verbundenen Clients.
struct Room {
    doc: Mutex<Doc>,
    tx: broadcast::Sender<Event>,
}

#[derive(Clone)]
enum Event {
    /// Yjs-Update von Client `from`
    Update(u64, Arc<Vec<u8>>),
    /// Das Dokument wurde auf Verschlüsselung umgestellt: Klartext-Verbindungen schließen, die Clients verbinden neu
    Reset,
    /// Neuer verschlüsselter Eintrag (Nummer, Bytes)
    Enc(i64, Arc<Vec<u8>>),
    /// Mitglieder oder Beitrittsanfragen haben sich geändert: Berechtigung neu prüfen, Clients benachrichtigen
    Members,
}

/// Einstellungen des Servers.
#[derive(Clone, Default)]
pub struct Config {
    /// Neue Konten werden gleich freigegeben (z. B. im eigenen Netz); sonst warten sie auf `accounts approve`.
    pub open_registration: bool,
    /// Abo und Speicherkontingent erzwingen (Cloud). Ohne: alles frei, wie im eigenen Netz.
    pub billing: bool,
    /// Schlüssel für die Verwaltungsschnittstelle `/admin/…` (z. B. für einen Webshop); ohne ist sie abgeschaltet.
    pub admin_key: Option<String>,
    /// Adresse, unter der Benutzer ihr Abo verwalten (wird in Grid verlinkt).
    pub manage_url: Option<String>,
    /// Name des Servers, den Grid anzeigt (z. B. „Firmenserver“).
    pub name: Option<String>,
    /// Kennung der App im App Store (z. B. `eu.townwork.grid`); schaltet In-App-Käufe ein. Ohne: abgeschaltet.
    pub apple_bundle: Option<String>,
    /// Produkte, die ein Abo freischalten: (Produktkennung, Speicher in Bytes)
    pub apple_products: Vec<(String, i64)>,
    /// Auch Belege der Testumgebung (Sandbox, TestFlight, App-Prüfung) annehmen
    pub apple_sandbox: bool,
    /// Nur für Tests: anderes Wurzelzertifikat statt dem von Apple
    #[doc(hidden)]
    pub apple_root_override: Option<Vec<u8>>,
    /// Links, die Apple in der Kaufansicht verlangt
    pub terms_url: Option<String>,
    pub privacy_url: Option<String>,
    /// Unter diesem freien Platz auf dem Datenträger (Bytes) nimmt der Server nichts Neues mehr an; 0 = nicht prüfen.
    pub min_free: i64,
    /// Absender für E-Mails (aktiviert Bestätigung und Wiederherstellung per E-Mail); ohne ist beides abgeschaltet.
    pub mail_from: Option<String>,
    /// Programm zum Versenden (liest die Nachricht samt Kopfzeilen von der Standardeingabe); Standard `/usr/sbin/sendmail -t -i`.
    pub mail_command: Option<String>,
    /// Neue Dokumente müssen Ende-zu-Ende-verschlüsselt sein (docs/E2E.md); bestehende unverschlüsselte laufen weiter, bis ein Admin sie verschlüsselt.
    pub require_enc: bool,
    /// Signaturgeheimnis des Stripe-Webhooks (`whsec_…`); ohne ist `POST /billing/stripe` abgeschaltet.
    pub stripe_webhook_secret: Option<String>,
    /// Adresse des Stripe-Zahlungslinks (Payment Link); Grid hängt `client_reference_id=<Konto>` an.
    pub checkout_url: Option<String>,
    /// Speicher in Bytes für ein über Stripe bezahltes Abo
    pub stripe_quota: Option<i64>,
}

pub struct AppState {
    store: Store,
    secret: Vec<u8>,
    /// Identität des Servers: Clients merken sich den öffentlichen Schlüssel und erkennen so einen falschen oder getauschten Server.
    server_key: ed25519_dalek::SigningKey,
    cfg: Config,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    /// Abgespielte Admin-Protokolle (fällt bei jedem neuen Eintrag weg)
    members: Mutex<HashMap<String, Arc<adminlog::State>>>,
    next_client: Mutex<u64>,
    /// Zeitpunkte versandter Codes je Konto bzw. Adresse (Begrenzung gegen Missbrauch)
    mail_log: Mutex<HashMap<String, Vec<i64>>>,
    /// freier Platz auf dem Datenträger der Daten
    disk: disk::Watch,
}

pub type Shared = Arc<AppState>;

struct Writable { ok: bool, code: &'static str, reason: String }

fn human(b: i64) -> String {
    let b = b.max(0) as f64;
    if b >= 1e9 { format!("{:.1} GB", b / 1e9) } else if b >= 1e6 { format!("{:.0} MB", b / 1e6) } else { format!("{:.0} KB", b / 1e3) }
}

pub fn app(data: &std::path::Path, open_registration: bool) -> rusqlite::Result<Router> {
    app_with(data, Config { open_registration, ..Config::default() })
}

pub fn app_with(data: &std::path::Path, cfg: Config) -> rusqlite::Result<Router> {
    let store = Store::open(data)?;
    let state = Arc::new(AppState {
        secret: store.secret()?,
        server_key: ed25519_dalek::SigningKey::from_bytes(&store.server_key()?),
        store,
        cfg,
        rooms: Mutex::new(HashMap::new()),
        members: Mutex::new(HashMap::new()),
        next_client: Mutex::new(0),
        mail_log: Mutex::new(HashMap::new()),
        disk: disk::Watch::new(data.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."))),
    });
    Ok(Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/server", get(server_info))
        .route("/challenge", get(challenge))
        .route("/login", post(login))
        .route("/me", get(me))
        .route("/me/email", post(recovery::set_email).delete(recovery::remove_email))
        .route("/me/email/confirm", post(recovery::confirm_email))
        .route("/me/recovery", axum::routing::put(recovery::put_recovery))
        .route("/recover/start", post(recovery::recover_start))
        .route("/recover/finish", post(recovery::recover_finish))
        .route("/billing/stripe", post(stripe_webhook))
        .route("/billing/apple/transaction", post(iap::transaction))
        .route("/billing/apple/notify", post(iap::notify))
        .route("/admin/accounts", get(admin_accounts))
        .route("/admin/accounts/{id}/plan", axum::routing::put(admin_plan))
        .route("/docs", get(list_docs))
        .route("/docs/{doc}/members", get(members))
        .route("/docs/{doc}/admin", post(post_admin))
        .route("/docs/{doc}/import", post(import_log))
        .route("/docs/{doc}/join", post(join_doc))
        .route("/docs/{doc}/join/{account}", axum::routing::delete(reject_join))
        .route("/docs/{doc}/keys", get(get_keys).put(put_keys))
        .route("/blobs/{doc}", get(list_blobs))
        .route("/blob/{doc}/{key}", get(get_blob).put(put_blob))
        .route("/ws/{doc}", get(ws))
        .layer(DefaultBodyLimit::max(MAX_BLOB))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .with_state(state))
}

// ---------- Hilfen ----------

/// Das Konto hinter dem Sitzungsschlüssel im Kopf `Authorization: Bearer …`.
fn account_of(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let token = headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")?;
    auth::token_account(&state.secret, token)
}

fn valid_doc(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `<64 Hex-Zeichen>` oder `<64 Hex-Zeichen>.thumb`
fn valid_key(key: &str) -> bool {
    let hash = key.strip_suffix(".thumb").unwrap_or(key);
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn fail<E: std::fmt::Display>(e: E) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
}

// ---------- HTTP ----------

fn server_pub(s: &AppState) -> String { auth::hex(&s.server_key.verifying_key().to_bytes()) }

/// Wer bin ich: Name, öffentlicher Schlüssel (daran erkennt Grid den Server wieder), Abo-Pflicht.
async fn server_info(State(s): State<Shared>) -> Response {
    Json(serde_json::json!({ "name": s.cfg.name, "pub": server_pub(&s), "billing": s.cfg.billing, "requireEnc": s.cfg.require_enc, "version": env!("CARGO_PKG_VERSION") })).into_response()
}

/// Rätsel für die Anmeldung. Der Server unterschreibt es mit seinem Schlüssel und beweist so, dass er der erwartete ist.
async fn challenge(State(s): State<Shared>) -> Response {
    use ed25519_dalek::Signer;
    let nonce = auth::new_nonce(&s.secret);
    let sig = auth::hex(&s.server_key.sign(format!("grid-server-v1\n{nonce}").as_bytes()).to_bytes());
    Json(serde_json::json!({ "nonce": nonce, "server": { "pub": server_pub(&s), "sig": sig } })).into_response()
}

#[derive(serde::Deserialize)]
struct Login { id: String, #[serde(rename = "pub")] pubkey: String, nonce: String, sig: String }

/// Anmeldung: Signatur über das Rätsel. Liefert einen Sitzungsschlüssel, falls das Konto freigegeben ist.
async fn login(State(s): State<Shared>, Json(l): Json<Login>) -> Response {
    let reply = |code: StatusCode, status: &str, reason: &str| (code, Json(serde_json::json!({ "status": status, "reason": reason }))).into_response();
    if !valid_doc(&l.id) { return reply(StatusCode::BAD_REQUEST, "invalid", "Kennung ungültig"); }
    if let Err(e) = auth::verify_login(&s.secret, &l.id, &l.pubkey, &l.nonce, &l.sig) {
        return reply(StatusCode::UNAUTHORIZED, "invalid", e);
    }
    let pubkey = l.pubkey.to_ascii_lowercase();
    let account = match s.store.account(&l.id) {
        Ok(Some(a)) => a,
        Ok(None) => {
            if s.store.add_account(&l.id, &pubkey, s.cfg.open_registration).is_err() { return reply(StatusCode::INTERNAL_SERVER_ERROR, "error", "Speicherfehler"); }
            match s.store.account(&l.id) { Ok(Some(a)) => a, _ => return reply(StatusCode::INTERNAL_SERVER_ERROR, "error", "Speicherfehler") }
        }
        Err(_) => return reply(StatusCode::INTERNAL_SERVER_ERROR, "error", "Speicherfehler"),
    };
    if account.pubkey != pubkey { return reply(StatusCode::FORBIDDEN, "invalid", "Kennung gehört zu einem anderen Schlüssel"); }
    if !account.approved() { return reply(StatusCode::FORBIDDEN, "pending", "Konto wartet auf Freigabe"); }
    let (token, exp) = auth::new_token(&s.secret, &l.id);
    Json(serde_json::json!({ "status": "ok", "token": token, "exp": exp })).into_response()
}

/// Konto aus dem Sitzungsschlüssel, das außerdem noch freigegeben ist (Freigabe kann entzogen worden sein).
fn current(s: &AppState, h: &HeaderMap) -> Option<String> {
    let id = account_of(s, h)?;
    s.store.account(&id).ok().flatten().filter(|a| a.approved()).map(|a| a.id)
}

/// Konto, das auf das Dokument zugreifen darf; sonst die passende Fehlerantwort.
fn doc_access(s: &AppState, h: &HeaderMap, doc: &str) -> Result<String, Response> {
    let id = current(s, h).ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())?;
    if !valid_doc(doc) { return Err(StatusCode::BAD_REQUEST.into_response()); }
    match s.access(doc, &id) {
        Ok(true) => Ok(id),
        Ok(false) => Err(StatusCode::FORBIDDEN.into_response()),
        Err(e) => Err(fail(e)),
    }
}

impl AppState {
    /// Mitglieder laut Admin-Protokoll; `None`, wenn das Dokument (noch) kein Protokoll hat.
    fn log_state(&self, doc: &str) -> Result<Option<Arc<adminlog::State>>, String> {
        if let Some(s) = self.members.lock().unwrap_or_else(|e| e.into_inner()).get(doc) { return Ok(Some(s.clone())); }
        let entries = self.entries(doc)?;
        if entries.is_empty() { return Ok(None); }
        let state = Arc::new(adminlog::replay(doc, &entries).map_err(|e| format!("Admin-Protokoll ungültig: {e}"))?);
        self.members.lock().unwrap_or_else(|e| e.into_inner()).insert(doc.to_string(), state.clone());
        Ok(Some(state))
    }

    fn entries(&self, doc: &str) -> Result<Vec<adminlog::Entry>, String> {
        self.store.admin_log(doc).map_err(|e| e.to_string())?
            .iter().map(|j| serde_json::from_str(j).map_err(|e| e.to_string())).collect()
    }

    /// Rolle des Kontos im Dokument (`admin`/`member`), ohne etwas zu beanspruchen.
    fn role(&self, doc: &str, account: &str) -> Result<Option<String>, String> {
        if let Some(s) = self.log_state(doc)? { return Ok(s.role(account).map(String::from)); }
        Ok(self.store.legacy_members(doc).map_err(|e| e.to_string())?.into_iter().find(|(a, _)| a == account).map(|(_, r)| r))
    }

    /// Zugriff auf Inhalte: nur Mitglieder.
    fn access(&self, doc: &str, account: &str) -> Result<bool, String> {
        Ok(self.role(doc, account)?.is_some())
    }

    /// Das Dokument hat noch keine Mitglieder (weder Protokoll noch ältere Einträge): jemand muss es erst anlegen.
    fn unclaimed(&self, doc: &str) -> Result<bool, String> {
        Ok(self.log_state(doc)?.is_none() && self.store.legacy_members(doc).map_err(|e| e.to_string())?.is_empty())
    }

    /// Admins des Dokuments (nach Kennung sortiert).
    fn admins_of(&self, doc: &str) -> Result<Vec<String>, String> {
        if let Some(st) = self.log_state(doc)? {
            return Ok(st.members.iter().filter(|(_, m)| m.role == "admin").map(|(id, _)| id.clone()).collect());
        }
        let mut v: Vec<String> = self.store.legacy_members(doc).map_err(|e| e.to_string())?.into_iter().filter(|(_, r)| r == "admin").map(|(a, _)| a).collect();
        v.sort();
        Ok(v)
    }

    /// Besitzer: wem der Speicher des Dokuments zugerechnet wird. Wird beim ersten Bedarf aus dem Protokoll abgeleitet und gemerkt.
    fn owner_of(&self, doc: &str) -> Result<Option<String>, String> {
        if let Some(o) = self.store.owner(doc).map_err(|e| e.to_string())? { return Ok(Some(o)); }
        let first = match self.entries(doc)?.first() {
            Some(e) => Some(e.actor.clone()),
            None => self.admins_of(doc)?.into_iter().next(),
        };
        if let Some(o) = &first { self.store.set_owner(doc, o).map_err(|e| e.to_string())?; }
        Ok(first)
    }

    /// Wer das Dokument bezahlt: der Besitzer, solange sein Abo läuft, sonst der erste Admin mit laufendem Abo.
    fn payer_of(&self, doc: &str) -> Result<Option<store::Account>, String> {
        let owner = self.owner_of(doc)?;
        let paying = |id: &str| -> Result<Option<store::Account>, String> {
            Ok(self.store.account(id).map_err(|e| e.to_string())?.filter(|a| a.approved() && a.paid_now()))
        };
        if let Some(o) = &owner { if let Some(a) = paying(o)? { return Ok(Some(a)); } }
        for id in self.admins_of(doc)? { if let Some(a) = paying(&id)? { return Ok(Some(a)); } }
        Ok(None)
    }

    /// Darf in das Dokument geschrieben werden? Lesen geht immer; Schreiben braucht (bei eingeschaltetem Abo) einen
    /// zahlenden Admin und freien Speicher. Die Grenze ist weich: der Schreibvorgang, der sie überschreitet, geht noch durch.
    fn writable(&self, doc: &str) -> Writable {
        let ok = Writable { ok: true, code: "", reason: String::new() };
        let deny = |code: &'static str, reason: String| Writable { ok: false, code, reason };
        // Datenträger fast voll: nichts Neues annehmen, lesen geht weiter
        if self.cfg.min_free > 0 {
            if let Some(free) = self.disk.free() {
                if (free as i64) < self.cfg.min_free { return deny("disk", "Der Server hat zu wenig freien Speicherplatz und nimmt vorübergehend keine Änderungen an. Sie bleiben hier gespeichert und werden später hochgeladen.".into()); }
            }
        }
        if !self.cfg.billing { return ok; }
        let payer = match self.payer_of(doc) {
            Ok(Some(p)) => p,
            Ok(None) => return deny("no-plan", "Kein Admin dieses Dokuments hat ein aktives Abo. Das Dokument ist nur lesbar.".into()),
            Err(e) => return deny("error", e),
        };
        let used = if self.owner_of(doc).ok().flatten().as_deref() == Some(payer.id.as_str()) { self.store.owned_bytes(&payer.id) } else { self.store.doc_bytes(doc) }.unwrap_or(0);
        if used > payer.quota {
            return deny("quota", format!("Der Speicher ist voll ({} von {}). Das Dokument ist nur lesbar.", human(used), human(payer.quota)));
        }
        ok
    }

    fn notify(&self, doc: &str) {
        if let Some(r) = self.rooms.lock().unwrap_or_else(|e| e.into_inner()).get(doc) { let _ = r.tx.send(Event::Members); }
    }
}

/// Stripe meldet Zahlungen. Die Signatur (`Stripe-Signature: t=…,v1=…`, HMAC-SHA256 über `<t>.<Inhalt>`) wird geprüft.
/// Zuordnung: Beim Bezahlen über den Zahlungslink steht die Konto-Kennung in `client_reference_id`; spätere
/// Rechnungen und Kündigungen kommen mit der Stripe-Kundennummer.
async fn stripe_webhook(State(s): State<Shared>, h: HeaderMap, body: Bytes) -> Response {
    let Some(secret) = &s.cfg.stripe_webhook_secret else { return StatusCode::NOT_FOUND.into_response() };
    let Ok(text) = std::str::from_utf8(&body) else { return StatusCode::BAD_REQUEST.into_response() };
    let header = h.get("stripe-signature").and_then(|v| v.to_str().ok()).unwrap_or("");
    let t: i64 = header.split(',').find_map(|p| p.trim().strip_prefix("t=")).and_then(|v| v.parse().ok()).unwrap_or(0);
    let signed = format!("{t}.{text}");
    let valid = (auth::now() - t).abs() <= 300
        && header.split(',').filter_map(|p| p.trim().strip_prefix("v1=")).any(|sig| auth::check_text(secret.as_bytes(), &signed, sig));
    if !valid { return (StatusCode::BAD_REQUEST, "Signatur ungültig").into_response(); }
    let Ok(event) = serde_json::from_str::<serde_json::Value>(text) else { return StatusCode::BAD_REQUEST.into_response() };
    let obj = &event["data"]["object"];
    let quota = s.cfg.stripe_quota.unwrap_or(5_000_000_000);
    let str_of = |v: &serde_json::Value| v.as_str().map(String::from);
    match event["type"].as_str().unwrap_or("") {
        "checkout.session.completed" => {
            if let (Some(account), Some(customer)) = (str_of(&obj["client_reference_id"]), str_of(&obj["customer"])) {
                if matches!(s.store.account(&account), Ok(Some(_))) {
                    let _ = s.store.link_stripe_customer(&customer, &account);
                    // vorläufig, bis die Rechnung (`invoice.paid`) den genauen Zeitraum nennt
                    let until = store::now() + 7 * 86_400;
                    let keep = s.store.account(&account).ok().flatten().filter(|a| a.paid_now()).and_then(|a| a.paid_until);
                    let _ = s.store.set_plan(&account, "paid", Some(keep.map_or(until, |k| k.max(until))), quota);
                }
            }
        }
        "invoice.paid" => {
            let customer = str_of(&obj["customer"]).unwrap_or_default();
            if let Ok(Some(account)) = s.store.stripe_account(&customer) {
                let end = obj["lines"]["data"][0]["period"]["end"].as_i64().or_else(|| obj["period_end"].as_i64());
                if let Some(end) = end { let _ = s.store.set_plan(&account, "paid", Some(end + 3 * 86_400), quota); } // drei Tage Nachfrist
            }
        }
        "customer.subscription.deleted" => {
            let customer = str_of(&obj["customer"]).unwrap_or_default();
            if let Ok(Some(account)) = s.store.stripe_account(&customer) { let _ = s.store.set_plan(&account, "free", None, 0); }
        }
        _ => {}
    }
    Json(serde_json::json!({ "received": true })).into_response()
}

/// Abo und Speicher des angemeldeten Kontos.
async fn me(State(s): State<Shared>, h: HeaderMap) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    let Ok(Some(a)) = s.store.account(&id) else { return StatusCode::UNAUTHORIZED.into_response() };
    Json(serde_json::json!({
        "id": a.id, "plan": a.plan, "active": a.paid_now(), "paidUntil": a.paid_until, "quota": a.quota,
        "used": s.store.owned_bytes(&a.id).unwrap_or(0), "billing": s.cfg.billing, "manageUrl": s.cfg.manage_url,
        "planSource": s.store.plan_source(&a.id), "mail": s.cfg.mail_from.is_some(), "iap": s.cfg.apple_bundle.as_ref().map(|_| serde_json::json!({ "products": s.cfg.apple_products.iter().map(|(id, q)| serde_json::json!({ "id": id, "quota": q })).collect::<Vec<_>>(), "termsUrl": s.cfg.terms_url, "privacyUrl": s.cfg.privacy_url })), "email": s.store.email_of(&a.id).ok().and_then(|e| e.0), "emailVerified": s.store.email_of(&a.id).map(|e| e.1).unwrap_or(false), "recovery": s.store.email_of(&a.id).map(|e| e.2).unwrap_or(false),
        "checkoutUrl": s.cfg.checkout_url.as_ref().map(|u| format!("{u}{}client_reference_id={}", if u.contains('?') { "&" } else { "?" }, a.id)),
    })).into_response()
}

fn is_admin_key(s: &AppState, h: &HeaderMap) -> bool {
    let Some(key) = &s.cfg.admin_key else { return false };
    let given = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    given.len() == key.len() && given.bytes().zip(key.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Verwaltung (für Webshop, Zahlungsabwickler): alle Konten mit Abo und Verbrauch.
async fn admin_accounts(State(s): State<Shared>, h: HeaderMap) -> Response {
    if s.cfg.admin_key.is_none() { return StatusCode::NOT_FOUND.into_response(); }
    if !is_admin_key(&s, &h) { return StatusCode::UNAUTHORIZED.into_response(); }
    match s.store.accounts() {
        Ok(list) => Json(list.into_iter().map(|a| serde_json::json!({
            "id": a.id, "status": a.status, "plan": a.plan, "active": a.paid_now(), "paidUntil": a.paid_until, "quota": a.quota,
            "used": s.store.owned_bytes(&a.id).unwrap_or(0),
        })).collect::<Vec<_>>()).into_response(),
        Err(e) => fail(e),
    }
}

#[derive(serde::Deserialize)]
struct PlanBody { plan: String, #[serde(rename = "paidUntil")] paid_until: Option<i64>, quota: Option<i64> }

/// Abo eines Kontos setzen (`paid` mit Ablaufzeit und Speicher, oder `free`).
async fn admin_plan(State(s): State<Shared>, h: HeaderMap, Path(id): Path<String>, Json(b): Json<PlanBody>) -> Response {
    if s.cfg.admin_key.is_none() { return StatusCode::NOT_FOUND.into_response(); }
    if !is_admin_key(&s, &h) { return StatusCode::UNAUTHORIZED.into_response(); }
    if !matches!(b.plan.as_str(), "paid" | "free") { return (StatusCode::BAD_REQUEST, "plan: paid oder free").into_response(); }
    match s.store.account(&id) { Ok(Some(_)) => {} Ok(None) => return StatusCode::NOT_FOUND.into_response(), Err(e) => return fail(e) }
    let quota = if b.plan == "free" { 0 } else { b.quota.unwrap_or(5_000_000_000).max(0) };
    match s.store.set_plan(&id, &b.plan, if b.plan == "free" { None } else { b.paid_until }, quota) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

async fn list_docs(State(s): State<Shared>, h: HeaderMap) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    match s.store.all_docs() {
        Ok(all) => Json(all.into_iter().filter(|d| s.role(&d.id, &id).ok().flatten().is_some()).collect::<Vec<_>>()).into_response(),
        Err(e) => fail(e),
    }
}

async fn list_blobs(State(s): State<Shared>, h: HeaderMap, Path(doc): Path<String>) -> Response {
    if let Err(r) = doc_access(&s, &h, &doc) { return r; }
    match s.store.blob_keys(&doc) { Ok(k) => Json(k).into_response(), Err(e) => fail(e) }
}

async fn get_blob(State(s): State<Shared>, h: HeaderMap, Path((doc, key)): Path<(String, String)>) -> Response {
    if let Err(r) = doc_access(&s, &h, &doc) { return r; }
    if !valid_key(&key) { return StatusCode::BAD_REQUEST.into_response(); }
    match s.store.blob(&doc, &key) {
        Ok(Some(b)) => ([(header::CONTENT_TYPE, "application/octet-stream")], b).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => fail(e),
    }
}

async fn put_blob(State(s): State<Shared>, h: HeaderMap, Path((doc, key)): Path<(String, String)>, body: Bytes) -> Response {
    if let Err(r) = doc_access(&s, &h, &doc) { return r; }
    if !valid_key(&key) { return StatusCode::BAD_REQUEST.into_response(); }
    let w = s.writable(&doc);
    if !w.ok { return (StatusCode::PAYMENT_REQUIRED, w.reason).into_response(); }
    // Originale sind inhaltsadressiert: der Name muss zu den Bytes passen.
    if !key.ends_with(".thumb") && !s.store.is_enc(&doc) { // verschlüsselte Dateien prüft der Client nach dem Entschlüsseln
        let hex = auth::hex(&Sha256::digest(&body));
        if hex != key { return (StatusCode::BAD_REQUEST, "Hash passt nicht zum Inhalt").into_response(); }
    }
    match s.store.put_blob(&doc, &key, &body) { Ok(()) => StatusCode::NO_CONTENT.into_response(), Err(e) => fail(e) }
}

/// Mitglieder, Rolle des Aufrufers und (für Admins) offene Beitrittsanfragen.
async fn members(State(s): State<Shared>, h: HeaderMap, Path(doc): Path<String>) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !valid_doc(&doc) { return StatusCode::BAD_REQUEST.into_response(); }
    let role = match s.role(&doc, &id) { Ok(Some(r)) => r, Ok(None) => return StatusCode::FORBIDDEN.into_response(), Err(e) => return fail(e) };
    let entries = match s.entries(&doc) { Ok(e) => e, Err(e) => return fail(e) };
    let requests = if role == "admin" { s.store.requests(&doc).unwrap_or_default() } else { Vec::new() };
    let w = s.writable(&doc);
    Json(serde_json::json!({ "role": role, "entries": entries, "requests": requests, "enc": s.store.is_enc(&doc), "writable": { "ok": w.ok, "code": w.code, "reason": w.reason } })).into_response()
}

/// Neuer Eintrag im Admin-Protokoll (vom Aufrufer unterschrieben).
async fn post_admin(State(s): State<Shared>, h: HeaderMap, Path(doc): Path<String>, Json(entry): Json<adminlog::Entry>) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !valid_doc(&doc) { return StatusCode::BAD_REQUEST.into_response(); }
    if entry.actor != id { return (StatusCode::FORBIDDEN, "Der Eintrag muss vom angemeldeten Konto stammen").into_response(); }
    let state = match s.log_state(&doc) { Ok(st) => st, Err(e) => return fail(e) };
    let before = match &state {
        Some(st) => (**st).clone(),
        None => {
            // Anfang des Protokolls: nur der Ersteller; bei Dokumenten aus der Zeit davor nur dessen Admin
            let legacy = match s.store.legacy_members(&doc) { Ok(l) => l, Err(e) => return fail(e) };
            if !legacy.is_empty() && !legacy.iter().any(|(a, r)| a == &id && r == "admin") {
                return (StatusCode::FORBIDDEN, "Das Dokument gehört einem anderen Konto").into_response();
            }
            adminlog::State::default()
        }
    };
    let want_enc = h.get("x-grid-enc").is_some_and(|v| v == "1");
    if entry.kind == "genesis" && s.cfg.require_enc && !want_enc {
        return (StatusCode::BAD_REQUEST, "Dieser Server verlangt verschlüsselte Dokumente").into_response();
    }
    let next = match before.apply(&doc, &entry) { Ok(n) => n, Err(e) => return (StatusCode::BAD_REQUEST, e).into_response() };
    let json = match serde_json::to_string(&entry) { Ok(j) => j, Err(e) => return fail(e) };
    if s.store.append_admin(&doc, entry.seq, &json).is_err() {
        return (StatusCode::CONFLICT, "Das Protokoll hat sich inzwischen geändert").into_response();
    }
    s.members.lock().unwrap_or_else(|e| e.into_inner()).insert(doc.clone(), Arc::new(next));
    if entry.kind == "genesis" {
        let _ = s.store.set_owner(&doc, &entry.actor);
        if want_enc { let _ = s.store.set_enc(&doc); } // verschlüsselt: unveränderlich ab dem Anlegen
    }
    if entry.kind == "encrypt" && !s.store.is_enc(&doc) {
        // Umstellung eines bestehenden Dokuments: Klartext löschen; die Clients laden ihren Stand verschlüsselt neu hoch
        let _ = s.store.set_enc(&doc);
        let _ = s.store.wipe_data(&doc);
        if let Some(r) = s.rooms.lock().unwrap_or_else(|e| e.into_inner()).remove(&doc) { let _ = r.tx.send(Event::Reset); }
    }
    if entry.kind == "set" { let _ = s.store.remove_request(&doc, &entry.subject); }
    s.notify(&doc);
    StatusCode::NO_CONTENT.into_response()
}

#[derive(serde::Deserialize)]
struct ImportBody { entries: Vec<adminlog::Entry> }

/// Dokument auf diesen Server umziehen: das ganze Admin-Protokoll übernehmen (Mitglieder und Admins bleiben erhalten).
/// Nur für ein Dokument, das hier noch niemand angelegt hat, und nur durch einen Admin des Protokolls.
async fn import_log(State(s): State<Shared>, h: HeaderMap, Path(doc): Path<String>, Json(b): Json<ImportBody>) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !valid_doc(&doc) { return StatusCode::BAD_REQUEST.into_response(); }
    match s.unclaimed(&doc) { Ok(true) => {} Ok(false) => return (StatusCode::CONFLICT, "Das Dokument gibt es hier schon").into_response(), Err(e) => return fail(e) }
    if b.entries.is_empty() || b.entries.len() > 10_000 { return StatusCode::BAD_REQUEST.into_response(); }
    let state = match adminlog::replay(&doc, &b.entries) { Ok(st) => st, Err(e) => return (StatusCode::BAD_REQUEST, e).into_response() };
    if state.role(&id) != Some("admin") { return (StatusCode::FORBIDDEN, "Nur ein Admin des Dokuments darf es umziehen").into_response(); }
    let state_enc = state.enc;
    if s.cfg.require_enc && !state_enc { return (StatusCode::BAD_REQUEST, "Dieser Server verlangt verschlüsselte Dokumente").into_response(); }
    let rows: Result<Vec<(u64, String)>, _> = b.entries.iter().map(|e| serde_json::to_string(e).map(|j| (e.seq, j))).collect();
    let Ok(rows) = rows else { return StatusCode::BAD_REQUEST.into_response() };
    if s.store.append_admin_all(&doc, &rows).is_err() { return (StatusCode::CONFLICT, "Das Dokument gibt es hier schon").into_response(); }
    s.members.lock().unwrap_or_else(|e| e.into_inner()).insert(doc.clone(), Arc::new(state));
    let _ = s.store.set_owner(&doc, &b.entries[0].actor);
    if state_enc { let _ = s.store.set_enc(&doc); } // der signierte Eintrag `encrypt` bestimmt auch auf dem neuen Server
    s.notify(&doc);
    StatusCode::NO_CONTENT.into_response()
}

#[derive(serde::Deserialize)]
struct JoinBody { name: Option<String> }

/// „Anklopfen“: ein Konto bittet um Aufnahme in das Dokument; ein Admin entscheidet.
async fn join_doc(State(s): State<Shared>, h: HeaderMap, Path(doc): Path<String>, Json(body): Json<JoinBody>) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !valid_doc(&doc) { return StatusCode::BAD_REQUEST.into_response(); }
    match s.role(&doc, &id) { Ok(Some(_)) => return Json(serde_json::json!({ "status": "member" })).into_response(), Ok(None) => {} Err(e) => return fail(e) }
    if !s.store.doc_exists(&doc).unwrap_or(false) { return StatusCode::NOT_FOUND.into_response(); }
    if s.store.requests(&doc).map(|r| r.len()).unwrap_or(0) >= 100 { return StatusCode::TOO_MANY_REQUESTS.into_response(); }
    let Ok(Some(acct)) = s.store.account(&id) else { return StatusCode::UNAUTHORIZED.into_response() };
    let name: String = body.name.unwrap_or_default().chars().filter(|c| !c.is_control()).take(60).collect();
    if s.store.add_request(&doc, &id, &acct.pubkey, name.trim()).is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    s.notify(&doc);
    (StatusCode::ACCEPTED, Json(serde_json::json!({ "status": "requested" }))).into_response()
}

/// Ein Admin lehnt eine Beitrittsanfrage ab.
async fn reject_join(State(s): State<Shared>, h: HeaderMap, Path((doc, account)): Path<(String, String)>) -> Response {
    let Some(id) = current(&s, &h) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !valid_doc(&doc) || !valid_doc(&account) { return StatusCode::BAD_REQUEST.into_response(); }
    match s.role(&doc, &id) { Ok(Some(r)) if r == "admin" => {} Ok(_) => return StatusCode::FORBIDDEN.into_response(), Err(e) => return fail(e) }
    let _ = s.store.remove_request(&doc, &account);
    s.notify(&doc);
    StatusCode::NO_CONTENT.into_response()
}

// ---------- Schlüsselkisten (verschlüsselte Dokumente) ----------

/// Kisten für den Aufrufer (alle Epochen); für Admins außerdem, welche Mitglieder für die neueste Epoche noch keine haben.
async fn get_keys(State(s): State<Shared>, h: HeaderMap, Path(doc): Path<String>) -> Response {
    let id = match doc_access(&s, &h, &doc) { Ok(id) => id, Err(r) => return r };
    let boxes = match s.store.keys_for(&doc, &id) { Ok(b) => b, Err(e) => return fail(e) };
    let epoch = s.store.max_epoch(&doc);
    let mut missing: Vec<String> = Vec::new();
    // `stale`: Konten mit einer Kiste für die neueste Epoche, die nicht mehr Mitglied sind (Admin erneuert dann den Schlüssel)
    let mut stale: Vec<String> = Vec::new();
    if epoch > 0 && matches!(s.role(&doc, &id), Ok(Some(ref r)) if r == "admin") {
        if let (Ok(Some(st)), Ok(have)) = (s.log_state(&doc), s.store.key_holders(&doc, epoch)) {
            missing = st.members.keys().filter(|m| !have.contains(m)).cloned().collect();
            missing.sort();
            stale = have.iter().filter(|a| !st.members.contains_key(*a)).cloned().collect();
            stale.sort();
        }
    }
    Json(serde_json::json!({
        "enc": s.store.is_enc(&doc), "epoch": epoch, "missing": missing, "stale": stale,
        "boxes": boxes.into_iter().map(|(e, from, b)| serde_json::json!({ "epoch": e, "from": from, "box": b })).collect::<Vec<_>>(),
    })).into_response()
}

#[derive(serde::Deserialize)]
struct KeyBox { epoch: i64, account: String, #[serde(rename = "box")] boxed: String }

/// Ein Admin legt Schlüsselkisten für Mitglieder ab (auch für eine neue Epoche).
async fn put_keys(State(s): State<Shared>, h: HeaderMap, Path(doc): Path<String>, Json(list): Json<Vec<KeyBox>>) -> Response {
    let id = match doc_access(&s, &h, &doc) { Ok(id) => id, Err(r) => return r };
    match s.role(&doc, &id) { Ok(Some(r)) if r == "admin" => {} Ok(_) => return StatusCode::FORBIDDEN.into_response(), Err(e) => return fail(e) }
    if !s.store.is_enc(&doc) { return (StatusCode::BAD_REQUEST, "Das Dokument ist nicht verschlüsselt").into_response(); }
    if list.len() > 2_000 { return StatusCode::BAD_REQUEST.into_response(); }
    let top = s.store.max_epoch(&doc);
    for k in &list {
        if k.epoch < 1 || k.epoch > top + 1 || k.boxed.len() > 1_024 || !valid_doc(&k.account) { return (StatusCode::BAD_REQUEST, "Kiste ungültig").into_response(); }
        if !matches!(s.access(&doc, &k.account), Ok(true)) { return (StatusCode::BAD_REQUEST, "Kein Mitglied").into_response(); }
    }
    for k in &list { if let Err(e) = s.store.put_key(&doc, k.epoch, &k.account, &id, &k.boxed) { return fail(e); } }
    s.notify(&doc);
    StatusCode::NO_CONTENT.into_response()
}

// ---------- WebSocket ----------

fn room(state: &Shared, id: &str) -> Result<Arc<Room>, String> {
    let mut rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = rooms.get(id) { return Ok(r.clone()); }
    let doc = Doc::new();
    if !state.store.is_enc(id) { // verschlüsselte Dokumente hält der Server nur als Protokoll, nicht als Yjs-Zustand
        let mut txn = doc.transact_mut();
        for u in state.store.log(id).map_err(|e| e.to_string())? {
            txn.apply_update(Update::decode_v1(&u).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
    }
    let (tx, _) = broadcast::channel(256);
    let r = Arc::new(Room { doc: Mutex::new(doc), tx });
    rooms.insert(id.to_string(), r.clone());
    Ok(r)
}

async fn ws(State(s): State<Shared>, Path(doc): Path<String>, up: WebSocketUpgrade) -> Response {
    if !valid_doc(&doc) { return StatusCode::BAD_REQUEST.into_response(); }
    up.max_message_size(MAX_WS_MESSAGE).on_upgrade(move |socket| session(s, doc, socket))
}

fn frame(kind: u8, body: &[u8]) -> Message {
    let mut v = Vec::with_capacity(body.len() + 1);
    v.push(kind);
    v.extend_from_slice(body);
    Message::Binary(v.into())
}

/// `code`: „expired“ (neu anmelden hilft), „forbidden“ (kein Zugriff) oder „error“.
async fn deny(socket: &mut WebSocket, code: &str, reason: &str) {
    let _ = socket.send(Message::Text(serde_json::json!({ "t": "denied", "code": code, "reason": reason }).to_string().into())).await;
    let _ = socket.send(Message::Close(None)).await;
}

async fn session(state: Shared, id: String, mut socket: WebSocket) {
    // 1. Anmeldung
    #[derive(serde::Deserialize)]
    struct Hello { t: String, token: String, name: Option<String>, since: Option<i64> }
    let hello = match socket.recv().await {
        Some(Ok(Message::Text(t))) => serde_json::from_str::<Hello>(&t).ok().filter(|h| h.t == "hello"),
        _ => None,
    };
    let Some(hello) = hello else { return deny(&mut socket, "expired", "Anmeldung erwartet").await };
    let Some(account) = auth::token_account(&state.secret, &hello.token)
        .and_then(|id| state.store.account(&id).ok().flatten()).filter(|a| a.approved()) else {
        return deny(&mut socket, "expired", "Anmeldung abgelaufen").await;
    };
    match state.access(&id, &account.id) {
        Ok(true) => {}
        Ok(false) => {
            // Noch niemand hat das Dokument angelegt: der Client legt es mit seinem Admin-Protokoll an und verbindet erneut
            if state.unclaimed(&id).unwrap_or(false) { return deny(&mut socket, "unclaimed", "Dokument ist noch nicht angelegt").await; }
            // Wer angeklopft hat, wartet auf die Entscheidung eines Admins
            if state.store.has_request(&id, &account.id).unwrap_or(false) {
                return deny(&mut socket, "requested", "Wartet auf Zustimmung eines Admins").await;
            }
            return deny(&mut socket, "forbidden", "Kein Zugriff auf dieses Dokument").await;
        }
        Err(_) => return deny(&mut socket, "error", "Speicherfehler").await,
    }
    let room = match room(&state, &id) {
        Ok(r) => r,
        Err(e) => return deny(&mut socket, "error", &format!("Dokument nicht lesbar: {e}")).await,
    };
    if state.store.touch_doc(&id, hello.name.as_deref()).is_err() { return deny(&mut socket, "error", "Speicherfehler").await; }
    if socket.send(Message::Text("{\"t\":\"ok\"}".into())).await.is_err() { return; }
    let readonly = |w: &Writable| Message::Text(serde_json::json!({ "t": "readonly", "code": w.code, "reason": w.reason }).to_string().into());
    {
        let w = state.writable(&id);
        if !w.ok && socket.send(readonly(&w)).await.is_err() { return; }
    }

    let me = {
        let mut n = state.next_client.lock().unwrap_or_else(|e| e.into_inner());
        *n += 1;
        *n
    };
    let mut rx = room.tx.subscribe();
    if state.store.is_enc(&id) { return session_enc(state, id, account.id, socket, room, rx, hello.since.unwrap_or(0)).await; }
    let mut was_readonly = false;

    // 2. Eigenen Zustandsvektor anbieten
    let sv = room.doc.lock().unwrap_or_else(|e| e.into_inner()).transact().state_vector().encode_v1();
    if socket.send(frame(MSG_STEP1, &sv)).await.is_err() { return; }

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                let Message::Binary(data) = msg else {
                    if matches!(msg, Message::Close(_)) { break }
                    continue
                };
                let Some((&kind, body)) = data.split_first() else { continue };
                match kind {
                    MSG_STEP1 => {
                        let Ok(sv) = StateVector::decode_v1(body) else { continue };
                        let (diff, mine) = {
                            let doc = room.doc.lock().unwrap_or_else(|e| e.into_inner());
                            let txn = doc.transact();
                            (txn.encode_diff_v1(&sv), txn.state_vector().encode_v1())
                        };
                        if socket.send(frame(MSG_UPDATE, &diff)).await.is_err() { break }
                        // und umgekehrt: der Client schickt, was dem Server fehlt (z. B. nach einer Zeit ohne Schreibrecht)
                        if socket.send(frame(MSG_STEP1, &mine)).await.is_err() { break }
                        // Stand der Schreibberechtigung (so erfährt der Client auch, wenn ein Abo inzwischen aktiv ist)
                        let w = state.writable(&id);
                        let m = if w.ok { Message::Text("{\"t\":\"writable\"}".into()) } else { readonly(&w) };
                        if socket.send(m).await.is_err() { break }
                    }
                    MSG_UPDATE => {
                        if body.len() <= 2 { continue } // leere Differenz
                        if !state.access(&id, &account.id).unwrap_or(false) { break } // inzwischen entfernt
                        let w = state.writable(&id);
                        if !w.ok { // kein Abo oder Speicher voll: nicht übernehmen, Absender erfährt den Grund
                            was_readonly = true;
                            if socket.send(readonly(&w)).await.is_err() { break }
                            continue
                        }
                        if was_readonly { // zwischendurch Abgelehntes fehlt: Zustand neu abgleichen
                            was_readonly = false;
                            let sv = room.doc.lock().unwrap_or_else(|e| e.into_inner()).transact().state_vector().encode_v1();
                            if socket.send(frame(MSG_STEP1, &sv)).await.is_err() { break }
                            if socket.send(Message::Text("{\"t\":\"writable\"}".into())).await.is_err() { break }
                        }
                        let Ok(update) = Update::decode_v1(body) else { continue };
                        let full = {
                            let doc = room.doc.lock().unwrap_or_else(|e| e.into_inner());
                            if doc.transact_mut().apply_update(update).is_err() { continue }
                            match state.store.append(&id, body) {
                                Ok(n) if n >= COMPACT_AT => Some(doc.transact().encode_state_as_update_v1(&StateVector::default())),
                                Ok(_) => None,
                                Err(_) => break,
                            }
                        };
                        if let Some(full) = full { let _ = state.store.compact(&id, &full); }
                        let _ = room.tx.send(Event::Update(me, Arc::new(body.to_vec())));
                    }
                    _ => {}
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Ok(Event::Update(from, body)) if from != me => {
                        if socket.send(frame(MSG_UPDATE, &body)).await.is_err() { break }
                    }
                    Ok(Event::Update(..)) | Ok(Event::Enc(..)) => {}
                    Ok(Event::Reset) => break,
                    Ok(Event::Members) => {
                        // Wer nicht mehr Mitglied ist, wird getrennt; alle anderen erfahren von der Änderung
                        if !state.access(&id, &account.id).unwrap_or(false) { break }
                        if socket.send(Message::Text("{\"t\":\"members\"}".into())).await.is_err() { break }
                    }
                    // Verteiler übergelaufen: Differenz neu anbieten, damit nichts fehlt
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let sv = room.doc.lock().unwrap_or_else(|e| e.into_inner()).transact().state_vector().encode_v1();
                        if socket.send(frame(MSG_STEP1, &sv)).await.is_err() { break }
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

// ---------- WebSocket, verschlüsseltes Dokument (docs/E2E.md) ----------

fn enc_frame(seq: i64, entry: &[u8]) -> Message {
    let mut v = Vec::with_capacity(entry.len() + 9);
    v.push(MSG_ENC_ENTRY);
    v.extend_from_slice(&seq.to_be_bytes());
    v.extend_from_slice(entry);
    Message::Binary(v.into())
}

/// Der Server kennt hier nur nummerierte, undurchsichtige Einträge: speichern, verteilen, ab einer Nummer nachliefern.
async fn session_enc(state: Shared, id: String, account: String, mut socket: WebSocket, room: Arc<Room>, mut rx: broadcast::Receiver<Event>, since: i64) {
    let status = |w: &Writable| Message::Text(if w.ok { "{\"t\":\"writable\"}".to_string() } else { serde_json::json!({ "t": "readonly", "code": w.code, "reason": w.reason }).to_string() }.into());
    // Nachliefern, was der Client noch nicht kennt
    let (backlog, count) = match (state.store.log_since(&id, since.max(0)), state.store.log(&id)) {
        (Ok(b), Ok(all)) => (b, all.len()),
        _ => return,
    };
    let last = backlog.last().map(|(s, _)| *s).unwrap_or(since.max(0));
    for (seq, data) in &backlog { if socket.send(enc_frame(*seq, data)).await.is_err() { return; } }
    let synced = serde_json::json!({ "t": "synced", "last": last, "count": count, "epoch": state.store.max_epoch(&id) });
    if socket.send(Message::Text(synced.to_string().into())).await.is_err() { return; }
    let w = state.writable(&id);
    if !w.ok && socket.send(status(&w)).await.is_err() { return; }
    let mut was_readonly = false;
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                let Message::Binary(data) = msg else {
                    if matches!(msg, Message::Close(_)) { break }
                    continue
                };
                let Some((&kind, body)) = data.split_first() else { continue };
                if kind != MSG_ENC_PUT && kind != MSG_ENC_SNAPSHOT { continue }
                if !state.access(&id, &account).unwrap_or(false) { break }
                let w = state.writable(&id);
                if !w.ok {
                    was_readonly = true;
                    if socket.send(status(&w)).await.is_err() { break }
                    continue
                }
                if was_readonly { was_readonly = false; if socket.send(status(&w)).await.is_err() { break } }
                if kind == MSG_ENC_PUT {
                    if body.len() < 29 { continue } // Epoche + Nonce + Tag
                    let Ok((seq, n)) = state.store.append_enc(&id, body) else { break };
                    let _ = room.tx.send(Event::Enc(seq, Arc::new(body.to_vec())));
                    if n >= COMPACT_AT {
                        let m = serde_json::json!({ "t": "compact", "upto": seq, "count": n });
                        if socket.send(Message::Text(m.to_string().into())).await.is_err() { break }
                    }
                } else {
                    if body.len() < 8 + 29 { continue }
                    let upto = i64::from_be_bytes(body[..8].try_into().unwrap_or([0; 8]));
                    let _ = state.store.compact_enc(&id, upto, &body[8..]);
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Ok(Event::Enc(seq, body)) => { if socket.send(enc_frame(seq, &body)).await.is_err() { break } }
                    Ok(Event::Members) => {
                        if !state.access(&id, &account).unwrap_or(false) { break }
                        if socket.send(Message::Text("{\"t\":\"members\"}".into())).await.is_err() { break }
                    }
                    Ok(Event::Update(..)) | Ok(Event::Reset) => {}
                    // Verteiler übergelaufen: der Client holt sich per Neuverbinden, was fehlt
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(_) => break,
                }
            }
        }
    }
}
