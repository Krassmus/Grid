use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update, updates::{decoder::Decode, encoder::Encode}};

const DOC: &str = "11111111-2222-3333-4444-555555555555";

fn tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("grid-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn serve(dir: &std::path::Path, open: bool) -> String {
    let app = grid_server::app(&dir.join("t.db"), open).unwrap();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("127.0.0.1:{}", addr.port())
}

/// Ein Konto: Schlüssel aus einem festen Startwert, Kennung daraus abgeleitet.
struct Acct { id: String, key: SigningKey }
fn acct(n: u8) -> Acct { Acct { id: format!("aaaaaaaa-0000-0000-0000-0000000000{n:02}"), key: SigningKey::from_bytes(&[n; 32]) } }
fn pub_hex(a: &Acct) -> String { a.key.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect() }

/// Minimaler HTTP-Client. Liefert (Statuszeile, Body).
async fn http(method: &str, addr: &str, path: &str, token: Option<&str>, body: &[u8]) -> (String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    s.write_all(req.as_bytes()).await.unwrap();
    s.write_all(body).await.unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.unwrap();
    let text = String::from_utf8_lossy(&out).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (head.lines().next().unwrap_or("").to_string(), body.to_string())
}

/// Meldet das Konto an. Liefert (HTTP-Status, Antwort als JSON).
async fn login_with(addr: &str, a: &Acct, sign_id: &str) -> (u16, serde_json::Value) {
    let (_, body) = http("GET", addr, "/challenge", None, b"").await;
    let nonce = serde_json::from_str::<serde_json::Value>(&body).unwrap()["nonce"].as_str().unwrap().to_string();
    let sig: String = a.key.sign(format!("grid-login-v1\n{sign_id}\n{nonce}").as_bytes()).to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    let payload = serde_json::json!({ "id": a.id, "pub": pub_hex(a), "nonce": nonce, "sig": sig }).to_string();
    let (status, body) = http("POST", addr, "/login", None, payload.as_bytes()).await;
    let code = status.split(' ').nth(1).unwrap().parse().unwrap();
    (code, serde_json::from_str(&body).unwrap_or(serde_json::Value::Null))
}

