#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN=""
EMAIL=""
SKIP_CERTBOT="false"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="/opt/neurum-renal"
APP_DIR="${INSTALL_ROOT}/app"
VENV_DIR="${INSTALL_ROOT}/venv"
ENV_FILE="/etc/neurum-renal.env"

usage() {
  echo "Uso: sudo bash deploy/install_aws_ubuntu.sh --domain renal.ejemplo.com --email admin@ejemplo.com [--skip-certbot]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --skip-certbot) SKIP_CERTBOT="true"; shift ;;
    *) usage; exit 2 ;;
  esac
done

if [[ "$EUID" -ne 0 ]]; then
  echo "Ejecuta este instalador con sudo."
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || [[ "$DOMAIN" != *.* ]]; then
  echo "Dominio no valido."
  usage
  exit 2
fi
if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Correo no valido."
  usage
  exit 2
fi
if [[ ! -f "${SOURCE_DIR}/run.py" ]]; then
  echo "No se encontro run.py en ${SOURCE_DIR}."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-venv python3-pip rsync nginx certbot python3-certbot-nginx awscli curl openssl

if ! id neurum-renal >/dev/null 2>&1; then
  useradd --system --home "$INSTALL_ROOT" --shell /usr/sbin/nologin neurum-renal
fi

install -d -o root -g neurum-renal -m 0750 "$INSTALL_ROOT" "$APP_DIR"
install -d -o neurum-renal -g neurum-renal -m 0700 /var/lib/neurum-renal /var/backups/neurum-renal

rsync -a --delete \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.venv/' \
  --exclude 'data/' \
  --exclude 'backups/' \
  --exclude '__pycache__/' \
  "$SOURCE_DIR/" "$APP_DIR/"

python3 -m venv "$VENV_DIR"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip
"${VENV_DIR}/bin/python" -m pip install -r "${APP_DIR}/requirements.txt"
(
  cd "$APP_DIR"
  "${VENV_DIR}/bin/python" -m unittest discover -s tests -v
)

chown -R root:neurum-renal "$APP_DIR" "$VENV_DIR"
find "$APP_DIR" -type d -exec chmod 0750 {} +
find "$APP_DIR" -type f -exec chmod 0640 {} +
chmod 0750 "${APP_DIR}/deploy/"*.sh

CREATED_ENV="false"
if [[ ! -f "$ENV_FILE" ]]; then
  ADMIN_PASSWORD="Aa1!$(openssl rand -hex 12)"
  umask 0077
  cat > "$ENV_FILE" <<EOF
RENAL_HOST=127.0.0.1
RENAL_PORT=8780
RENAL_ADMIN_EMAIL=${EMAIL}
RENAL_ADMIN_PASSWORD=${ADMIN_PASSWORD}
RENAL_COOKIE_SECURE=true
RENAL_TRUST_PROXY=true
RENAL_SESSION_HOURS=8
RENAL_MAX_BODY_MB=100
RENAL_CAC_FILE_MB=35
RENAL_DATA_DIR=/var/lib/neurum-renal
RENAL_BACKUP_DIR=/var/backups/neurum-renal
RENAL_S3_BUCKET=
RENAL_S3_PREFIX=produccion
RENAL_S3_KMS_KEY_ID=
EOF
  chmod 0600 "$ENV_FILE"
  CREATED_ENV="true"
fi

install -m 0644 "${APP_DIR}/deploy/neurum-renal.service" /etc/systemd/system/neurum-renal.service
install -m 0644 "${APP_DIR}/deploy/neurum-renal-backup.service" /etc/systemd/system/neurum-renal-backup.service
install -m 0644 "${APP_DIR}/deploy/neurum-renal-backup.timer" /etc/systemd/system/neurum-renal-backup.timer

sed "s/__DOMAIN__/${DOMAIN}/g" "${APP_DIR}/deploy/nginx-neurum-renal.conf" > /etc/nginx/sites-available/neurum-renal
ln -sfn /etc/nginx/sites-available/neurum-renal /etc/nginx/sites-enabled/neurum-renal
rm -f /etc/nginx/sites-enabled/default
nginx -t

systemctl daemon-reload
systemctl enable --now neurum-renal.service
systemctl enable --now neurum-renal-backup.timer
systemctl reload nginx

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8780/api/health >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:8780/api/health >/dev/null

if [[ "$SKIP_CERTBOT" != "true" ]]; then
  certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" -d "$DOMAIN"
fi

echo
echo "Aplicacion instalada en https://${DOMAIN}/"
echo "Puerto 8780: solo local; no debe abrirse en el Security Group."
if [[ "$CREATED_ENV" == "true" ]]; then
  echo "Usuario administrador: ${EMAIL}"
  echo "Contrasena temporal: ${ADMIN_PASSWORD}"
  echo "Guardala ahora. La aplicacion exigira cambiarla en el primer ingreso."
else
  echo "Se conservo la configuracion existente en ${ENV_FILE}."
fi
