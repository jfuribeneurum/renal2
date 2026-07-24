#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_DIR="${1:-/opt/neurum-renal/repository}"
APP_DIR="/opt/neurum-renal/app"
VENV_DIR="/opt/neurum-renal/venv"

if [[ "$EUID" -ne 0 ]]; then
  echo "Ejecuta la actualizacion con sudo."
  exit 1
fi
if [[ ! -d "${REPOSITORY_DIR}/.git" ]]; then
  echo "No se encontro un repositorio Git en ${REPOSITORY_DIR}."
  exit 1
fi

REPOSITORY_OWNER="$(stat -c '%U' "$REPOSITORY_DIR")"
if [[ "$REPOSITORY_OWNER" == "root" ]]; then
  git -C "$REPOSITORY_DIR" pull --ff-only
else
  runuser -u "$REPOSITORY_OWNER" -- git -C "$REPOSITORY_DIR" pull --ff-only
fi
(
  cd "$REPOSITORY_DIR"
  "${VENV_DIR}/bin/python" -m unittest discover -s tests -v
)

rsync -a --delete \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.venv/' \
  --exclude 'data/' \
  --exclude 'backups/' \
  --exclude '__pycache__/' \
  "${REPOSITORY_DIR}/" "$APP_DIR/"

"${VENV_DIR}/bin/python" -m pip install -r "${APP_DIR}/requirements.txt"
chown -R root:neurum-renal "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0750 {} +
find "$APP_DIR" -type f -exec chmod 0640 {} +
chmod 0750 "${APP_DIR}/deploy/"*.sh

install -m 0644 "${APP_DIR}/deploy/neurum-renal.service" /etc/systemd/system/neurum-renal.service
install -m 0644 "${APP_DIR}/deploy/neurum-renal-backup.service" /etc/systemd/system/neurum-renal-backup.service
install -m 0644 "${APP_DIR}/deploy/neurum-renal-backup.timer" /etc/systemd/system/neurum-renal-backup.timer
systemctl daemon-reload
systemctl restart neurum-renal.service
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8780/api/health >/dev/null; then
    echo "Actualizacion aplicada correctamente."
    exit 0
  fi
  sleep 1
done

echo "La aplicacion no respondio despues de la actualizacion."
systemctl status neurum-renal.service --no-pager
exit 1
