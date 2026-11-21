# Grid-Server im Firmennetz

Ein eigener Server für Dokumente, die das Firmennetz nicht verlassen sollen. Es ist dieselbe Server-Software wie bei
townwork.eu, nur ohne Abo-Pflicht. Grid-Dokumente zeigen auf den Server, zu dem sie gehören; Konten sind dieselben wie
sonst (Schlüsselpaar auf dem Gerät), brauchen aber auf jedem Server eine Freigabe.

## Mit Docker (empfohlen)

Voraussetzung: Docker mit Compose auf einem Rechner im Firmennetz, der unter einem Namen erreichbar ist (z. B. `grid.firma.intern`).

```bash
cd deploy
GRID_HOST=grid.firma.intern GRID_NAME="Firmenserver" docker compose up -d
```

Das startet den Grid-Server (Daten im Volume `grid-data`) und Caddy, der HTTPS davorsetzt. In Grid trägst du
`https://grid.firma.intern` als Server ein.

### Zertifikat

Grid verbindet sich nur sicher, deshalb braucht der Server ein Zertifikat, dem die Rechner vertrauen.

- **Eigene Zertifizierungsstelle von Caddy (Standard in `Caddyfile`):** Das Stammzertifikat liegt im Container und muss auf
  den Arbeitsplätzen als vertrauenswürdig eingetragen werden:
  ```bash
  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./grid-root.crt
  ```
  (unter macOS im Schlüsselbund, unter Windows im Zertifikatsspeicher „Vertrauenswürdige Stammzertifizierungsstellen“ importieren).
- **Firmen-PKI:** Zertifikat und Schlüssel bereitstellen und im `Caddyfile` die Zeile `tls internal` ersetzen (Kommentar dort).

### Konten freigeben

Neue Konten warten auf deine Freigabe (Grid zeigt den Benutzern dabei ihre Kennung):

```bash
docker compose exec grid grid-server accounts list --data /data
docker compose exec grid grid-server accounts approve <Anfang-der-Kennung> --data /data
```

Soll sich jeder im Firmennetz selbst anmelden dürfen, starte mit `GRID_OPEN_REGISTRATION=1`.

### Sichern und Aktualisieren

Alles liegt in der SQLite-Datei im Volume `grid-data` (`/data/grid.db`):

```bash
docker compose exec grid sh -c 'cp /data/grid.db /data/backup.db'   # Kopie im Volume
docker compose cp grid:/data/grid.db ./grid-backup.db               # auf den Rechner holen
git pull && docker compose build && docker compose up -d            # Aktualisieren
```

## Ohne Docker

`server/README.md` beschreibt Bauen, systemd-Dienst und Apache. Für das Firmennetz zusätzlich `--open-registration`
weglassen (Konten einzeln freigeben) und einen Reverse-Proxy mit HTTPS davorsetzen.

## Dokumente zwischen Servern bewegen

In Grid unter „Cloud-Synchronisation → Server wechseln …“. Das Dokument samt Mitgliedern und Rollen wird auf den neuen Server
kopiert; die Mitglieder verbinden sich dort selbst (mit ihrem Konto, das der neue Server freigeben muss). Der alte Server
behält seine Kopie, bis du sie dort entfernst.

## Server-Schlüssel

Jeder Server hat einen eigenen Schlüssel, den Grid beim ersten Verbinden merkt (und in die Dokumentdatei und in
Einladungen schreibt). Ändert sich der Schlüssel unter derselben Adresse, warnt Grid. Das passiert nach einer
Neuinstallation ohne gesichertes Volume – oder wenn jemand einen falschen Server untergeschoben hat. Sichere also das Volume,
und vergleiche bei einer Warnung den im Dialog gezeigten Server-Schlüssel mit dem, den dir der Betreiber nennt.
