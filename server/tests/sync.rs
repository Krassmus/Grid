use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update, updates::{decoder::Decode, encoder::Encode}};

const TOKEN: &str = "test-token-1234567890";
const DOC: &str = "11111111-2222-3333-4444-555555555555";

async fn serve(dir: &std::path::Path) -> String {
    let app = grid_server::app(&dir.join("t.db"), TOKEN).unwrap();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("127.0.0.1:{}", addr.port())
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

/// Liest, bis ein Update ankommt, und wendet es auf `doc` an. Antwortet auf Schritt 1.
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
async fn wrong_token_is_denied() {
    let dir = std::env::temp_dir().join(format!("grid-t1-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let addr = serve(&dir).await;
    assert!(join(&addr, "falsch", &Doc::new()).await.is_err());
}

#[tokio::test]
async fn two_clients_merge_and_late_joiner_gets_state() {
    let dir = std::env::temp_dir().join(format!("grid-t2-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let addr = serve(&dir).await;

    let (a, b) = (Doc::new(), Doc::new());
    let (ta, tb) = (a.get_or_insert_text("t"), b.get_or_insert_text("t"));
    let mut wa = join(&addr, TOKEN, &a).await.unwrap();
    let mut wb = join(&addr, TOKEN, &b).await.unwrap();
    pump(&mut wa, &a, |_| false).await; // Austausch der Zustandsvektoren

    // A schreibt, B bekommt es
    let sv = a.transact().state_vector();
    ta.insert(&mut a.transact_mut(), 0, "Hallo");
    let upd = a.transact().encode_diff_v1(&sv);
    wa.send(frame(1, &upd)).await.unwrap();
    pump(&mut wb, &b, |d| tb.get_string(&d.transact()) == "Hallo").await;
    assert_eq!(tb.get_string(&b.transact()), "Hallo");

    // B schreibt gleichzeitig weiter, A bekommt es
    let sv = b.transact().state_vector();
    tb.insert(&mut b.transact_mut(), 5, " Welt");
    wb.send(frame(1, &b.transact().encode_diff_v1(&sv))).await.unwrap();
    pump(&mut wa, &a, |d| ta.get_string(&d.transact()) == "Hallo Welt").await;
    assert_eq!(ta.get_string(&a.transact()), "Hallo Welt");

    // Später dazukommender Client bekommt den ganzen Zustand aus dem Speicher
    drop((wa, wb));
    let c = Doc::new();
    let tc = c.get_or_insert_text("t");
    let mut wc = join(&addr, TOKEN, &c).await.unwrap();
    pump(&mut wc, &c, |d| tc.get_string(&d.transact()) == "Hallo Welt").await;
    assert_eq!(tc.get_string(&c.transact()), "Hallo Welt");
}

#[tokio::test]
async fn state_survives_restart_and_blobs_work() {
    let dir = std::env::temp_dir().join(format!("grid-t3-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    {
        let addr = serve(&dir).await;
        let a = Doc::new();
        let t = a.get_or_insert_text("t");
        t.insert(&mut a.transact_mut(), 0, "bleibt");
        let mut w = join(&addr, TOKEN, &a).await.unwrap();
        w.send(frame(1, &a.transact().encode_state_as_update_v1(&StateVector::default()))).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let addr = serve(&dir).await; // neuer Server, gleiche Datenbank
    let c = Doc::new();
    let tc = c.get_or_insert_text("t");
    let mut w = join(&addr, TOKEN, &c).await.unwrap();
    pump(&mut w, &c, |d| tc.get_string(&d.transact()) == "bleibt").await;
    assert_eq!(tc.get_string(&c.transact()), "bleibt");

    // Dateien: Hash muss zum Inhalt passen
    let bytes = b"hello";
    let hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    let url = format!("http://{addr}/blob/{DOC}/{hash}");
    let put = |body: &'static [u8], url: String, token: &'static str| async move {
        raw_http("PUT", &url, token, body).await
    };
    assert!(put(b"anders", url.clone(), TOKEN).await.starts_with("HTTP/1.1 400"));
    assert!(put(bytes, url.clone(), "falsch").await.starts_with("HTTP/1.1 401"));
    assert!(put(bytes, url.clone(), TOKEN).await.starts_with("HTTP/1.1 204"));
    let got = raw_http("GET", &url, TOKEN, b"").await;
    assert!(got.starts_with("HTTP/1.1 200") && got.ends_with("hello"));
}

/// Minimaler HTTP-Client, damit der Test ohne weitere Abhängigkeit auskommt.
async fn raw_http(method: &str, url: &str, token: &str, body: &[u8]) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_once('/').unwrap();
    let mut s = tokio::net::TcpStream::connect(host).await.unwrap();
    let req = format!("{method} /{path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    s.write_all(req.as_bytes()).await.unwrap();
    s.write_all(body).await.unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.unwrap();
    String::from_utf8_lossy(&out).to_string()
}
