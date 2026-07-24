#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="${RENAL_ENV_FILE:-/etc/neurum-renal.env}"
if [[ -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${RENAL_S3_BUCKET:-}" ]]; then
  exit 0
fi

BACKUP_DIR="${RENAL_BACKUP_DIR:-/var/backups/neurum-renal}"
PREFIX="${RENAL_S3_PREFIX:-produccion}"
S3_ARGS=(s3 sync "$BACKUP_DIR/" "s3://${RENAL_S3_BUCKET}/${PREFIX}/" --only-show-errors)

if [[ -n "${RENAL_S3_KMS_KEY_ID:-}" ]]; then
  S3_ARGS+=(--sse aws:kms --sse-kms-key-id "$RENAL_S3_KMS_KEY_ID")
else
  S3_ARGS+=(--sse AES256)
fi

aws "${S3_ARGS[@]}"

CAC_DIR="${RENAL_CAC_DIR:-${RENAL_DATA_DIR:-/var/lib/neurum-renal}/cac_jobs}"
if [[ -d "$CAC_DIR" ]]; then
  CAC_ARGS=(s3 sync "$CAC_DIR/" "s3://${RENAL_S3_BUCKET}/${PREFIX}/cac_jobs/" --only-show-errors)
  if [[ -n "${RENAL_S3_KMS_KEY_ID:-}" ]]; then
    CAC_ARGS+=(--sse aws:kms --sse-kms-key-id "$RENAL_S3_KMS_KEY_ID")
  else
    CAC_ARGS+=(--sse AES256)
  fi
  aws "${CAC_ARGS[@]}"
fi
