# Grid-Server

Gleicht Grid-Dokumente zwischen Geräten ab (Protokoll: `docs/SYNC.md`). Eine Datei, eine SQLite-Datenbank.

## Bauen und starten

```bash
cd server
cargo build --release
GRID_TOKEN="$(openssl rand -hex 24)" ./target/release/grid-server --listen 127.0.0.1:8787 --data /var/lib/grid
```

`GRID_TOKEN` ist der Zugangsschlüssel (Zwischenstand, bis Konten kommen); er wird in Grid beim Verbinden eingetragen.
Optionen auch als `GRID_LISTEN` und `GRID_DATA`. Test: `cargo test`.

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
Environment=GRID_TOKEN=HIER-DEN-SCHLUESSEL-EINTRAGEN
User=grid
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
