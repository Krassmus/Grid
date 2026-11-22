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
    http_hdr(method, addr, path, token, "", body).await
}

async fn http_hdr(method: &str, addr: &str, path: &str, token: Option<&str>, extra: &str, body: &[u8]) -> (String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\n{auth}{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
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
    make_doc(&addr, &tok, &acc).await;

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

    make_doc(&addr, &ta, &a).await; // A legt das Dokument an
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
        make_doc(&addr, &tok, &acc).await;
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

// ---------- Mitglieder: Admin-Protokoll, Anklopfen, Entfernen ----------

/// Baut signierte Protokolleinträge für ein Dokument (Verkettung wird mitgeführt).
struct Chain { seq: u64, prev: String }
impl Chain {
    fn new() -> Chain { Chain { seq: 1, prev: String::new() } }
    fn entry(&self, signer: &Acct, kind: &str, subject: &Acct, role: &str, name: &str) -> (serde_json::Value, String) {
        let time = 1_700_000_000i64;
        let text = ["grid-admin-v1", DOC, &self.seq.to_string(), &self.prev, kind, &signer.id, &subject.id, &pub_hex(subject), role, name, &time.to_string()].join("\n");
        let sig: String = signer.key.sign(text.as_bytes()).to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let hash = {
            use sha2::{Digest, Sha256};
            Sha256::digest(format!("{text}\n{sig}")).iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let v = serde_json::json!({ "v": 1, "doc": DOC, "seq": self.seq, "prev": self.prev, "type": kind, "actor": signer.id,
            "subject": subject.id, "subjectPub": pub_hex(subject), "role": role, "name": name, "time": time, "sig": sig });
        (v, hash)
    }
    fn accept(&mut self, hash: String) { self.seq += 1; self.prev = hash; }
}

fn status(r: &(String, String)) -> u16 { r.0.split(' ').nth(1).unwrap().parse().unwrap() }
async fn post_entry(addr: &str, tok: &str, e: &serde_json::Value) -> (String, String) {
    http("POST", addr, &format!("/docs/{DOC}/admin"), Some(tok), e.to_string().as_bytes()).await
}
async fn get_members(addr: &str, tok: &str) -> (u16, serde_json::Value) {
    let r = http("GET", addr, &format!("/docs/{DOC}/members"), Some(tok), b"").await;
    (status(&r), serde_json::from_str(&r.1).unwrap_or(serde_json::Value::Null))
}

#[tokio::test]
async fn invite_accept_and_remove_members() {
    let dir = tmp("members");
    let addr = serve(&dir, true).await;
    let (a, b, c) = (acct(1), acct(2), acct(3));
    let (ta, tb, tc) = (token(&addr, &a).await, token(&addr, &b).await, token(&addr, &c).await);

    // A legt das Dokument an und gründet das Protokoll
    let mut chain = make_doc(&addr, &ta, &a).await;
    assert_eq!(get_members(&addr, &ta).await.1["role"], "admin");

    // B kennt das Dokument nicht: weder lesen noch Protokoll fälschen
    assert_eq!(get_members(&addr, &tb).await.0, 403);
    let (forged, _) = chain.entry(&b, "set", &b, "admin", "Ben");
    assert_eq!(status(&post_entry(&addr, &tb, &forged).await), 400, "Nur Admins dürfen das");

    // B klopft an, A sieht die Anfrage mit Namen und Schlüssel
    let r = http("POST", &addr, &format!("/docs/{DOC}/join"), Some(&tb), br#"{"name":"Ben"}"#).await;
    assert_eq!(status(&r), 202);
    assert!(join(&addr, &tb, &Doc::new()).await.unwrap_err().contains("requested"), "B wartet auf die Entscheidung");
    let (_, m) = get_members(&addr, &ta).await;
    assert_eq!(m["requests"][0]["account"], b.id.as_str());
    assert_eq!(m["requests"][0]["pub"], pub_hex(&b).as_str());
    // Mitglieder sehen keine Anfragen, und B als Wartender noch nichts
    assert_eq!(get_members(&addr, &tb).await.0, 403);

    // A nimmt B auf
    let mut wb_doc = Doc::new();
    let (set, h) = chain.entry(&a, "set", &b, "member", "Ben");
    assert_eq!(status(&post_entry(&addr, &ta, &set).await), 204);
    chain.accept(h);
    assert_eq!(get_members(&addr, &ta).await.1["requests"].as_array().unwrap().len(), 0);
    let mut wb = join(&addr, &tb, &wb_doc).await.unwrap();
    assert_eq!(get_members(&addr, &tb).await.1["role"], "member");
    // ein Mitglied darf nichts ändern
    let (try_set, _) = chain.entry(&b, "set", &c, "member", "Cora");
    assert_eq!(status(&post_entry(&addr, &tb, &try_set).await), 400);
    // veraltete Nummer: abgelehnt
    let (old, _) = Chain::new().entry(&a, "set", &c, "member", "Cora");
    assert_eq!(status(&post_entry(&addr, &ta, &old).await), 400);

    // C klopft an und wird abgelehnt
    http("POST", &addr, &format!("/docs/{DOC}/join"), Some(&tc), br#"{"name":"Cora"}"#).await;
    assert_eq!(status(&http("DELETE", &addr, &format!("/docs/{DOC}/join/{}", c.id), Some(&tb), b"").await), 403, "nur Admins");
    assert_eq!(status(&http("DELETE", &addr, &format!("/docs/{DOC}/join/{}", c.id), Some(&ta), b"").await), 204);
    assert!(join(&addr, &tc, &Doc::new()).await.unwrap_err().contains("forbidden"));

    // A entfernt B: die laufende Verbindung wird getrennt, neue Zugriffe scheitern
    let (rm, h) = chain.entry(&a, "remove", &b, "member", "");
    assert_eq!(status(&post_entry(&addr, &ta, &rm).await), 204);
    chain.accept(h);
    let mut closed = false;
    for _ in 0..10 {
        match tokio::time::timeout(std::time::Duration::from_millis(300), wb.next()).await {
            Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => { closed = true; break }
            _ => {}
        }
    }
    assert!(closed, "B wurde nicht getrennt");
    wb_doc = Doc::new();
    assert!(join(&addr, &tb, &wb_doc).await.unwrap_err().contains("forbidden"));
    assert_eq!(get_members(&addr, &tb).await.0, 403);
    // der letzte Admin kann sich nicht selbst entfernen
    let (last, _) = chain.entry(&a, "remove", &a, "admin", "");
    assert_eq!(status(&post_entry(&addr, &ta, &last).await), 400);
}

#[tokio::test]
async fn members_survive_restart() {
    let dir = tmp("members-restart");
    let (a, b) = (acct(1), acct(2));
    let chain;
    {
        let addr = serve(&dir, true).await;
        let ta = token(&addr, &a).await;
        chain = make_doc(&addr, &ta, &a).await;
        let (s, _) = chain.entry(&a, "set", &b, "member", "Ben");
        assert_eq!(status(&post_entry(&addr, &ta, &s).await), 204);
    }
    let addr = serve(&dir, true).await;
    let tb = token(&addr, &b).await;
    assert_eq!(get_members(&addr, &tb).await.1["role"], "member");
    assert!(join(&addr, &tb, &Doc::new()).await.is_ok());
}

// ---------- Abo und Speicherkontingent ----------

async fn serve_with(dir: &std::path::Path, cfg: grid_server::Config) -> String {
    let app = grid_server::app_with(&dir.join("t.db"), cfg).unwrap();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("127.0.0.1:{}", addr.port())
}

/// Sammelt eine Weile lang alle Textnachrichten der Verbindung.
async fn texts(ws: &mut Ws, ms: u64) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(Some(Ok(m))) = tokio::time::timeout(std::time::Duration::from_millis(ms), ws.next()).await {
        if let Message::Text(t) = m { out.push(t.to_string()); }
    }
    out
}

#[tokio::test]
async fn writing_needs_a_plan_and_free_storage() {
    let dir = tmp("billing");
    let addr = serve_with(&dir, grid_server::Config { open_registration: true, billing: true, ..Default::default() }).await;
    let a = acct(1);
    let ta = token(&addr, &a).await;
    let store = grid_server::Store::open(&dir.join("t.db")).unwrap();
    make_doc(&addr, &ta, &a).await;

    // Ohne Abo: Verbindung geht, Schreiben wird abgelehnt und gemeldet, nichts wird gespeichert
    let doc = Doc::new();
    let t = doc.get_or_insert_text("t");
    let mut ws = join(&addr, &ta, &doc).await.unwrap();
    t.insert(&mut doc.transact_mut(), 0, "x");
    ws.send(frame(1, &doc.transact().encode_state_as_update_v1(&StateVector::default()))).await.unwrap();
    let got = texts(&mut ws, 400).await;
    assert!(got.iter().any(|m| m.contains("readonly") && m.contains("no-plan")), "{got:?}");
    let fresh = Doc::new();
    let tf = fresh.get_or_insert_text("t");
    let mut w2 = join(&addr, &ta, &fresh).await.unwrap();
    pump(&mut w2, &fresh, |_| false).await;
    assert_eq!(tf.get_string(&fresh.transact()), "", "abgelehnte Änderung darf nicht gespeichert sein");
    let key = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert_eq!(status(&http("PUT", &addr, &format!("/blob/{DOC}/{key}"), Some(&ta), b"hello").await), 402);
    let me = http("GET", &addr, "/me", Some(&ta), b"").await;
    let me: serde_json::Value = serde_json::from_str(&me.1).unwrap();
    assert_eq!((me["plan"].as_str(), me["active"].as_bool(), me["billing"].as_bool()), (Some("free"), Some(false), Some(true)));

    // Mit Abo (kleines Kontingent): Schreiben geht, bis der Speicher voll ist (weiche Grenze)
    store.set_plan(&a.id, "paid", None, 4000).unwrap();
    let big = |n: usize| vec![b'a'; n];
    let hash = |b: &[u8]| { use sha2::{Digest, Sha256}; Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect::<String>() };
    let (b1, b2, b3) = (big(3000), big(3001), big(3002));
    for (b, want) in [(&b1, 204), (&b2, 204), (&b3, 402)] {
        let r = http("PUT", &addr, &format!("/blob/{DOC}/{}", hash(b)), Some(&ta), b).await;
        assert_eq!(status(&r), want, "{}", r.1);
    }
    let me: serde_json::Value = serde_json::from_str(&http("GET", &addr, "/me", Some(&ta), b"").await.1).unwrap();
    assert!(me["used"].as_i64().unwrap() >= 6000 && me["active"] == true);
    // Lesen geht trotzdem immer
    assert_eq!(status(&http("GET", &addr, &format!("/blob/{DOC}/{}", hash(&b1)), Some(&ta), b"").await), 200);

    // Abgelaufenes Abo: wieder nur lesbar
    store.set_plan(&a.id, "paid", Some(1), 4000).unwrap();
    assert_eq!(status(&http("PUT", &addr, &format!("/blob/{DOC}/{key}"), Some(&ta), b"hello").await), 402);
}

#[tokio::test]
async fn members_write_when_an_admin_pays_and_server_without_billing_is_free() {
    // Ohne Abo-Pflicht (eigenes Netz) ist alles frei
    let free_dir = tmp("nobilling");
    let addr = serve(&free_dir, true).await;
    let a = acct(1);
    let ta = token(&addr, &a).await;
    make_doc(&addr, &ta, &a).await;
    let key = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert_eq!(status(&http("PUT", &addr, &format!("/blob/{DOC}/{key}"), Some(&ta), b"hello").await), 204);
    let me: serde_json::Value = serde_json::from_str(&http("GET", &addr, "/me", Some(&ta), b"").await.1).unwrap();
    assert_eq!(me["billing"], false);

    // Mit Abo-Pflicht: Ein kostenloses Mitglied darf schreiben, solange ein Admin des Dokuments bezahlt
    let dir = tmp("billing-members");
    let addr = serve_with(&dir, grid_server::Config { open_registration: true, billing: true, ..Default::default() }).await;
    let (a, b) = (acct(1), acct(2));
    let (ta, tb) = (token(&addr, &a).await, token(&addr, &b).await);
    let store = grid_server::Store::open(&dir.join("t.db")).unwrap();
    store.set_plan(&a.id, "paid", None, 1_000_000).unwrap();
    let chain = make_doc(&addr, &ta, &a).await; // A legt das Dokument an
    let (s, _) = chain.entry(&a, "set", &b, "member", "Ben");
    assert_eq!(status(&post_entry(&addr, &ta, &s).await), 204);
    assert_eq!(status(&http("PUT", &addr, &format!("/blob/{DOC}/{key}"), Some(&tb), b"hello").await), 204, "B schreibt auf Kosten von A");
    // Endet As Abo, ist das Dokument für alle nur lesbar
    store.set_plan(&a.id, "free", None, 0).unwrap();
    assert_eq!(status(&http("PUT", &addr, &format!("/blob/{DOC}/{}", "0".repeat(64)), Some(&tb), b"x").await), 402);
    let m = get_members(&addr, &tb).await.1;
    assert_eq!(m["writable"]["ok"], false);
}

#[tokio::test]
async fn admin_interface_sets_plans() {
    let dir = tmp("adminapi");
    let key = "ein-langer-verwaltungsschluessel";
    let addr = serve_with(&dir, grid_server::Config { open_registration: true, billing: true, admin_key: Some(key.into()), ..Default::default() }).await;
    let a = acct(1);
    let ta = token(&addr, &a).await;
    let body = br#"{"plan":"paid","quota":123456,"paidUntil":4102444800}"#;
    let path = format!("/admin/accounts/{}/plan", a.id);
    assert_eq!(status(&http("PUT", &addr, &path, Some("falsch"), body).await), 401);
    assert_eq!(status(&http("PUT", &addr, &path, Some(&ta), body).await), 401, "Sitzungsschlüssel ersetzt den Verwaltungsschlüssel nicht");
    assert_eq!(status(&http("PUT", &addr, &path, Some(key), body).await), 204);
    let me: serde_json::Value = serde_json::from_str(&http("GET", &addr, "/me", Some(&ta), b"").await.1).unwrap();
    assert_eq!((me["active"].as_bool(), me["quota"].as_i64(), me["paidUntil"].as_i64()), (Some(true), Some(123456), Some(4102444800)));
    let list = http("GET", &addr, "/admin/accounts", Some(key), b"").await;
    assert!(list.1.contains(&a.id));
    // Ohne Verwaltungsschlüssel in der Einstellung gibt es die Schnittstelle gar nicht
    let addr2 = serve(&tmp("adminapi-off"), true).await;
    assert_eq!(status(&http("GET", &addr2, "/admin/accounts", Some(key), b"").await), 404);
}

/// Legt das Dokument an (Admin-Protokoll mit Gründungseintrag); ohne das verweigert der Server den Zugriff.
async fn make_doc(addr: &str, tok: &str, a: &Acct) -> Chain {
    let mut c = Chain::new();
    let (g, h) = c.entry(a, "genesis", a, "admin", "Anna");
    assert_eq!(status(&post_entry(addr, tok, &g).await), 204);
    c.accept(h);
    c
}

// ---------- Eigene Identität des Servers, Umzug auf einen anderen Server ----------

fn unhex(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect() }

#[tokio::test]
async fn server_proves_its_identity_and_keeps_it() {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let dir = tmp("identity");
    let mut keys = Vec::new();
    for _ in 0..2 { // zweimal starten: derselbe Schlüssel, weil er in der Datenbank liegt
        let addr = serve_with(&dir, grid_server::Config { name: Some("Firmenserver".into()), ..Default::default() }).await;
        let info: serde_json::Value = serde_json::from_str(&http("GET", &addr, "/server", None, b"").await.1).unwrap();
        assert_eq!(info["name"], "Firmenserver");
        let (_, ch) = http("GET", &addr, "/challenge", None, b"").await;
        let ch: serde_json::Value = serde_json::from_str(&ch).unwrap();
        let (pubkey, sig) = (ch["server"]["pub"].as_str().unwrap(), ch["server"]["sig"].as_str().unwrap());
        assert_eq!(pubkey, info["pub"].as_str().unwrap());
        let vk = VerifyingKey::from_bytes(&unhex(pubkey).try_into().unwrap()).unwrap();
        let sig = Signature::from_bytes(&unhex(sig).try_into().unwrap());
        vk.verify(format!("grid-server-v1\n{}", ch["nonce"].as_str().unwrap()).as_bytes(), &sig).unwrap();
        keys.push(pubkey.to_string());
    }
    assert_eq!(keys[0], keys[1]);
    assert_ne!(keys[0], { let d2 = tmp("identity2"); let a2 = serve(&d2, true).await; let i: serde_json::Value = serde_json::from_str(&http("GET", &a2, "/server", None, b"").await.1).unwrap(); i["pub"].as_str().unwrap().to_string() }, "jeder Server hat seinen eigenen Schlüssel");
}

#[tokio::test]
async fn unclaimed_documents_must_be_created_first() {
    let addr = serve(&tmp("unclaimed"), true).await;
    let a = acct(1);
    let ta = token(&addr, &a).await;
    assert!(join(&addr, &ta, &Doc::new()).await.unwrap_err().contains("unclaimed"), "kein stilles Beanspruchen mehr");
    make_doc(&addr, &ta, &a).await;
    assert!(join(&addr, &ta, &Doc::new()).await.is_ok());
}

#[tokio::test]
async fn document_can_move_to_another_server_with_its_members() {
    let (a, b, c) = (acct(1), acct(2), acct(3));
    // altes Zuhause: A gründet, nimmt B auf
    let old = serve(&tmp("move-old"), true).await;
    let (ta_old, _) = (token(&old, &a).await, token(&old, &b).await);
    let mut chain = make_doc(&old, &ta_old, &a).await;
    let (s, h) = chain.entry(&a, "set", &b, "member", "Ben");
    assert_eq!(status(&post_entry(&old, &ta_old, &s).await), 204);
    chain.accept(h);
    let entries = get_members(&old, &ta_old).await.1["entries"].clone();
    assert_eq!(entries.as_array().unwrap().len(), 2);

    // neuer Server
    let new = serve(&tmp("move-new"), true).await;
    let (ta, tb, tc) = (token(&new, &a).await, token(&new, &b).await, token(&new, &c).await);
    let import = |tok: String, body: serde_json::Value| { let new = new.clone(); async move {
        status(&http("POST", &new, &format!("/docs/{DOC}/import"), Some(&tok), body.to_string().as_bytes()).await) } };
    // Ein Mitglied darf nicht umziehen, Fremde auch nicht
    assert_eq!(import(tb.clone(), serde_json::json!({ "entries": entries })).await, 403);
    assert_eq!(import(tc.clone(), serde_json::json!({ "entries": entries })).await, 403);
    // Eine gefälschte Kette wird abgelehnt
    let mut forged = entries.clone();
    forged[1]["role"] = "admin".into();
    assert_eq!(import(ta.clone(), serde_json::json!({ "entries": forged })).await, 400);
    // Der Admin zieht um: Mitglieder und Rollen bleiben erhalten
    assert_eq!(import(ta.clone(), serde_json::json!({ "entries": entries })).await, 204);
    assert_eq!(get_members(&new, &tb).await.1["role"], "member");
    assert_eq!(get_members(&new, &ta).await.1["role"], "admin");
    assert!(join(&new, &tb, &Doc::new()).await.is_ok());
    // Zweimal geht nicht
    assert_eq!(import(ta, serde_json::json!({ "entries": entries })).await, 409);
}

// ---------- Stripe-Webhook ----------

fn stripe_header(secret: &str, t: i64, payload: &str) -> String {
    use hmac::{Hmac, Mac};
    let mut m = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    m.update(format!("{t}.{payload}").as_bytes());
    let sig: String = m.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
    format!("t={t},v1={sig}")
}

async fn stripe_post(addr: &str, header: &str, payload: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!("POST /billing/stripe HTTP/1.1\r\nHost: {addr}\r\nStripe-Signature: {header}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.unwrap();
    String::from_utf8_lossy(&out).split(' ').nth(1).unwrap().parse().unwrap()
}

async fn me_json(addr: &str, tok: &str) -> serde_json::Value {
    serde_json::from_str(&http("GET", addr, "/me", Some(tok), b"").await.1).unwrap()
}

#[tokio::test]
async fn stripe_events_set_and_end_the_plan() {
    let secret = "whsec_test_geheimnis";
    let dir = tmp("stripe");
    let addr = serve_with(&dir, grid_server::Config {
        open_registration: true, billing: true, stripe_webhook_secret: Some(secret.into()),
        checkout_url: Some("https://buy.stripe.com/test_abc".into()), stripe_quota: Some(2_000_000_000), ..Default::default()
    }).await;
    let a = acct(1);
    let ta = token(&addr, &a).await;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let send = |payload: String| { let addr = addr.clone(); async move { stripe_post(&addr, &stripe_header(secret, now, &payload), &payload).await } };

    // Der Zahlungslink trägt die Konto-Kennung
    let me = me_json(&addr, &ta).await;
    assert_eq!(me["checkoutUrl"], format!("https://buy.stripe.com/test_abc?client_reference_id={}", a.id).as_str());
    assert_eq!(me["active"], false);

    // Ohne gültige Signatur, mit falschem Geheimnis oder veraltetem Zeitstempel: abgelehnt
    let done = serde_json::json!({ "type": "checkout.session.completed", "data": { "object": { "client_reference_id": a.id, "customer": "cus_1" } } }).to_string();
    assert_eq!(stripe_post(&addr, "t=1,v1=00", &done).await, 400);
    assert_eq!(stripe_post(&addr, &stripe_header("falsch", now, &done), &done).await, 400);
    assert_eq!(stripe_post(&addr, &stripe_header(secret, now - 3600, &done), &done).await, 400);
    assert_eq!(me_json(&addr, &ta).await["active"], false, "abgelehnte Ereignisse ändern nichts");

    // Bezahlt: Abo gilt vorläufig, dann nennt die Rechnung den Zeitraum
    assert_eq!(send(done).await, 200);
    let me = me_json(&addr, &ta).await;
    assert_eq!((me["active"].as_bool(), me["quota"].as_i64()), (Some(true), Some(2_000_000_000)));
    let end = now + 30 * 86_400;
    let invoice = serde_json::json!({ "type": "invoice.paid", "data": { "object": { "customer": "cus_1", "lines": { "data": [{ "period": { "end": end } }] } } } }).to_string();
    assert_eq!(send(invoice).await, 200);
    assert_eq!(me_json(&addr, &ta).await["paidUntil"].as_i64(), Some(end + 3 * 86_400));

    // Unbekannter Kunde und fremde Ereignisse: angenommen, aber ohne Wirkung
    let stranger = serde_json::json!({ "type": "customer.subscription.deleted", "data": { "object": { "customer": "cus_unbekannt" } } }).to_string();
    assert_eq!(send(stranger).await, 200);
    assert_eq!(send(serde_json::json!({ "type": "ping", "data": { "object": {} } }).to_string()).await, 200);
    assert_eq!(me_json(&addr, &ta).await["active"], true);

    // Gekündigt: wieder kostenlos
    let gone = serde_json::json!({ "type": "customer.subscription.deleted", "data": { "object": { "customer": "cus_1" } } }).to_string();
    assert_eq!(send(gone).await, 200);
    assert_eq!(me_json(&addr, &ta).await["active"], false);

    // Ohne Geheimnis in der Einstellung gibt es den Webhook nicht
    let addr2 = serve_with(&tmp("stripe-off"), grid_server::Config { open_registration: true, ..Default::default() }).await;
    assert_eq!(stripe_post(&addr2, "t=1,v1=00", "{}").await, 404);
}

// ---------- Verschlüsselte Dokumente (docs/E2E.md) ----------

fn enc_entry(n: u8) -> Vec<u8> { let mut v = vec![1u8]; v.extend(std::iter::repeat_n(n, 40)); v } // Epoche 1, undurchsichtige Bytes

async fn open_enc(addr: &str, tok: &str, since: i64) -> (Ws, Vec<(i64, Vec<u8>)>, serde_json::Value) {
    let (mut ws, _) = connect_async(format!("ws://{addr}/ws/{DOC}")).await.unwrap();
    ws.send(Message::Text(format!("{{\"t\":\"hello\",\"token\":\"{tok}\",\"since\":{since}}}").into())).await.unwrap();
    let mut entries = Vec::new();
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) if t.contains("\"synced\"") => return (ws, entries, serde_json::from_str(&t).unwrap()),
            Some(Ok(Message::Text(_))) => {}
            Some(Ok(Message::Binary(b))) if b[0] == 5 => entries.push((i64::from_be_bytes(b[1..9].try_into().unwrap()), b[9..].to_vec())),
            other => panic!("unerwartet: {other:?}"),
        }
    }
}

async fn next_entry(ws: &mut Ws) -> (i64, Vec<u8>) {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(3), ws.next()).await.expect("Zeitüberschreitung") {
            Some(Ok(Message::Binary(b))) if b[0] == 5 => return (i64::from_be_bytes(b[1..9].try_into().unwrap()), b[9..].to_vec()),
            Some(Ok(_)) => {}
            other => panic!("unerwartet: {other:?}"),
        }
    }
}

