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
