//! Grid-Sync-Server: Yjs-Dokumente über WebSocket abgleichen, Protokoll und Dateien speichern.
//! Protokoll und Hintergrund: docs/SYNC.md

mod store;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use store::{COMPACT_AT, Store};
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
    tx: broadcast::Sender<(u64, Arc<Vec<u8>>)>,
}

pub struct AppState {
    store: Store,
    token: String,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    next_client: Mutex<u64>,
}

pub type Shared = Arc<AppState>;

pub fn app(data: &std::path::Path, token: &str) -> rusqlite::Result<Router> {
    let state = Arc::new(AppState {
        store: Store::open(data)?,
        token: token.to_string(),
        rooms: Mutex::new(HashMap::new()),
        next_client: Mutex::new(0),
    });
    Ok(Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/docs", get(list_docs))
        .route("/blobs/{doc}", get(list_blobs))
        .route("/blob/{doc}/{key}", get(get_blob).put(put_blob))
        .route("/ws/{doc}", get(ws))
        .layer(DefaultBodyLimit::max(MAX_BLOB))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .with_state(state))
}

// ---------- Hilfen ----------

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| same(t, &state.token))
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

async fn list_docs(State(s): State<Shared>, h: HeaderMap) -> Response {
    if !authorized(&s, &h) { return StatusCode::UNAUTHORIZED.into_response(); }
    match s.store.docs() { Ok(d) => Json(d).into_response(), Err(e) => fail(e) }
}

async fn list_blobs(State(s): State<Shared>, h: HeaderMap, Path(doc): Path<String>) -> Response {
    if !authorized(&s, &h) { return StatusCode::UNAUTHORIZED.into_response(); }
    if !valid_doc(&doc) { return StatusCode::BAD_REQUEST.into_response(); }
    match s.store.blob_keys(&doc) { Ok(k) => Json(k).into_response(), Err(e) => fail(e) }
}

async fn get_blob(State(s): State<Shared>, h: HeaderMap, Path((doc, key)): Path<(String, String)>) -> Response {
    if !authorized(&s, &h) { return StatusCode::UNAUTHORIZED.into_response(); }
    if !valid_doc(&doc) || !valid_key(&key) { return StatusCode::BAD_REQUEST.into_response(); }
    match s.store.blob(&doc, &key) {
        Ok(Some(b)) => ([(header::CONTENT_TYPE, "application/octet-stream")], b).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => fail(e),
    }
}

async fn put_blob(State(s): State<Shared>, h: HeaderMap, Path((doc, key)): Path<(String, String)>, body: Bytes) -> Response {
    if !authorized(&s, &h) { return StatusCode::UNAUTHORIZED.into_response(); }
    if !valid_doc(&doc) || !valid_key(&key) { return StatusCode::BAD_REQUEST.into_response(); }
    // Originale sind inhaltsadressiert: der Name muss zu den Bytes passen.
    if !key.ends_with(".thumb") {
        let hex: String = Sha256::digest(&body).iter().map(|b| format!("{b:02x}")).collect();
        if hex != key { return (StatusCode::BAD_REQUEST, "Hash passt nicht zum Inhalt").into_response(); }
    }
    match s.store.put_blob(&doc, &key, &body) { Ok(()) => StatusCode::NO_CONTENT.into_response(), Err(e) => fail(e) }
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

async fn deny(socket: &mut WebSocket, reason: &str) {
    let _ = socket.send(Message::Text(format!("{{\"t\":\"denied\",\"reason\":{}}}", serde_json::json!(reason)).into())).await;
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
    let Some(hello) = hello else { return deny(&mut socket, "Anmeldung erwartet").await };
    if !same(&hello.token, &state.token) { return deny(&mut socket, "Zugangsschlüssel falsch").await; }
    let room = match room(&state, &id) {
        Ok(r) => r,
        Err(e) => return deny(&mut socket, &format!("Dokument nicht lesbar: {e}")).await,
    };
    if state.store.touch_doc(&id, hello.name.as_deref()).is_err() { return deny(&mut socket, "Speicherfehler").await; }
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
                        let _ = room.tx.send((me, Arc::new(body.to_vec())));
                    }
                    _ => {}
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Ok((from, body)) if from != me => {
                        if socket.send(frame(MSG_UPDATE, &body)).await.is_err() { break }
                    }
                    Ok(_) => {}
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