#[tokio::test]
async fn encrypted_documents_store_opaque_entries_and_keys() {
    let dir = tmp("enc");
    let addr = serve(&dir, true).await;
    let (a, b) = (acct(1), acct(2));
    let (ta, tb) = (token(&addr, &a).await, token(&addr, &b).await);

    // Anlegen mit Verschlüsselung (Merkmal am Gründungseintrag)
    let mut c = Chain::new();
    let (g, h) = c.entry(&a, "genesis", &a, "admin", "Anna");
    assert_eq!(status(&http_hdr("POST", &addr, &format!("/docs/{DOC}/admin"), Some(&ta), "X-Grid-Enc: 1\r\n", g.to_string().as_bytes()).await), 204);
    c.accept(h);
    let (set, h) = c.entry(&a, "set", &b, "member", "Ben");
    assert_eq!(status(&post_entry(&addr, &ta, &set).await), 204);
    c.accept(h);
    assert_eq!(get_members(&addr, &ta).await.1["enc"], true);

    // Schlüsselkisten: nur Admins, nur Mitglieder, Epochen ohne Lücke
    let keys = format!("/docs/{DOC}/keys");
    let put = |t: &str, body: serde_json::Value| { let (addr, t, keys) = (addr.clone(), t.to_string(), keys.clone()); async move { status(&http("PUT", &addr, &keys, Some(&t), body.to_string().as_bytes()).await) } };
    assert_eq!(put(&ta, serde_json::json!([{ "epoch": 3, "account": a.id, "box": "x" }])).await, 400); // Lücke
    assert_eq!(put(&tb, serde_json::json!([{ "epoch": 1, "account": b.id, "box": "x" }])).await, 403); // kein Admin
    assert_eq!(put(&ta, serde_json::json!([{ "epoch": 1, "account": a.id, "box": "kiste-a" }])).await, 204);
    let got: serde_json::Value = serde_json::from_str(&http("GET", &addr, &keys, Some(&ta), b"").await.1).unwrap();
    assert_eq!(got["epoch"], 1);
    assert_eq!(got["missing"], serde_json::json!([b.id])); // Ben hat noch keine Kiste
    assert_eq!(got["boxes"][0]["box"], "kiste-a");
    assert_eq!(put(&ta, serde_json::json!([{ "epoch": 1, "account": b.id, "box": "kiste-b" }])).await, 204);
    let gb: serde_json::Value = serde_json::from_str(&http("GET", &addr, &keys, Some(&tb), b"").await.1).unwrap();
    assert_eq!((gb["boxes"][0]["box"].as_str(), gb["boxes"][0]["from"].as_str()), (Some("kiste-b"), Some(a.id.as_str())));
    assert_eq!(gb["missing"], serde_json::json!([])); // Ben ist kein Admin

    // Einträge: Nummer vergeben, an alle verteilen (auch an den Absender), später Dazukommende bekommen alles
    let (mut wa, none, synced) = open_enc(&addr, &ta, 0).await;
    assert!(none.is_empty());
    assert_eq!((synced["last"].as_i64(), synced["count"].as_i64()), (Some(0), Some(0)));
    let (mut wb, _, _) = open_enc(&addr, &tb, 0).await;
    wa.send(frame(4, &enc_entry(7))).await.unwrap();
    assert_eq!(next_entry(&mut wa).await, (1, enc_entry(7)));
    assert_eq!(next_entry(&mut wb).await, (1, enc_entry(7)));
    wb.send(frame(4, &enc_entry(8))).await.unwrap();
    assert_eq!(next_entry(&mut wa).await.0, 2);
    let (_w, late, synced) = open_enc(&addr, &tb, 0).await;
    assert_eq!(late.iter().map(|e| e.0).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(synced["last"], 2);
    let (_w2, since1, _) = open_enc(&addr, &ta, 1).await;
    assert_eq!(since1.iter().map(|e| e.0).collect::<Vec<_>>(), vec![2]);

    // Zu kurze Einträge (kein Tag) und Klartext-Updates werden nicht gespeichert
    wa.send(frame(4, &[1, 2, 3])).await.unwrap();
    wa.send(frame(1, &[0, 0, 5, 5, 5])).await.unwrap();

    // Gesamtzustand ersetzt alles bis zur Nummer 2
    let mut snap = 2i64.to_be_bytes().to_vec();
    snap.extend(enc_entry(9));
    wa.send(frame(6, &snap)).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let (_w3, all, synced) = open_enc(&addr, &ta, 0).await;
    assert_eq!(all, vec![(2, enc_entry(9))]);
    assert_eq!(synced["count"], 1);
    // eine unbekannte Nummer wird abgelehnt
    let mut bad = 99i64.to_be_bytes().to_vec();
    bad.extend(enc_entry(1));
    wa.send(frame(6, &bad)).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(open_enc(&addr, &ta, 0).await.1.len(), 1);

    // Dateien: der Server prüft den Hash bei verschlüsselten Dokumenten nicht (er sieht nur Chiffretext)
    let key = "a".repeat(64);
    let r = http("PUT", &addr, &format!("/blob/{DOC}/{key}"), Some(&ta), &enc_entry(3)).await;
    assert_eq!(status(&r), 204);
}

#[tokio::test]
async fn plaintext_document_is_encrypted_in_place_by_a_signed_entry() {
    let dir = tmp("migrate");
    let addr = serve(&dir, true).await;
    let (a, b) = (acct(1), acct(2));
    let (ta, tb) = (token(&addr, &a).await, token(&addr, &b).await);
    let mut c = make_doc(&addr, &ta, &a).await;
    let (set, h) = c.entry(&a, "set", &b, "member", "Ben");
    assert_eq!(status(&post_entry(&addr, &ta, &set).await), 204);
    c.accept(h);

    // Klartext-Daten und eine Datei liegen auf dem Server
    let doc = Doc::new();
    doc.get_or_insert_text("t").insert(&mut doc.transact_mut(), 0, "Klartext");
    let mut ws = join(&addr, &ta, &doc).await.unwrap();
    ws.send(frame(1, &doc.transact().encode_state_as_update_v1(&StateVector::default()))).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let body = b"datei";
    let hash = { use sha2::{Digest, Sha256}; Sha256::digest(body).iter().map(|x| format!("{x:02x}")).collect::<String>() };
    assert_eq!(status(&http("PUT", &addr, &format!("/blob/{DOC}/{hash}"), Some(&ta), body).await), 204);

    // Nur Admins dürfen verschlüsseln
    let (bad, _) = c.entry(&b, "encrypt", &b, "member", "");
    assert_ne!(status(&post_entry(&addr, &tb, &bad).await), 204);
    // Ein Admin darf: der Server stellt um und löscht den Klartext
    let (enc, h) = c.entry(&a, "encrypt", &a, "admin", "");
    assert_eq!(status(&post_entry(&addr, &ta, &enc).await), 204);
    c.accept(h);
    assert_eq!(get_members(&addr, &ta).await.1["enc"], true);
    let (_w, entries, synced) = open_enc(&addr, &ta, 0).await;
    assert!(entries.is_empty());
    assert_eq!(synced["count"], 0);
    assert_eq!(http("GET", &addr, &format!("/blobs/{DOC}"), Some(&ta), b"").await.1, "[]");
    // die alte Klartext-Verbindung wurde geschlossen
    let closed = tokio::time::timeout(std::time::Duration::from_secs(2), async { loop { match ws.next().await { None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return true, _ => {} } } }).await;
    assert!(closed.is_ok());
    // ein zweites Mal geht nicht
    let (again, _) = c.entry(&a, "encrypt", &a, "admin", "");
    assert_ne!(status(&post_entry(&addr, &ta, &again).await), 204);
}

#[tokio::test]
async fn server_can_require_encrypted_documents() {
    let dir = tmp("require");
    let addr = serve_with(&dir, grid_server::Config { open_registration: true, require_enc: true, ..Default::default() }).await;
    let a = acct(1);
    let ta = token(&addr, &a).await;
    let c = Chain::new();
    let (g, _) = c.entry(&a, "genesis", &a, "admin", "Anna");
    // ohne Verschlüsselung abgelehnt, mit Verschlüsselung angelegt
    assert_eq!(status(&post_entry(&addr, &ta, &g).await), 400);
    assert_eq!(status(&http_hdr("POST", &addr, &format!("/docs/{DOC}/admin"), Some(&ta), "X-Grid-Enc: 1\r\n", g.to_string().as_bytes()).await), 204);
    let info = http("GET", &addr, "/server", None, b"").await.1;
    assert!(info.contains("\"requireEnc\":true"));

    // Umzug: ein unverschlüsseltes Protokoll nimmt der Server nicht, eines mit `encrypt` schon (und markiert das Dokument)
    let other = "22222222-3333-4444-5555-666666666666";
    let entry = |kind: &str, seq: u64, prev: &str, doc: &str| {
        let text = ["grid-admin-v1", doc, &seq.to_string(), prev, kind, &a.id, &a.id, &pub_hex(&a), "admin", "Anna", "1700000000"].join("\n");
        let sig: String = a.key.sign(text.as_bytes()).to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let hash = { use sha2::{Digest, Sha256}; Sha256::digest(format!("{text}\n{sig}")).iter().map(|b| format!("{b:02x}")).collect::<String>() };
        (serde_json::json!({ "v": 1, "doc": doc, "seq": seq, "prev": prev, "type": kind, "actor": a.id, "subject": a.id, "subjectPub": pub_hex(&a), "role": "admin", "name": "Anna", "time": 1_700_000_000i64, "sig": sig }), hash)
    };
    let (g2, h2) = entry("genesis", 1, "", other);
    let plain = serde_json::json!({ "entries": [g2.clone()] }).to_string();
    assert_eq!(status(&http("POST", &addr, &format!("/docs/{other}/import"), Some(&ta), plain.as_bytes()).await), 400);
    let (e2, _) = entry("encrypt", 2, &h2, other);
    let encrypted = serde_json::json!({ "entries": [g2, e2] }).to_string();
    assert_eq!(status(&http("POST", &addr, &format!("/docs/{other}/import"), Some(&ta), encrypted.as_bytes()).await), 204);
    let store = grid_server::Store::open(&dir.join("t.db")).unwrap();
    assert!(store.is_enc(other));
}

// ---------- E-Mail und Wiederherstellung ----------

async fn read_code(mailbox: &std::path::Path) -> String {
    for _ in 0..40 {
        if let Ok(t) = std::fs::read_to_string(mailbox) {
            if let Some(c) = t.split("Code").filter_map(|p| p.split(|ch: char| !ch.is_ascii_digit()).find(|d| d.len() == 6)).last() { return c.to_string(); }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("keine Mail angekommen");
}

#[tokio::test]
async fn account_can_be_recovered_with_email_and_password_encrypted_blob() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tmp("mail");
    let mailbox = dir.join("mail.txt");
    let script = dir.join("sendmail.sh");
    std::fs::write(&script, format!("#!/bin/sh\ncat > {}\n", mailbox.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let addr = serve_with(&dir, grid_server::Config {
        open_registration: true, mail_from: Some("grid@example.org".into()), mail_command: Some(script.display().to_string()), ..Default::default()
    }).await;
    let a = acct(1);
    let ta = token(&addr, &a).await;
    let json = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
    let post = |path: &str, tok: Option<String>, body: serde_json::Value| { let (addr, path) = (addr.clone(), path.to_string()); async move { http("POST", &addr, &path, tok.as_deref(), body.to_string().as_bytes()).await } };

    // Adresse ungültig oder Wiederherstellung vor der Bestätigung: abgelehnt
    assert_eq!(status(&post("/me/email", Some(ta.clone()), serde_json::json!({ "email": "kein-mail" })).await), 400);
    assert_eq!(status(&http("PUT", &addr, "/me/recovery", Some(&ta), b"grid-account:1:abc").await), 400);
    // Code anfordern, falschen und richtigen eingeben
    assert_eq!(status(&post("/me/email", Some(ta.clone()), serde_json::json!({ "email": "Anna@Example.org" })).await), 204);
    let code = read_code(&mailbox).await;
    assert_eq!(status(&post("/me/email/confirm", Some(ta.clone()), serde_json::json!({ "code": "000000" })).await), 400);
    assert_eq!(status(&post("/me/email/confirm", Some(ta.clone()), serde_json::json!({ "code": code })).await), 204);
    let me = json(&http("GET", &addr, "/me", Some(&ta), b"").await.1);
    assert_eq!((me["email"].as_str(), me["emailVerified"].as_bool(), me["recovery"].as_bool()), (Some("Anna@Example.org"), Some(true), Some(false)));
    // Kein Konto-Text → abgelehnt; mit Konto-Text gespeichert
    assert_eq!(status(&http("PUT", &addr, "/me/recovery", Some(&ta), b"irgendwas").await), 400);
    assert_eq!(status(&http("PUT", &addr, "/me/recovery", Some(&ta), b"grid-account:1:c2FsdA==:aXY=:Y3Q=").await), 204);

    // Auf einem neuen Gerät: unbekannte Adresse verrät nichts (204, aber keine Mail), bekannte schickt einen Code
    std::fs::remove_file(&mailbox).ok();
    assert_eq!(status(&post("/recover/start", None, serde_json::json!({ "email": "niemand@example.org" })).await), 204);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!mailbox.exists());
    assert_eq!(status(&post("/recover/start", None, serde_json::json!({ "email": "anna@example.org" })).await), 204);
    let code = read_code(&mailbox).await;
    // falscher Code, dann richtiger (Groß-/Kleinschreibung der Adresse egal)
    assert_eq!(status(&post("/recover/finish", None, serde_json::json!({ "email": "anna@example.org", "code": "111111" })).await), 400);
    let r = post("/recover/finish", None, serde_json::json!({ "email": "ANNA@example.org", "code": code })).await;
    assert_eq!(status(&r), 200);
    let v = json(&r.1);
    assert_eq!((v["id"].as_str(), v["account"].as_str()), (Some(a.id.as_str()), Some("grid-account:1:c2FsdA==:aXY=:Y3Q=")));
    // der Code ist verbraucht
    assert_eq!(status(&post("/recover/finish", None, serde_json::json!({ "email": "anna@example.org", "code": code })).await), 400);

    // Nach fünf Fehlversuchen ist der Code gesperrt, auch der richtige
    std::fs::remove_file(&mailbox).ok();
    assert_eq!(status(&post("/recover/start", None, serde_json::json!({ "email": "anna@example.org" })).await), 204);
    let code = read_code(&mailbox).await;
    for _ in 0..5 { post("/recover/finish", None, serde_json::json!({ "email": "anna@example.org", "code": "999999" })).await; }
    assert_eq!(status(&post("/recover/finish", None, serde_json::json!({ "email": "anna@example.org", "code": code })).await), 400);

    // Adresse entfernen löscht auch die Wiederherstellungsdaten
    assert_eq!(status(&http("DELETE", &addr, "/me/email", Some(&ta), b"").await), 204);
    let me = json(&http("GET", &addr, "/me", Some(&ta), b"").await.1);
    assert_eq!((me["email"].is_null(), me["recovery"].as_bool()), (true, Some(false)));
}

#[tokio::test]
async fn email_is_off_without_mail_settings() {
    let dir = tmp("nomail");
    let addr = serve(&dir, true).await;
    let ta = token(&addr, &acct(1)).await;
    assert_eq!(status(&http("POST", &addr, "/me/email", Some(&ta), b"{\"email\":\"a@example.org\"}").await), 404);
    assert_eq!(status(&http("POST", &addr, "/recover/start", None, b"{\"email\":\"a@example.org\"}").await), 404);
}

#[tokio::test]
async fn members_can_leave_and_leftover_keys_are_reported_as_stale() {
    let dir = tmp("leave");
    let addr = serve(&dir, true).await;
    let (a, b) = (acct(1), acct(2));
    let (ta, tb) = (token(&addr, &a).await, token(&addr, &b).await);
    let mut c = Chain::new();
    let (g, h) = c.entry(&a, "genesis", &a, "admin", "Anna");
    assert_eq!(status(&http_hdr("POST", &addr, &format!("/docs/{DOC}/admin"), Some(&ta), "X-Grid-Enc: 1\r\n", g.to_string().as_bytes()).await), 204);
    c.accept(h);
    let (set, h) = c.entry(&a, "set", &b, "member", "Ben");
    assert_eq!(status(&post_entry(&addr, &ta, &set).await), 204);
    c.accept(h);
    let keys = format!("/docs/{DOC}/keys");
    let boxes = serde_json::json!([{ "epoch": 1, "account": a.id, "box": "ka" }, { "epoch": 1, "account": b.id, "box": "kb" }]);
    assert_eq!(status(&http("PUT", &addr, &keys, Some(&ta), boxes.to_string().as_bytes()).await), 204);

    // Der einzige Admin kann nicht gehen
    let (bad, _) = c.entry(&a, "remove", &a, "admin", "");
    assert_eq!(status(&post_entry(&addr, &ta, &bad).await), 400);
    // Ein Mitglied verlässt das Dokument selbst und hat danach keinen Zugriff mehr
    let (leave, h) = c.entry(&b, "remove", &b, "member", "");
    assert_eq!(status(&post_entry(&addr, &tb, &leave).await), 204);
    c.accept(h);
    assert_eq!(status(&http("GET", &addr, &keys, Some(&tb), b"").await), 403);
    // Der Admin erfährt, dass der Ausgetretene noch eine Kiste für die neueste Epoche hat
    let got: serde_json::Value = serde_json::from_str(&http("GET", &addr, &keys, Some(&ta), b"").await.1).unwrap();
    assert_eq!(got["stale"], serde_json::json!([b.id]));
    // Nach einer neuen Epoche nur für Anna ist nichts mehr offen
    assert_eq!(status(&http("PUT", &addr, &keys, Some(&ta), serde_json::json!([{ "epoch": 2, "account": a.id, "box": "ka2" }]).to_string().as_bytes()).await), 204);
    let got: serde_json::Value = serde_json::from_str(&http("GET", &addr, &keys, Some(&ta), b"").await.1).unwrap();
    assert_eq!((got["epoch"].as_i64(), got["stale"].clone()), (Some(2), serde_json::json!([])));
}

// ---------- In-App-Kauf (App Store) und freier Speicherplatz ----------

mod storekit {
    use base64::{Engine, engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}};
    use p256::ecdsa::{Signature, SigningKey, signature::Signer};
    use rcgen::{BasicConstraints, CertificateParams, CustomExtension, IsCa, KeyPair};

    pub struct Pki { pub root: Vec<u8>, inter: Vec<u8>, leaf: Vec<u8>, key: SigningKey }
    pub fn pki() -> Pki {
        let ext = |oid: &[u64]| CustomExtension::from_oid_content(oid, vec![0x05, 0x00]);
        let rk = KeyPair::generate().unwrap();
        let mut rp = CertificateParams::new(Vec::<String>::new()).unwrap();
        rp.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let root = rp.self_signed(&rk).unwrap();
        let ik = KeyPair::generate().unwrap();
        let mut ip = CertificateParams::new(Vec::<String>::new()).unwrap();
        ip.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let inter = ip.signed_by(&ik, &root, &rk).unwrap();
        let lk = KeyPair::generate().unwrap();
        let mut lp = CertificateParams::new(Vec::<String>::new()).unwrap();
        let _ = ext;
        let leaf = lp.signed_by(&lk, &inter, &ik).unwrap();
        use p256::pkcs8::DecodePrivateKey;
        Pki { root: root.der().to_vec(), inter: inter.der().to_vec(), leaf: leaf.der().to_vec(), key: SigningKey::from_pkcs8_der(&lk.serialize_der()).unwrap() }
    }
    pub fn sign(p: &Pki, payload: serde_json::Value) -> String {
        let h = URL_SAFE_NO_PAD.encode(serde_json::json!({ "alg": "ES256", "x5c": [STANDARD.encode(&p.leaf), STANDARD.encode(&p.inter)] }).to_string());
        let b = URL_SAFE_NO_PAD.encode(payload.to_string());
        let sig: Signature = p.key.sign(format!("{h}.{b}").as_bytes());
        format!("{h}.{b}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }
}

fn tx(account: &str, original: &str, product: &str, expires_in: i64, env: &str) -> serde_json::Value {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    serde_json::json!({ "bundleId": "eu.townwork.grid", "productId": product, "originalTransactionId": original, "appAccountToken": account.to_uppercase(),
        "expiresDate": (now + expires_in) * 1000, "environment": env, "signedDate": now * 1000 })
}

#[tokio::test]
async fn app_store_purchase_unlocks_a_plan_without_anyone_approving_the_account() {
    let dir = tmp("iap");
    let pki = storekit::pki();
    let addr = serve_with(&dir, grid_server::Config {
        open_registration: true, billing: true, apple_bundle: Some("eu.townwork.grid".into()),
        apple_products: vec![("eu.townwork.grid.cloud.monthly".into(), 5_000_000_000)], apple_root_override: Some(pki.root.clone()), ..Default::default()
    }).await;
    let (a, b) = (acct(1), acct(2));
    let (ta, tb) = (token(&addr, &a).await, token(&addr, &b).await);
    let me = |t: String| { let addr = addr.clone(); async move { serde_json::from_str::<serde_json::Value>(&http("GET", &addr, "/me", Some(&t), b"").await.1).unwrap() } };
    let send = |t: String, v: serde_json::Value| { let (addr, pki_jws) = (addr.clone(), storekit::sign(&pki, v)); async move { http("POST", &addr, "/billing/apple/transaction", Some(&t), serde_json::json!({ "jws": pki_jws }).to_string().as_bytes()).await } };

    let m = me(ta.clone()).await;
    assert_eq!(m["active"], false);
    assert_eq!(m["iap"]["products"][0]["id"], "eu.townwork.grid.cloud.monthly");

    // Kauf des eigenen Kontos: Abo ist sofort da
    assert_eq!(status(&send(ta.clone(), tx(&a.id, "1000", "eu.townwork.grid.cloud.monthly", 30 * 86_400, "Production")).await), 200);
    let m = me(ta.clone()).await;
    assert_eq!((m["active"].as_bool(), m["quota"].as_i64(), m["planSource"].as_str()), (Some(true), Some(5_000_000_000), Some("apple")));
    // gleiche Meldung noch einmal ist harmlos
    assert_eq!(status(&send(ta.clone(), tx(&a.id, "1000", "eu.townwork.grid.cloud.monthly", 30 * 86_400, "Production")).await), 200);

    // Fremde Konten, fremde Käufe, falsche Produkte, Testumgebung, abgelaufen: abgelehnt
    assert_eq!(status(&send(tb.clone(), tx(&a.id, "1000", "eu.townwork.grid.cloud.monthly", 30 * 86_400, "Production")).await), 403); // Kauf von Konto a, von b gemeldet
    assert_eq!(status(&send(tb.clone(), tx(&b.id, "1000", "eu.townwork.grid.cloud.monthly", 30 * 86_400, "Production")).await), 403); // dieselbe Transaktion gehört a
    assert_eq!(status(&send(tb.clone(), tx(&b.id, "2000", "irgendwas", 30 * 86_400, "Production")).await), 400);
    assert_eq!(status(&send(tb.clone(), tx(&b.id, "2000", "eu.townwork.grid.cloud.monthly", 30 * 86_400, "Sandbox")).await), 400);
    assert_eq!(status(&send(tb.clone(), tx(&b.id, "2000", "eu.townwork.grid.cloud.monthly", -3600, "Production")).await), 400);
    assert_eq!(me(tb.clone()).await["active"], false);
    // ein Beleg, den nicht Apple (die erwartete Wurzel) signiert hat
    let other = storekit::pki();
    let forged = serde_json::json!({ "jws": storekit::sign(&other, tx(&b.id, "3000", "eu.townwork.grid.cloud.monthly", 86_400, "Production")) }).to_string();
    assert_eq!(status(&http("POST", &addr, "/billing/apple/transaction", Some(&tb), forged.as_bytes()).await), 400);
    assert_eq!(me(tb.clone()).await["active"], false);

    // Server-Benachrichtigung: Ablauf beendet ein gekauftes Abo ...
    let note = |kind: &str, t: serde_json::Value| serde_json::json!({ "signedPayload": storekit::sign(&pki, serde_json::json!({ "notificationType": kind, "signedDate": 0, "data": { "signedTransactionInfo": storekit::sign(&pki, t) } })) }).to_string();
    // (signedDate 0 im äußeren Beleg: gilt als „jetzt“ nur, wenn es fehlt; hier prüfen die Zertifikate zur Zeit 0 → ungültig)
    let outer_bad = http("POST", &addr, "/billing/apple/notify", None, note("EXPIRED", tx(&a.id, "1000", "eu.townwork.grid.cloud.monthly", -10, "Production")).as_bytes()).await;
    assert_eq!(status(&outer_bad), 400);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let note = |kind: &str, t: serde_json::Value| serde_json::json!({ "signedPayload": storekit::sign(&pki, serde_json::json!({ "notificationType": kind, "signedDate": now * 1000, "data": { "signedTransactionInfo": storekit::sign(&pki, t) } })) }).to_string();
    assert_eq!(status(&http("POST", &addr, "/billing/apple/notify", None, note("DID_RENEW", tx(&a.id, "1000", "eu.townwork.grid.cloud.monthly", 60 * 86_400, "Production")).as_bytes()).await), 200);
    let until = me(ta.clone()).await["paidUntil"].as_i64().unwrap();
    assert!(until > now + 59 * 86_400);
    assert_eq!(status(&http("POST", &addr, "/billing/apple/notify", None, note("EXPIRED", tx(&a.id, "1000", "eu.townwork.grid.cloud.monthly", -10, "Production")).as_bytes()).await), 200);
    assert_eq!(me(ta.clone()).await["active"], false);

    // ... aber ein vom Betreiber gesetztes Abo (Freunde, Apple-Prüfung) bleibt davon unberührt
    let store = grid_server::Store::open(&dir.join("t.db")).unwrap();
    store.set_plan(&b.id, "paid", None, 1_000_000_000).unwrap();
    assert_eq!(status(&http("POST", &addr, "/billing/apple/notify", None, note("EXPIRED", tx(&b.id, "4000", "eu.townwork.grid.cloud.monthly", -10, "Production")).as_bytes()).await), 200);
    let m = me(tb.clone()).await;
    assert_eq!((m["active"].as_bool(), m["planSource"].as_str(), m["quota"].as_i64()), (Some(true), Some("manual"), Some(1_000_000_000)));
}

#[tokio::test]
async fn purchases_are_off_without_app_settings() {
    let dir = tmp("noiap");
    let addr = serve_with(&dir, grid_server::Config { open_registration: true, ..Default::default() }).await;
    let ta = token(&addr, &acct(1)).await;
    assert_eq!(status(&http("POST", &addr, "/billing/apple/transaction", Some(&ta), b"{\"jws\":\"a.b.c\"}").await), 400);
    assert_eq!(status(&http("POST", &addr, "/billing/apple/notify", None, b"{\"signedPayload\":\"a.b.c\"}").await), 404);
    let m: serde_json::Value = serde_json::from_str(&http("GET", &addr, "/me", Some(&ta), b"").await.1).unwrap();
    assert!(m["iap"].is_null());
}

#[tokio::test]
async fn server_stops_accepting_changes_when_disk_space_is_low() {
    let dir = tmp("disk");
    // Mindestens „unendlich“ frei verlangt: der Datenträger gilt immer als zu voll
    let addr = serve_with(&dir, grid_server::Config { open_registration: true, min_free: i64::MAX, ..Default::default() }).await;
    let a = acct(1);
    let ta = token(&addr, &a).await;
    make_doc(&addr, &ta, &a).await;
    let key = "b".repeat(64);
    let r = http("PUT", &addr, &format!("/blob/{DOC}/{key}"), Some(&ta), b"x").await;
    assert_eq!(status(&r), 402);
    assert!(r.1.contains("Speicherplatz"));
    // Lesen geht weiter
    assert_eq!(status(&http("GET", &addr, &format!("/blobs/{DOC}"), Some(&ta), b"").await), 200);
    let m = get_members(&addr, &ta).await.1;
    assert_eq!(m["writable"]["code"], "disk");
}
