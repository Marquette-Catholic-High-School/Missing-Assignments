#!/usr/bin/env bash
# Install Missing Assignment Slips on a fresh Ubuntu server (22.04 or 24.04).
#
# Usage (run from inside the app folder you copied to the server):
#   sudo bash install.sh
#
# Optional: HTTPS with a Let's Encrypt certificate. Point your domain's DNS
# at this server first, then:
#   sudo DOMAIN=slips.example.org EMAIL=you@example.org bash install.sh
#
# What it does:
#   - installs Node.js 22 LTS and nginx
#   - copies this folder to /opt/missing-assignment-slips
#   - runs the app as a locked-down systemd service on 127.0.0.1:3000
#   - serves it through nginx on port 80 (and 443 if DOMAIN is set)
#   - opens ports 22/80/443 in ufw if ufw is installed
#
# Re-running the script is safe: it updates the code and restarts the service.

set -euo pipefail

APP_NAME="missing-assignment-slips"
APP_DIR="/opt/${APP_NAME}"
APP_USER="slips"
APP_PORT="3000"
NODE_MAJOR="22"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash install.sh" >&2
  exit 1
fi

for f in server.js package.json "PDF Slip template.pdf" public/index.html; do
  if [[ ! -e "${SRC_DIR}/${f}" ]]; then
    echo "Missing ${f} next to install.sh. Run this script from inside the app folder." >&2
    exit 1
  fi
done

if [[ -n "$DOMAIN" && -z "$EMAIL" ]]; then
  echo "EMAIL is required with DOMAIN (Let's Encrypt needs a contact address)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing system packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg nginx rsync

echo "==> Installing Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> Creating service user ${APP_USER}"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> Copying app to ${APP_DIR}"
install -d "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude install.sh \
  "${SRC_DIR}/" "${APP_DIR}/"

echo "==> Installing npm dependencies"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error
chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"
chmod -R o-rwx "$APP_DIR"

echo "==> Writing systemd service"
cat > "/etc/systemd/system/${APP_NAME}.service" <<UNIT
[Unit]
Description=Missing Assignment Slips (CSV to PDF)
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=3

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${APP_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$APP_NAME"
systemctl restart "$APP_NAME"

echo "==> Configuring nginx"
SERVER_NAME="${DOMAIN:-_}"
cat > "/etc/nginx/sites-available/${APP_NAME}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
ln -sf "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if command -v ufw >/dev/null 2>&1; then
  echo "==> Opening firewall ports"
  ufw allow OpenSSH >/dev/null || true
  ufw allow 'Nginx Full' >/dev/null || true
fi

if [[ -n "$DOMAIN" ]]; then
  echo "==> Requesting HTTPS certificate for ${DOMAIN}"
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx --non-interactive --agree-tos --redirect \
    -m "$EMAIL" -d "$DOMAIN"
fi

echo
echo "==> Checking the service"
sleep 2
if curl -fsS -o /dev/null "http://127.0.0.1:${APP_PORT}/"; then
  echo "    App is responding."
else
  echo "    App is NOT responding. Check: journalctl -u ${APP_NAME} -e" >&2
  exit 1
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Done."
if [[ -n "$DOMAIN" ]]; then
  echo "  Open: https://${DOMAIN}"
else
  echo "  Open: http://${IP:-<server-ip>}"
fi
echo "  Logs:    journalctl -u ${APP_NAME} -f"
echo "  Restart: systemctl restart ${APP_NAME}"
echo "  Update:  copy new files here and re-run: sudo bash install.sh"
