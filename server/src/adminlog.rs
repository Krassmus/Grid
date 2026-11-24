//! Admin-Protokoll eines Dokuments: Kette signierter Einträge, aus der sich ergibt, wer Mitglied und wer Admin ist.
//! Der Server prüft jeden neuen Eintrag; Clients können dieselbe Prüfung selbst machen (src/adminLog.ts).
//! Aufbau und Regeln: docs/SYNC.md, Abschnitt „Besitz und Mitglieder“.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::auth::{hex, unhex};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub v: u8,
    pub doc: String,
    /// Laufende Nummer ab 1
    pub seq: u64,
    /// Hash des vorigen Eintrags (leer beim ersten)
    pub prev: String,
    /// `genesis`, `set` (Mitglied hinzufügen oder Rolle/Namen ändern), `remove`, Rechte (`group`, `ungroup`, `join-group`, `leave-group`, `grant`, docs/RIGHTS.md), `encrypt` (Dokument verschlüsseln, `subject` = `actor`) oder `move`
    /// (Umzug ankündigen: `name` = neue Server-Adresse, `subjectPub` = Schlüssel des neuen Servers, `subject` = `actor`)
    #[serde(rename = "type")]
    pub kind: String,
    /// Konto, das den Eintrag unterschreibt
    pub actor: String,
    pub subject: String,
    #[serde(rename = "subjectPub")]
    pub subject_pub: String,
    /// `admin` oder `member`
    pub role: String,
    pub name: String,
    pub time: i64,
    pub sig: String,
    /// Nummer des letzten Eintrags im Datenstrom des Dokuments, als der Server diesen Eintrag annahm (nicht unterschrieben).
    /// Wirkt von da an für alle Änderungen danach; so bewerten alle Clients dieselbe Änderung nach denselben Rechten (docs/RIGHTS.md).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}

impl Entry {
    /// Der unterschriebene Text.
    pub fn signing_text(&self) -> String {
        [
            "grid-admin-v1", &self.doc, &self.seq.to_string(), &self.prev, &self.kind, &self.actor,
            &self.subject, &self.subject_pub, &self.role, &self.name, &self.time.to_string(),
        ]
        .join("\n")
    }

    /// Hash für die Verkettung (über Text und Signatur).
    pub fn hash(&self) -> String {
        hex(&Sha256::digest(format!("{}\n{}", self.signing_text(), self.sig)))
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Member {
    #[serde(rename = "pub")]
    pub pubkey: String,
    pub role: String,
    pub name: String,
}

/// Mitglieder nach Abspielen der Kette.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub members: BTreeMap<String, Member>,
    /// Zuletzt angekündigter Umzug: (Server-Adresse, Server-Schlüssel)
    pub moved: Option<(String, String)>,
    /// Ein Admin hat das Dokument als Ende-zu-Ende-verschlüsselt festgelegt (Eintrag `encrypt`, docs/E2E.md)
    pub enc: bool,
    /// Gruppen (IDs); solange es eine gibt, gilt die Rechteverwaltung (docs/RIGHTS.md)
    pub groups: std::collections::BTreeSet<String>,
    /// Anzahl der Einträge und Hash des letzten
    pub len: u64,
    pub head: String,
}

impl State {
    pub fn role(&self, account: &str) -> Option<&str> { self.members.get(account).map(|m| m.role.as_str()) }
    fn admins(&self) -> usize { self.members.values().filter(|m| m.role == "admin").count() }

    /// Wendet einen Eintrag an oder erklärt, warum er nicht gilt.
    pub fn apply(&self, doc: &str, e: &Entry) -> Result<State, &'static str> {
        if e.v != 1 || e.doc != doc { return Err("Eintrag gehört nicht zu diesem Dokument"); }
        if e.seq != self.len + 1 { return Err("Nummer passt nicht"); }
        if e.prev != self.head { return Err("Verkettung passt nicht"); }
        if e.name.len() > 120 || e.name.contains('\n') { return Err("Name ungültig"); }
        if !matches!(e.role.as_str(), "admin" | "member") { return Err("Rolle ungültig"); }
        if !valid_id(&e.actor) || !valid_id(&e.subject) { return Err("Kennung ungültig"); }
        let pub_ok = |p: &str| p.len() == 64 && unhex(p).is_some();
        if !pub_ok(&e.subject_pub) { return Err("Schlüssel ungültig"); }

