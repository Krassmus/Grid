//! Grid-Sync-Server: Yjs-Dokumente über WebSocket abgleichen, Protokoll und Dateien speichern.
//! Protokoll und Hintergrund: docs/SYNC.md

mod adminlog;
mod auth;
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
use store::COMPACT_AT;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use yrs::{
    Doc, ReadTxn, StateVector, Transact, Update,
    updates::{decoder::Decode, encoder::Encode},
};

const MSG_STEP1: u8 = 0;
const MSG_UPDATE: u8 = 1;
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
    /// Mitglieder oder Beitrittsanfragen haben sich geändert: Berechtigung neu prüfen, Clients benachrichtigen
    Members,
}

pub struct AppState {
    store: Store,
    secret: Vec<u8>,
    /// Neue Konten werden gleich freigegeben (z. B. im eigenen Netz); sonst warten sie auf `accounts approve`.
    open_registration: bool,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    /// Abgespielte Admin-Protokolle (fällt bei jedem neuen Eintrag weg)
    members: Mutex<HashMap<String, Arc<adminlog::State>>>,
    next_client: Mutex<u64>,
}

pub type Shared = Arc<AppState>;

pub fn app(data: &std::path::Path, open_registration: bool) -> rusqlite::Result<Router> {
    let store = Store::open(data)?;
    let state = Arc::new(AppState {
        secret: store.secret()?,
        store,
        open_registration,
        rooms: Mutex::new(HashMap::new()),
        members: Mutex::new(HashMap::new()),
        next_client: Mutex::new(0),
    });
    Ok(Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/challenge", get(challenge))
        .route("/login", post(login))
        .route("/docs", get(list_docs))
        .route("/docs/{doc}/members", get(members))
        .route("/docs/{doc}/admin", post(post_admin))
        .route("/docs/{doc}/join", post(join_doc))
        .route("/docs/{doc}/join/{account}", axum::routing::delete(reject_join))
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

async fn challenge(State(s): State<Shared>) -> Response {
    Json(serde_json::json!({ "nonce": auth::new_nonce(&s.secret) })).into_response()
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
            if s.store.add_account(&l.id, &pubkey, s.open_registration).is_err() { return reply(StatusCode::INTERNAL_SERVER_ERROR, "error", "Speicherfehler"); }
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

    /// Zugriff auf Inhalte. Ohne Protokoll gilt das ältere Verfahren (erstes Konto beansprucht das Dokument).
    fn access(&self, doc: &str, account: &str) -> Result<bool, String> {
        if let Some(s) = self.log_state(doc)? { return Ok(s.members.contains_key(account)); }
        self.store.access(doc, account).map_err(|e| e.to_string())
    }

    fn notify(&self, doc: &str) {
        if let Some(r) = self.rooms.lock().unwrap_or_else(|e| e.into_inner()).get(doc) { let _ = r.tx.send(Event::Members); }
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
    // Originale sind inhaltsadressiert: der Name muss zu den Bytes passen.
    if !key.ends_with(".thumb") {
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
    Json(serde_json::json!({ "role": role, "entries": entries, "requests": requests })).into_response()
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
    let next = match before.apply(&doc, &entry) { Ok(n) => n, Err(e) => return (StatusCode::BAD_REQUEST, e).into_response() };
    let json = match serde_json::to_string(&entry) { Ok(j) => j, Err(e) => return fail(e) };
    if s.store.append_admin(&doc, entry.seq, &json).is_err() {
        return (StatusCode::CONFLICT, "Das Protokoll hat sich inzwischen geändert").into_response();
    }
    s.members.lock().unwrap_or_else(|e| e.into_inner()).insert(doc.clone(), Arc::new(next));
    if entry.kind == "set" { let _ = s.store.remove_request(&doc, &entry.subject); }
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

// ---------- WebSocket ----------

fn room(state: &Shared, id: &str) -> Result<Arc<Room>, String> {
    let mut rooms = state.rooms.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = rooms.get(id) { return Ok(r.clone()); }
    let doc = Doc::new();
    {
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
    struct Hello { t: String, token: String, name: Option<String> }
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

    let me = {
        let mut n = state.next_client.lock().unwrap_or_else(|e| e.into_inner());
        *n += 1;
        *n
    };
    let mut rx = room.tx.subscribe();

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
                        let diff = room.doc.lock().unwrap_or_else(|e| e.into_inner()).transact().encode_diff_v1(&sv);
                        if socket.send(frame(MSG_UPDATE, &diff)).await.is_err() { break }
                    }
                    MSG_UPDATE => {
                        if body.len() <= 2 { continue } // leere Differenz
                        if !state.access(&id, &account.id).unwrap_or(false) { break } // inzwischen entfernt
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
                    Ok(Event::Update(..)) => {}
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