async fn token(addr: &str, a: &Acct) -> String {
    let (code, v) = login_with(addr, a, &a.id).await;
    assert_eq!(code, 200, "{v}");
    v["token"].as_str().unwrap().to_string()
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn join(addr: &str, token: &str, doc: &Doc) -> Result<Ws, String> {
    let (mut ws, _) = connect_async(format!("ws://{addr}/ws/{DOC}")).await.unwrap();
    ws.send(Message::Text(format!("{{\"t\":\"hello\",\"token\":\"{token}\",\"name\":\"Test\"}}").into())).await.unwrap();
    match ws.next().await {
        Some(Ok(Message::Text(t))) if t.contains("\"ok\"") => {
            ws.send(frame(0, &doc.transact().state_vector().encode_v1())).await.unwrap(); // eigener Zustandsvektor
            Ok(ws)
        }
        other => Err(format!("{other:?}")),
    }
}

fn frame(kind: u8, body: &[u8]) -> Message {
    let mut v = vec![kind];
    v.extend_from_slice(body);
    Message::Binary(v.into())
}

/// Liest, bis die Bedingung erfüllt ist oder eine Weile nichts mehr kommt. Antwortet auf Schritt 1.
async fn pump(ws: &mut Ws, doc: &Doc, until: impl Fn(&Doc) -> bool) {
    let mut quiet = 0;
    while quiet < 4 {
        if until(doc) { return; }
        let Ok(Some(Ok(Message::Binary(b)))) = tokio::time::timeout(std::time::Duration::from_millis(300), ws.next()).await else { quiet += 1; continue };
        quiet = 0;
        match b[0] {
            0 => {
                let diff = doc.transact().encode_diff_v1(&StateVector::decode_v1(&b[1..]).unwrap());
                ws.send(frame(1, &diff)).await.unwrap();
            }
            _ => doc.transact_mut().apply_update(Update::decode_v1(&b[1..]).unwrap()).unwrap(),
        }
    }
}

#[tokio::test]
async fn login_needs_valid_signature_and_approval() {
    let dir = tmp("login");
    let addr = serve(&dir, false).await;
    let (a, b) = (acct(1), acct(2));

    // Signatur über fremde Kennung: abgelehnt
    assert_eq!(login_with(&addr, &a, &b.id).await.0, 401);
    // Unbekanntes Konto: wartet auf Freigabe
    let (code, v) = login_with(&addr, &a, &a.id).await;
    assert_eq!((code, v["status"].as_str()), (403, Some("pending")));
    // Ohne Sitzungsschlüssel kein Zugriff
    assert_eq!(http("GET", &addr, "/docs", None, b"").await.0.split(' ').nth(1), Some("401"));
    // Freigabe durch den Betreiber
    let store = grid_server::Store::open(&dir.join("t.db")).unwrap();
    assert_eq!(store.find_accounts(&a.id[..8]).unwrap().len(), 1);
    store.set_status(&a.id, "approved").unwrap();
    let t = token(&addr, &a).await;
    assert_eq!(http("GET", &addr, "/docs", Some(&t), b"").await.0.split(' ').nth(1), Some("200"));
    // Gleiche Kennung mit anderem Schlüssel: abgelehnt
    let fake = Acct { id: a.id.clone(), key: SigningKey::from_bytes(&[9; 32]) };
    assert_eq!(login_with(&addr, &fake, &a.id).await.0, 403);
    // Ein verfälschter Sitzungsschlüssel gilt nicht
    let bad = format!("{}x", t);
    assert_eq!(http("GET", &addr, "/docs", Some(&bad), b"").await.0.split(' ').nth(1), Some("401"));
}

#[tokio::test]
async fn two_clients_merge_and_late_joiner_gets_state() {
    let dir = tmp("merge");
    let addr = serve(&dir, true).await;
    let acc = acct(1);
    let tok = token(&addr, &acc).await;

    let (a, b) = (Doc::new(), Doc::new());
    let (ta, tb) = (a.get_or_insert_text("t"), b.get_or_insert_text("t"));
    let mut wa = join(&addr, &tok, &a).await.unwrap();
    let mut wb = join(&addr, &tok, &b).await.unwrap();
    pump(&mut wa, &a, |_| false).await; // Austausch der Zustandsvektoren

    let sv = a.transact().state_vector();
    ta.insert(&mut a.transact_mut(), 0, "Hallo");
    wa.send(frame(1, &a.transact().encode_diff_v1(&sv))).await.unwrap();
    pump(&mut wb, &b, |d| tb.get_string(&d.transact()) == "Hallo").await;
    assert_eq!(tb.get_string(&b.transact()), "Hallo");

    let sv = b.transact().state_vector();
    tb.insert(&mut b.transact_mut(), 5, " Welt");
    wb.send(frame(1, &b.transact().encode_diff_v1(&sv))).await.unwrap();
    pump(&mut wa, &a, |d| ta.get_string(&d.transact()) == "Hallo Welt").await;
    assert_eq!(ta.get_string(&a.transact()), "Hallo Welt");

    drop((wa, wb));
    let c = Doc::new();
    let tc = c.get_or_insert_text("t");
    let mut wc = join(&addr, &tok, &c).await.unwrap();
    pump(&mut wc, &c, |d| tc.get_string(&d.transact()) == "Hallo Welt").await;
    assert_eq!(tc.get_string(&c.transact()), "Hallo Welt");
}

#[tokio::test]
async fn documents_belong_to_their_first_account() {
    let dir = tmp("owner");
    let addr = serve(&dir, true).await;
    let (a, b) = (acct(1), acct(2));
    let (ta, tb) = (token(&addr, &a).await, token(&addr, &b).await);

    let doc = Doc::new();
    join(&addr, &ta, &doc).await.unwrap(); // A legt das Dokument an
    // B darf weder verbinden noch Dateien lesen noch es in der Liste sehen
    assert!(join(&addr, &tb, &Doc::new()).await.unwrap_err().contains("forbidden"));
    let key = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert_eq!(http("GET", &addr, &format!("/blobs/{DOC}"), Some(&tb), b"").await.0.split(' ').nth(1), Some("403"));
    assert_eq!(http("PUT", &addr, &format!("/blob/{DOC}/{key}"), Some(&tb), b"hello").await.0.split(' ').nth(1), Some("403"));
    assert_eq!(http("GET", &addr, "/docs", Some(&tb), b"").await.1.trim(), "[]");
    assert!(http("GET", &addr, "/docs", Some(&ta), b"").await.1.contains(DOC));
}

#[tokio::test]
async fn state_survives_restart_and_blobs_work() {
    let dir = tmp("restart");
    let acc = acct(1);
    let tok;
    {
        let addr = serve(&dir, true).await;
        tok = token(&addr, &acc).await; // das Geheimnis liegt in der Datenbank: der Schlüssel gilt auch nach dem Neustart
        let a = Doc::new();
        let t = a.get_or_insert_text("t");
        t.insert(&mut a.transact_mut(), 0, "bleibt");
        let mut w = join(&addr, &tok, &a).await.unwrap();
        w.send(frame(1, &a.transact().encode_state_as_update_v1(&StateVector::default()))).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let addr = serve(&dir, true).await;
    let c = Doc::new();
    let tc = c.get_or_insert_text("t");
    let mut w = join(&addr, &tok, &c).await.unwrap();
    pump(&mut w, &c, |d| tc.get_string(&d.transact()) == "bleibt").await;
    assert_eq!(tc.get_string(&c.transact()), "bleibt");

    // Dateien: Hash muss zum Inhalt passen
    let hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    let path = format!("/blob/{DOC}/{hash}");
    let code = |r: (String, String)| r.0.split(' ').nth(1).unwrap().to_string();
    assert_eq!(code(http("PUT", &addr, &path, Some(&tok), b"anders").await), "400");
    assert_eq!(code(http("PUT", &addr, &path, None, b"hello").await), "401");
    assert_eq!(code(http("PUT", &addr, &path, Some(&tok), b"hello").await), "204");
    let got = http("GET", &addr, &path, Some(&tok), b"").await;
    assert!(got.0.contains("200") && got.1 == "hello");
}
