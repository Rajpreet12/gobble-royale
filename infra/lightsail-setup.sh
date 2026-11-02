#!/bin/bash
# Gobble Royale on one $5 Lightsail server. Runs once, on first boot, as the instance's launch script.
# __HOST__ and __SOURCE_URL__ are filled in by whoever launches the server (see README).
#   Caddy   : HTTPS on 443 with a free Let's Encrypt certificate, WebSockets passed straight through
#   Node 22 : the game on 127.0.0.1:8080, scores in /var/lib/gobble/scores.json
# Lightsail runs launch scripts with /bin/sh (not bash), so this file sticks to plain sh.
set -eux
exec > /var/log/gobble-setup.log 2>&1

HOST="__HOST__"
SOURCE_URL="__SOURCE_URL__"

# 512 MB of RAM is plenty for the game; the swap is only a cushion for npm during install.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y caddy unzip curl xz-utils

# Node 22 from nodejs.org, checked against the published checksum
cd /tmp
NODE_TGZ=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/linux-x64\.tar\.xz$/ {print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$NODE_TGZ"
curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep " $NODE_TGZ\$" | sha256sum -c -
tar -xJf "$NODE_TGZ" -C /usr/local --strip-components=1

# The updater: also used later to ship a new version (sudo gobble-update '<zip url>')
cat > /usr/local/bin/gobble-update <<'EOF'
#!/bin/bash
set -euo pipefail
URL="$1"
TMP=$(mktemp -d)
curl -fsSL "$URL" -o "$TMP/source.zip"
rm -rf /opt/gobble.next && mkdir -p /opt/gobble.next
unzip -q "$TMP/source.zip" -d /opt/gobble.next
cd /opt/gobble.next && npm ci --omit=dev --no-audit --no-fund
rm -rf /opt/gobble.prev && { [ -d /opt/gobble ] && mv /opt/gobble /opt/gobble.prev || true; }
mv /opt/gobble.next /opt/gobble
systemctl restart gobble
rm -rf "$TMP"
echo "Gobble Royale updated"
EOF
chmod 755 /usr/local/bin/gobble-update

id gobble >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin gobble

cat > /etc/systemd/system/gobble.service <<'EOF'
[Unit]
Description=Gobble Royale
After=network-online.target

[Service]
User=gobble
WorkingDirectory=/opt/gobble
Environment=PORT=8080 LISTEN_HOST=127.0.0.1 NODE_ENV=production SCORES_FILE=/var/lib/gobble/scores.json
ExecStart=/usr/local/bin/node src/index.mjs
Restart=always
RestartSec=2
StateDirectory=gobble
MemoryMax=350M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable gobble
/usr/local/bin/gobble-update "$SOURCE_URL"

# Same as infra/Caddyfile. The quoted 'EOF' keeps the shell from touching the backticks in it;
# __HOST__ was already replaced when this script was filled in.
cat > /etc/caddy/Caddyfile <<'EOF'
__HOST__ {
	encode gzip
	reverse_proxy 127.0.0.1:8080

	# When the game is down, a friendly page that retries every 10 seconds (still a 503).
	handle_errors {
		header Content-Type "text/html; charset=utf-8"
		header Cache-Control "no-store"
		header Retry-After "10"
		respond `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Gobble Royale is restarting</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#2b1a0e;color:#fff3e0;font-family:system-ui,sans-serif;text-align:center;padding:16px}h1{color:#ff8a2a;margin:.2em 0}p{color:#d1b393}</style></head>
<body><div><div style="font-size:64px">🦃</div><h1>The farm is restarting</h1><p>The turkeys will be back in a moment. This page tries again every 10 seconds.</p></div></body></html>` 503
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl restart caddy
echo "Setup finished"