        let mut next = self.clone();
        let signer_pub = match e.kind.as_str() {
            "genesis" => {
                if self.len != 0 { return Err("Dokument hat schon einen Anfang"); }
                if e.actor != e.subject || e.role != "admin" { return Err("Der Anfang gehört dem Ersteller als Admin"); }
                next.members.insert(e.subject.clone(), Member { pubkey: e.subject_pub.clone(), role: "admin".into(), name: e.name.clone() });
                e.subject_pub.clone()
            }
            "set" | "remove" | "move" | "encrypt" | "group" | "ungroup" | "join-group" | "leave-group" | "grant" => {
                let actor = self.members.get(&e.actor).ok_or("Nur Mitglieder dürfen das")?;
                // Jedes Mitglied darf sich selbst entfernen (verlassen); alles andere dürfen nur Admins
                let leaving = e.kind == "remove" && e.subject == e.actor;
                if actor.role != "admin" && !leaving { return Err("Nur Admins dürfen das"); }
                if e.kind == "move" {
                    if e.subject != e.actor { return Err("Umzug: subject muss der Unterzeichner sein"); }
                    if !(e.name.starts_with("https://") || e.name.starts_with("http://")) { return Err("Umzug: Server-Adresse ungültig"); }
                    next.moved = Some((e.name.clone(), e.subject_pub.clone()));
                } else if e.kind == "encrypt" {
                    if e.subject != e.actor || e.subject_pub != actor.pubkey { return Err("Verschlüsseln: subject muss der Unterzeichner sein"); }
                    if self.enc { return Err("Das Dokument ist schon verschlüsselt"); }
                    next.enc = true;
                } else if matches!(e.kind.as_str(), "group" | "ungroup" | "join-group" | "leave-group" | "grant") {
                    // Rechte (docs/RIGHTS.md): der Server prüft nur Unterzeichner und Format. Die Gruppen selbst wertet der Client aus; Unstimmiges bewirkt dort nichts.
                    if actor.role != "admin" { return Err("Nur Admins dürfen das"); }
                    match e.kind.as_str() {
                        "group" => {
                            if e.role != "member" || e.subject_pub != "0".repeat(64) || e.name.trim().is_empty() { return Err("Gruppe ungültig"); }
                            next.groups.insert(e.subject.clone());
                        }
                        "ungroup" => { next.groups.remove(&e.subject); }
                        "join-group" | "leave-group" => { if !valid_id(&e.name) { return Err("Gruppe ungültig"); } }
                        "grant" => {
                            let ok = e.name.split_once('|').map_or(false, |(obj, level)| valid_id(obj) && matches!(level, "none" | "read" | "write"));
                            if !ok { return Err("Recht ungültig"); }
                        }
                        _ => {}
                    }
                } else if e.kind == "set" {
                    if let Some(old) = self.members.get(&e.subject) {
                        if old.pubkey != e.subject_pub { return Err("Schlüssel passt nicht zum Mitglied"); }
                    }
                    next.members.insert(e.subject.clone(), Member { pubkey: e.subject_pub.clone(), role: e.role.clone(), name: e.name.clone() });
                } else {
                    if next.members.remove(&e.subject).is_none() { return Err("Kein Mitglied"); }
                }
                if next.admins() == 0 { return Err("Es muss mindestens ein Admin bleiben"); }
                actor.pubkey.clone()
            }
            _ => return Err("Unbekannter Eintragstyp"),
        };

        let key: [u8; 32] = unhex(&signer_pub).and_then(|b| b.try_into().ok()).ok_or("Schlüssel ungültig")?;
        let key = VerifyingKey::from_bytes(&key).map_err(|_| "Schlüssel ungültig")?;
        let sig: [u8; 64] = unhex(&e.sig).and_then(|b| b.try_into().ok()).ok_or("Signatur ungültig")?;
        key.verify(e.signing_text().as_bytes(), &Signature::from_bytes(&sig)).map_err(|_| "Signatur falsch")?;

        next.len = e.seq;
        next.head = e.hash();
        Ok(next)
    }
}

