//! Anmeldung per Signatur: Rätsel (nonce) holen, mit dem Konto-Schlüssel signieren, Sitzungsschlüssel erhalten.
//! Alle Rätsel und Sitzungsschlüssel sind mit dem Server-Geheimnis beglaubigt (zustandslos, kein Speicher nötig).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha = Hmac<Sha256>;

/// So lange gilt ein Rätsel (Sekunden).
const NONCE_TTL: i64 = 60;
/// So lange gilt ein Sitzungsschlüssel (Sekunden).
pub const SESSION_TTL: i64 = 3600;

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() { return None; }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

fn mac(secret: &[u8], text: &str) -> HmacSha {
    let mut m = HmacSha::new_from_slice(secret).expect("HMAC nimmt jede Länge");
    m.update(text.as_bytes());
    m
}

fn sign_text(secret: &[u8], text: &str) -> String { hex(&mac(secret, text).finalize().into_bytes()) }

pub fn check_text(secret: &[u8], text: &str, tag: &str) -> bool {
    unhex(tag).is_some_and(|t| mac(secret, text).verify_slice(&t).is_ok())
}

pub fn new_nonce(secret: &[u8]) -> String {
    let ts = now();
    format!("{ts}.{}", sign_text(secret, &format!("nonce|{ts}")))
}

fn nonce_valid(secret: &[u8], nonce: &str) -> bool {
    let Some((ts, tag)) = nonce.split_once('.') else { return false };
    let Ok(t) = ts.parse::<i64>() else { return false };
    let age = now() - t;
    (-5..=NONCE_TTL).contains(&age) && check_text(secret, &format!("nonce|{t}"), tag)
}

/// Text, den das Konto signiert, um sich anzumelden.
pub fn login_message(id: &str, nonce: &str) -> String { format!("grid-login-v1\n{id}\n{nonce}") }

/// Prüft Rätsel und Signatur. `pubkey` ist der öffentliche Schlüssel in Hex.
pub fn verify_login(secret: &[u8], id: &str, pubkey: &str, nonce: &str, sig: &str) -> Result<(), &'static str> {
    if !nonce_valid(secret, nonce) { return Err("Rätsel abgelaufen"); }
    let key: [u8; 32] = unhex(pubkey).and_then(|b| b.try_into().ok()).ok_or("Schlüssel ungültig")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "Schlüssel ungültig")?;
    let sig: [u8; 64] = unhex(sig).and_then(|b| b.try_into().ok()).ok_or("Signatur ungültig")?;
    key.verify(login_message(id, nonce).as_bytes(), &Signature::from_bytes(&sig)).map_err(|_| "Signatur falsch")
}

/// Sitzungsschlüssel: `<Konto>.<Ablauf>.<Beglaubigung>`
pub fn new_token(secret: &[u8], id: &str) -> (String, i64) {
    let exp = now() + SESSION_TTL;
    (format!("{id}.{exp}.{}", sign_text(secret, &format!("token|{id}|{exp}"))), exp)
}

/// Liefert die Konto-Kennung, wenn der Sitzungsschlüssel echt und nicht abgelaufen ist.
pub fn token_account(secret: &[u8], token: &str) -> Option<String> {
    let mut parts = token.splitn(3, '.');
    let (id, exp, tag) = (parts.next()?, parts.next()?, parts.next()?);
    let exp: i64 = exp.parse().ok()?;
    (exp > now() && check_text(secret, &format!("token|{id}|{exp}"), tag)).then(|| id.to_string())
}
