# Grid-Server

Gleicht Grid-Dokumente zwischen Geräten ab (Protokoll: `docs/SYNC.md`). Eine Datei, eine SQLite-Datenbank.

## Bauen und starten

```bash
cd server
cargo build --release
./target/release/grid-server --listen 127.0.0.1:8787 --data /var/lib/grid
```

Optionen auch als `GRID_LISTEN` und `GRID_DATA`. Test: `cargo test`.

## Konten

Grid meldet sich mit dem Konto des Benutzers an (Schlüsselpaar, kein Passwort). Ein neues Konto **wartet**, bis du es freigibst:

```bash
grid-server accounts list --data /var/lib/grid                 # zeigt wartende und freigegebene Konten
grid-server accounts approve 6366823a --data /var/lib/grid     # Anfang der Kennung genügt
grid-server accounts remove 6366823a --data /var/lib/grid
```

Die Kennung zeigt Grid im Dialog „Cloud-Synchronisation“ an, solange das Konto wartet. Im eigenen Netz kannst du den Server mit `--open-registration` starten, dann werden neue Konten sofort freigegeben.
Die Befehle arbeiten direkt auf der Datenbank und gehen auch bei laufendem Server (als Benutzer `grid`, falls die Datei ihm gehört: `sudo -u grid …`).

**Umstellung vom alten Zugangsschlüssel:** `GRID_TOKEN` gibt es nicht mehr. Die Zeile `Environment=GRID_TOKEN=…` in der Service-Datei kann gelöscht werden. Bereits vorhandene Dokumente gehören dem ersten Konto, das sie öffnet.

## Abo und Speicher (Cloud)

Ohne weitere Angaben ist der Server frei nutzbar (Intranet). Für die Cloud schaltest du die Abo-Pflicht ein:

```bash
grid-server --billing --open-registration --listen 127.0.0.1:8787 --data /var/lib/grid
```

Dann dürfen nur Konten mit laufendem Abo schreiben (Lesen geht immer); Mitglieder eines Dokuments schreiben auf Kosten eines zahlenden Admins. Abo setzen und prüfen:

```bash
grid-server accounts plan 6366823a paid --until 2027-12-31 --quota 5GB --data /var/lib/grid
grid-server accounts plan 6366823a free --data /var/lib/grid
grid-server accounts list --data /var/lib/grid        # zeigt auch das Abo
```

Weitere Umgebungsvariablen: `GRID_NAME` (Anzeigename), `GRID_BILLING=1` (wie `--billing`), `GRID_ADMIN_KEY` (mindestens 16 Zeichen; schaltet die HTTP-Verwaltung `/admin/…` für einen Webshop ein), `GRID_MANAGE_URL` (Adresse, die Grid als „Abo verwalten“ anzeigt). Hintergrund und Pläne für Zahlung: `docs/SYNC.md`, Abschnitt 4.

## Hinter Apache (townwork.eu)

Der Server lauscht nur lokal; Apache nimmt HTTPS entgegen und leitet unter `/grid/` weiter (WebSocket eingeschlossen).

```bash
a2enmod proxy proxy_http proxy_wstunnel rewrite headers
```

Im VirtualHost von townwork.eu (Port 443):

```apache
# Grid-Sync: WebSocket und HTTP
RewriteEngine On
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteRule ^/grid/(.*)$ ws://127.0.0.1:8787/$1 [P,L]
ProxyPass        /grid/ http://127.0.0.1:8787/ timeout=300
ProxyPassReverse /grid/ http://127.0.0.1:8787/
# große Dateien
LimitRequestBody 268435456
```

In Grid ist die Server-Adresse dann `https://townwork.eu/grid`.

## Als Dienst (systemd)

```ini
[Unit]
Description=Grid-Server
After=network.target

[Service]
ExecStart=/opt/grid/grid-server --listen 127.0.0.1:8787 --data /var/lib/grid
User=grid
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