pub fn valid_id(s: &str) -> bool { (8..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }

/// Spielt eine ganze Kette ab.
pub fn replay(doc: &str, entries: &[Entry]) -> Result<State, &'static str> {
    entries.iter().try_fold(State::default(), |s, e| s.apply(doc, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const DOC: &str = "d0c00000-0000-0000-0000-000000000001";

    struct Person { id: String, key: SigningKey }
    fn person(n: u8) -> Person { Person { id: format!("aaaaaaaa-0000-0000-0000-0000000000{n:02}"), key: SigningKey::from_bytes(&[n; 32]) } }
    impl Person { fn pubhex(&self) -> String { hex(&self.key.verifying_key().to_bytes()) } }

    fn entry(s: &State, signer: &Person, kind: &str, subject: &Person, role: &str, name: &str) -> Entry {
        let mut e = Entry {
            v: 1, doc: DOC.into(), seq: s.len + 1, prev: s.head.clone(), kind: kind.into(), actor: signer.id.clone(),
            subject: subject.id.clone(), subject_pub: subject.pubhex(), role: role.into(), name: name.into(), time: 1_700_000_000, sig: String::new(), at: None,
        };
        e.sig = hex(&signer.key.sign(e.signing_text().as_bytes()).to_bytes());
        e
    }

    #[test]
    fn chain_of_admins_and_members() {
        let (a, b, c) = (person(1), person(2), person(3));
        let s0 = State::default();
        let s1 = s0.apply(DOC, &entry(&s0, &a, "genesis", &a, "admin", "Anna")).unwrap();
        let s2 = s1.apply(DOC, &entry(&s1, &a, "set", &b, "member", "Ben")).unwrap();
        assert_eq!(s2.role(&b.id), Some("member"));
        // Mitglieder dürfen nichts ändern
        assert!(s2.apply(DOC, &entry(&s2, &b, "set", &c, "member", "Cora")).is_err());
        // Admin befördert Ben, der darf dann Cora hinzufügen
        let s3 = s2.apply(DOC, &entry(&s2, &a, "set", &b, "admin", "Ben")).unwrap();
        let s4 = s3.apply(DOC, &entry(&s3, &b, "set", &c, "member", "Cora")).unwrap();
        assert_eq!(s4.members.len(), 3);
        // Entfernen, aber nie den letzten Admin
        let s5 = s4.apply(DOC, &entry(&s4, &b, "remove", &a, "admin", "")).unwrap();
        assert!(s5.apply(DOC, &entry(&s5, &b, "remove", &b, "admin", "")).is_err());
        assert!(s5.apply(DOC, &entry(&s5, &a, "set", &c, "member", "x")).is_err(), "Entfernte dürfen nichts mehr");
        // Wiedergabe der ganzen Kette ergibt denselben Stand
        let all = vec![
            entry(&s0, &a, "genesis", &a, "admin", "Anna"),
        ];
        assert_eq!(replay(DOC, &all).unwrap().len, 1);
    }

    #[test]
    fn rejects_forgery_and_broken_chain() {
        let (a, b) = (person(1), person(2));
        let s0 = State::default();
        let g = entry(&s0, &a, "genesis", &a, "admin", "Anna");
        let s1 = s0.apply(DOC, &g).unwrap();
        // Genesis nur einmal, nur vom Ersteller selbst
        assert!(s1.apply(DOC, &entry(&s0, &b, "genesis", &b, "admin", "Ben")).is_err());
        assert!(s0.apply(DOC, &entry(&s0, &a, "genesis", &b, "admin", "Ben")).is_err());
        // Verfälschter Inhalt: Signatur passt nicht mehr
        let mut forged = entry(&s1, &a, "set", &b, "member", "Ben");
        forged.role = "admin".into();
        assert_eq!(s1.apply(DOC, &forged), Err("Signatur falsch"));
        // Falsche Unterschrift (Ben gibt sich als Anna aus)
        let mut fake = entry(&s1, &b, "set", &b, "admin", "Ben");
        fake.actor = a.id.clone();
        fake.sig = hex(&b.key.sign(fake.signing_text().as_bytes()).to_bytes());
        assert_eq!(s1.apply(DOC, &fake), Err("Signatur falsch"));
        // Verkettung und Nummer
        let mut skip = entry(&s1, &a, "set", &b, "member", "Ben");
        skip.prev = "x".into();
        assert!(s1.apply(DOC, &skip).is_err());
        assert!(s1.apply("anderes-dokument-id", &entry(&s1, &a, "set", &b, "member", "Ben")).is_err());
        // Schlüssel eines Mitglieds lässt sich nicht austauschen
        let s2 = s1.apply(DOC, &entry(&s1, &a, "set", &b, "member", "Ben")).unwrap();
        let mut swap = entry(&s2, &a, "set", &b, "member", "Ben");
        swap.subject_pub = person(9).pubhex();
        swap.sig = hex(&a.key.sign(swap.signing_text().as_bytes()).to_bytes());
        assert_eq!(s2.apply(DOC, &swap), Err("Schlüssel passt nicht zum Mitglied"));
    }

    #[test]
    fn move_entries_announce_a_new_server_without_changing_members() {
        let (a, b) = (person(1), person(2));
        let s0 = State::default();
        let s1 = s0.apply(DOC, &entry(&s0, &a, "genesis", &a, "admin", "Anna")).unwrap();
        let s2 = s1.apply(DOC, &entry(&s1, &a, "set", &b, "member", "Ben")).unwrap();
        let mut mv = entry(&s2, &a, "move", &a, "admin", "https://neu.example/grid");
        mv.subject_pub = person(9).pubhex(); // Schlüssel des neuen Servers
        mv.sig = hex(&a.key.sign(mv.signing_text().as_bytes()).to_bytes());
        let s3 = s2.apply(DOC, &mv).unwrap();
        assert_eq!(s3.moved, Some(("https://neu.example/grid".into(), person(9).pubhex())));
        assert_eq!(s3.members, s2.members);
        // Mitglieder dürfen keinen Umzug ankündigen, und die Adresse muss eine Web-Adresse sein
        let mut by_member = entry(&s3, &b, "move", &b, "member", "https://evil.example");
        by_member.subject_pub = person(9).pubhex();
        by_member.sig = hex(&b.key.sign(by_member.signing_text().as_bytes()).to_bytes());
        assert_eq!(s3.apply(DOC, &by_member), Err("Nur Admins dürfen das"));
        let mut bad = entry(&s3, &a, "move", &a, "admin", "ftp://x");
        bad.subject_pub = person(9).pubhex();
        bad.sig = hex(&a.key.sign(bad.signing_text().as_bytes()).to_bytes());
        assert_eq!(s3.apply(DOC, &bad), Err("Umzug: Server-Adresse ungültig"));
    }

    #[test]
    fn group_entries_need_an_admin_and_valid_format() {
        let (a, b) = (person(1), person(2));
        let s0 = State::default();
        let s1 = s0.apply(DOC, &entry(&s0, &a, "genesis", &a, "admin", "Anna")).unwrap();
        let s2 = s1.apply(DOC, &entry(&s1, &a, "set", &b, "member", "Ben")).unwrap();
        let gid = Person { id: "gggggggg-0000-0000-0000-000000000001".into(), key: SigningKey::from_bytes(&[7; 32]) };
        let sign = |signer: &Person, mut e: Entry| { e.sig = hex(&signer.key.sign(e.signing_text().as_bytes()).to_bytes()); e };
        let mut group = entry(&s2, &a, "group", &gid, "member", "Redaktion");
        group.subject_pub = "0".repeat(64);
        let group = sign(&a, group);
        let s3 = s2.apply(DOC, &group).unwrap();
        assert!(s3.groups.contains(&gid.id));
        // Mitglieder dürfen keine Gruppen anlegen
        let mut by_member = entry(&s3, &b, "group", &gid, "member", "Hack");
        by_member.subject_pub = "0".repeat(64);
        assert_eq!(s3.apply(DOC, &sign(&b, by_member)), Err("Nur Admins dürfen das"));
        // Zuordnung und Recht: Format
        let join = entry(&s3, &a, "join-group", &b, "member", &gid.id);
        let s4 = s3.apply(DOC, &join).unwrap();
        assert_eq!(s4.members, s3.members);
        let mut bad_join = entry(&s4, &a, "join-group", &b, "member", "x");
        bad_join.sig = sign(&a, bad_join.clone()).sig;
        assert_eq!(s4.apply(DOC, &bad_join), Err("Gruppe ungültig"));
        let mut grant = entry(&s4, &a, "grant", &gid, "member", "tttttttt|write");
        grant.subject_pub = "0".repeat(64);
        assert!(s4.apply(DOC, &sign(&a, grant)).is_ok());
        let mut ungroup = entry(&s4, &a, "ungroup", &gid, "member", "");
        ungroup.subject_pub = "0".repeat(64);
        assert!(s4.apply(DOC, &sign(&a, ungroup)).unwrap().groups.is_empty());
        let mut bad_grant = entry(&s4, &a, "grant", &gid, "member", "tttttttt|admin");
        bad_grant.subject_pub = "0".repeat(64);
        assert_eq!(s4.apply(DOC, &sign(&a, bad_grant)), Err("Recht ungültig"));
        let mut empty = entry(&s4, &a, "group", &gid, "member", "  ");
        empty.subject_pub = "0".repeat(64);
        assert_eq!(s4.apply(DOC, &sign(&a, empty)), Err("Gruppe ungültig"));
    }

    /// Dieselben Werte prüft src/adminLog.test.ts: beide Seiten müssen dieselbe Signatur und denselben Hash erzeugen.
    #[test]
    fn known_vector() {
        let a = person(1);
        let e = entry(&State::default(), &a, "genesis", &a, "admin", "Anna");
        assert_eq!(e.sig, "6e8b04c65ba83556eb4d627cda89d4f63bc14418feb4c6f1a5b0e676f0c0dbcddcf4aacf444d6bd5c45595cf2981efb295162c1c38adb01acebbe549bcfd190b");
        assert_eq!(e.hash(), "dcda78d27c72cca9a6ea023cb83a5ff3fbf6da46b6346f62c65878ddc6d5c9d3");
    }
}
