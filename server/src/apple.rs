//! App-Store-Belege prüfen (StoreKit 2): Die App schickt die von Apple signierte Transaktion (JWS). Der Server prüft die
//! Signatur und die Zertifikatskette bis zum fest eingebauten Apple-Wurzelzertifikat, ohne bei Apple nachzufragen und
//! ohne Zugangsdaten zu brauchen. Hintergrund: docs/SYNC.md, Abschnitt „In-App-Kauf“.

use base64::{Engine, engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use x509_parser::{prelude::*, time::ASN1Time};

/// „Apple Root CA - G3“ (https://www.apple.com/certificateauthority/), gültig bis 2039.
pub const APPLE_ROOT_G3: &[u8] = include_bytes!("apple_root_ca_g3.cer");

// Apple kennzeichnet die Zertifikate für App-Store-Signaturen mit diesen Erweiterungen (Zwischenzertifikat, Blattzertifikat).
const OID_INTERMEDIATE: &str = "1.2.840.113635.100.6.2.1";
const OID_LEAF: &str = "1.2.840.113635.100.6.11.1";

fn has_ext(cert: &X509Certificate<'_>, oid: &str) -> bool {
    cert.extensions().iter().any(|e| e.oid.to_id_string() == oid)
}

/// Prüft einen JWS (kompakt: Kopf.Inhalt.Signatur) gegen die Zertifikatskette im Kopf und liefert den Inhalt als JSON.
/// `root` ist das erwartete Wurzelzertifikat (DER); `require_apple_oids` verlangt Apples Kennzeichen an den Zertifikaten.
pub fn verify_jws(jws: &str, root: &[u8], require_apple_oids: bool) -> Result<serde_json::Value, String> {
    let mut parts = jws.trim().split('.');
    let (Some(h), Some(p), Some(sig), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Err("Beleg hat nicht drei Teile".into()) };
    let dec = |s: &str| URL_SAFE_NO_PAD.decode(s).map_err(|_| "Beleg ist kein gültiges Base64".to_string());
    let header: serde_json::Value = serde_json::from_slice(&dec(h)?).map_err(|_| "Kopf ist kein JSON")?;
    if header["alg"] != "ES256" { return Err("Nur ES256 wird akzeptiert".into()); }
    let chain: Vec<Vec<u8>> = header["x5c"].as_array().ok_or("Zertifikatskette fehlt")?
        .iter().map(|c| c.as_str().ok_or("Zertifikat ungültig").and_then(|s| STANDARD.decode(s).map_err(|_| "Zertifikat ungültig")).map_err(String::from)).collect::<Result<_, _>>()?;
    if chain.len() < 2 || chain.len() > 3 { return Err("Zertifikatskette hat die falsche Länge".into()); }
    let certs: Vec<X509Certificate<'_>> = chain.iter().map(|c| X509Certificate::from_der(c).map(|(_, x)| x).map_err(|_| "Zertifikat nicht lesbar".to_string())).collect::<Result<_, _>>()?;
    let (_, root_cert) = X509Certificate::from_der(root).map_err(|_| "Wurzelzertifikat nicht lesbar")?;
    // Kette: Blatt ← Zwischenzertifikat ← (Wurzel). Ein mitgeschicktes drittes Zertifikat muss genau die erwartete Wurzel sein.
    if certs.len() == 3 && chain[2] != root { return Err("Die Kette endet nicht im erwarteten Wurzelzertifikat".into()); }
    let (leaf, inter) = (&certs[0], &certs[1]);
    leaf.verify_signature(Some(inter.public_key())).map_err(|_| "Blattzertifikat ist nicht vom Zwischenzertifikat signiert")?;
    inter.verify_signature(Some(root_cert.public_key())).map_err(|_| "Zwischenzertifikat ist nicht von Apple signiert")?;
    if require_apple_oids && !(has_ext(leaf, OID_LEAF) && has_ext(inter, OID_INTERMEDIATE)) { return Err("Zertifikate tragen Apples Kennzeichen nicht".into()); }

    // Signatur über „Kopf.Inhalt“ mit dem Schlüssel des Blattzertifikats (ES256: 64 Byte r‖s)
    let key = VerifyingKey::from_sec1_bytes(&leaf.public_key().subject_public_key.data).map_err(|_| "Schlüssel ungültig")?;
    let signature = Signature::from_slice(&dec(sig)?).map_err(|_| "Signatur ungültig")?;
    key.verify(format!("{h}.{p}").as_bytes(), &signature).map_err(|_| "Signatur falsch")?;

    let payload: serde_json::Value = serde_json::from_slice(&dec(p)?).map_err(|_| "Inhalt ist kein JSON")?;
    // Die Zertifikate müssen zum Zeitpunkt der Signatur gelten (Apple nennt ihn als `signedDate`, in Millisekunden)
    let at = payload["signedDate"].as_i64().map(|ms| ms / 1000).unwrap_or_else(crate::store::now);
    let at = ASN1Time::from_timestamp(at).map_err(|_| "Zeitpunkt ungültig")?;
    for c in &certs { if !c.validity().is_valid_at(at) { return Err("Ein Zertifikat war zum Zeitpunkt der Signatur nicht gültig".into()); } }
    Ok(payload)
}

/// Was der Server aus einer geprüften Transaktion braucht.
#[derive(Debug, PartialEq)]
pub struct Transaction {
    pub product: String,
    pub original_id: String,
    /// Konto-Kennung, die die App beim Kauf mitgegeben hat (`appAccountToken`)
    pub account: Option<String>,
    /// Ende des bezahlten Zeitraums in Unix-Sekunden (Abos)
    pub expires: Option<i64>,
    pub revoked: bool,
    pub sandbox: bool,
}

/// Liest eine geprüfte Transaktion; `bundle` ist die erwartete App-Kennung.
pub fn transaction(payload: &serde_json::Value, bundle: &str) -> Result<Transaction, String> {
    if payload["bundleId"].as_str() != Some(bundle) { return Err("Der Beleg gehört zu einer anderen App".into()); }
    Ok(Transaction {
        product: payload["productId"].as_str().ok_or("Produkt fehlt")?.to_string(),
        original_id: payload["originalTransactionId"].as_str().ok_or("Transaktion fehlt")?.to_string(),
        account: payload["appAccountToken"].as_str().map(|s| s.to_ascii_lowercase()),
        expires: payload["expiresDate"].as_i64().map(|ms| ms / 1000),
        revoked: payload["revocationDate"].is_number(),
        sandbox: payload["environment"].as_str() == Some("Sandbox"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{SigningKey, signature::Signer};
    use rcgen::{BasicConstraints, CertificateParams, CustomExtension, IsCa, KeyPair};

    struct Pki { root_der: Vec<u8>, inter_der: Vec<u8>, leaf_der: Vec<u8>, leaf_key: SigningKey }

    fn pki(apple_oids: bool) -> Pki {
        let ext = |oid: &[u64]| CustomExtension::from_oid_content(oid, vec![0x05, 0x00]);
        let root_key = KeyPair::generate().unwrap();
        let mut rp = CertificateParams::new(Vec::<String>::new()).unwrap();
        rp.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let root = rp.self_signed(&root_key).unwrap();
        let inter_key = KeyPair::generate().unwrap();
        let mut ip = CertificateParams::new(Vec::<String>::new()).unwrap();
        ip.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        if apple_oids { ip.custom_extensions.push(ext(&[1, 2, 840, 113635, 100, 6, 2, 1])); }
        let inter = ip.signed_by(&inter_key, &root, &root_key).unwrap();
        let leaf_key = KeyPair::generate().unwrap();
        let mut lp = CertificateParams::new(Vec::<String>::new()).unwrap();
        if apple_oids { lp.custom_extensions.push(ext(&[1, 2, 840, 113635, 100, 6, 11, 1])); }
        let leaf = lp.signed_by(&leaf_key, &inter, &inter_key).unwrap();
        Pki {
            root_der: root.der().to_vec(), inter_der: inter.der().to_vec(), leaf_der: leaf.der().to_vec(),
            leaf_key: { use p256::pkcs8::DecodePrivateKey; SigningKey::from_pkcs8_der(&leaf_key.serialize_der()).unwrap() },
        }
    }

    fn sign(p: &Pki, payload: &serde_json::Value, with_root: bool) -> String {
        let mut chain = vec![STANDARD.encode(&p.leaf_der), STANDARD.encode(&p.inter_der)];
        if with_root { chain.push(STANDARD.encode(&p.root_der)); }
        let h = URL_SAFE_NO_PAD.encode(serde_json::json!({ "alg": "ES256", "x5c": chain }).to_string());
        let b = URL_SAFE_NO_PAD.encode(payload.to_string());
        let sig: Signature = p.leaf_key.sign(format!("{h}.{b}").as_bytes());
        format!("{h}.{b}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    fn payload() -> serde_json::Value {
        serde_json::json!({ "bundleId": "eu.townwork.grid", "productId": "eu.townwork.grid.cloud.monthly", "originalTransactionId": "1000", "appAccountToken": "AAAAAAAA-0000-0000-0000-000000000001",
            "expiresDate": 1_900_000_000_000i64, "environment": "Production", "signedDate": crate::store::now() * 1000 })
    }

    #[test]
    fn accepts_a_correctly_signed_transaction() {
        let p = pki(true);
        let v = verify_jws(&sign(&p, &payload(), false), &p.root_der, true).unwrap();
        let t = transaction(&v, "eu.townwork.grid").unwrap();
        assert_eq!((t.product.as_str(), t.account.as_deref(), t.expires, t.revoked, t.sandbox), ("eu.townwork.grid.cloud.monthly", Some("aaaaaaaa-0000-0000-0000-000000000001"), Some(1_900_000_000), false, false));
        assert!(verify_jws(&sign(&p, &payload(), true), &p.root_der, true).is_ok()); // mit mitgeschickter Wurzel
        assert_eq!(transaction(&v, "andere.app").unwrap_err(), "Der Beleg gehört zu einer anderen App");
    }

    #[test]
    fn rejects_forgeries() {
        let p = pki(true);
        let jws = sign(&p, &payload(), false);
        // verfälschter Inhalt
        let mut parts: Vec<&str> = jws.split('.').collect();
        let forged = URL_SAFE_NO_PAD.encode(payload().to_string().replace("1900000000000", "9900000000000"));
        parts[1] = &forged;
        assert_eq!(verify_jws(&parts.join("."), &p.root_der, true).unwrap_err(), "Signatur falsch");
        // eine fremde Kette (eigene Wurzel statt Apples)
        let other = pki(true);
        assert!(verify_jws(&jws, &other.root_der, true).unwrap_err().contains("nicht von Apple signiert"));
        assert!(verify_jws(&jws, APPLE_ROOT_G3, true).is_err());
        // ohne Apples Kennzeichen an den Zertifikaten
        let plain = pki(false);
        assert!(verify_jws(&sign(&plain, &payload(), false), &plain.root_der, true).unwrap_err().contains("Kennzeichen"));
        assert!(verify_jws(&sign(&plain, &payload(), false), &plain.root_der, false).is_ok());
        // Müll
        assert!(verify_jws("a.b", &p.root_der, true).is_err());
        assert!(verify_jws("a.b.c", &p.root_der, true).is_err());
    }

    #[test]
    fn the_built_in_root_is_apples() {
        let (_, c) = X509Certificate::from_der(APPLE_ROOT_G3).unwrap();
        assert!(c.subject().to_string().contains("Apple Root CA - G3"));
        use sha2::{Digest, Sha256};
        let fp: String = Sha256::digest(APPLE_ROOT_G3).iter().map(|b| format!("{b:02X}")).collect();
        assert_eq!(fp, "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179");
    }
}
