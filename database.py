from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import shutil
import sqlite3
import string
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("RENAL_DATA_DIR", BASE_DIR / "data"))
BACKUP_DIR = Path(os.getenv("RENAL_BACKUP_DIR", BASE_DIR / "backups"))
DB_PATH = Path(os.getenv("RENAL_DB_PATH", DATA_DIR / "renal_shared.sqlite3"))
PBKDF2_ITERATIONS = 600_000
ROLES = {"admin", "clinico", "gestor", "auditor"}


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        try:
            return bool(super().__exit__(exc_type, exc_value, traceback))
        finally:
            self.close()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        DATA_DIR.chmod(0o700)
        DB_PATH.parent.chmod(0o700)
    except OSError:
        pass
    conn = sqlite3.connect(DB_PATH, timeout=30, factory=ClosingConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        DB_PATH.chmod(0o600)
    except OSError:
        pass
    return conn


SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','clinico','gestor','auditor')),
      password_salt BLOB NOT NULL,
      password_hash BLOB NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      doc_type TEXT,
      document TEXT NOT NULL,
      name TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL,
      source TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS labs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_key TEXT NOT NULL UNIQUE,
      patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      lab_type TEXT NOT NULL,
      result_date TEXT,
      value_text TEXT,
      source TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      patient_id TEXT REFERENCES patients(id),
      title TEXT NOT NULL,
      exam_type TEXT,
      priority TEXT NOT NULL CHECK (priority IN ('critica','alta','media','baja')),
      status TEXT NOT NULL CHECK (status IN ('pendiente','en_gestion','programada','completada','cancelada')),
      due_date TEXT,
      assigned_to TEXT REFERENCES users(id),
      created_by TEXT NOT NULL REFERENCES users(id),
      closed_by TEXT REFERENCES users(id),
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      actor_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      ip_address TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY,
      import_type TEXT NOT NULL,
      file_name TEXT,
      record_count INTEGER NOT NULL,
      lab_count INTEGER NOT NULL DEFAULT 0,
      imported_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS cac_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('creado','cargando','procesando','completado','error')),
      cutoff_date TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      consultations_name TEXT,
      consultations_path TEXT,
      output_xlsx_path TEXT,
      output_txt_path TEXT,
      summary_json TEXT,
      error_message TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS cac_supports (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES cac_jobs(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      document TEXT,
      doc_type TEXT,
      attention_date TEXT,
      specialty TEXT,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE(job_id, sha256)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_labs_patient_date ON labs(patient_id, result_date)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status)",
    "CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_cac_jobs_created ON cac_jobs(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_cac_supports_job ON cac_supports(job_id, document, attention_date)",
]


def password_hash(password: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
    salt = salt or secrets.token_bytes(24)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return salt, digest


def verify_password(password: str, salt: bytes, expected: bytes) -> bool:
    _, actual = password_hash(password, salt)
    return hmac.compare_digest(actual, expected)


def generate_password(length: int = 18) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def initialize() -> dict[str, str] | None:
    with connect() as conn:
        for statement in SCHEMA:
            conn.execute(statement)
        admin = conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        if admin:
            return None
        email = os.getenv("RENAL_ADMIN_EMAIL", "admin@neurum.local").strip().lower()
        temporary_password = os.getenv("RENAL_ADMIN_PASSWORD") or generate_password()
        salt, digest = password_hash(temporary_password)
        now = utc_now()
        conn.execute(
            """INSERT INTO users
               (id,email,full_name,role,password_salt,password_hash,active,must_change_password,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (new_id(), email, "Administrador Neurum", "admin", salt, digest, 1, 1, now, now),
        )
        return {"email": email, "password": temporary_password}


def row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def audit(
    conn: sqlite3.Connection,
    actor_id: str | None,
    action: str,
    entity_type: str,
    entity_id: str | None,
    ip_address: str | None,
    details: dict[str, Any] | None = None,
) -> None:
    conn.execute(
        """INSERT INTO audit_log
           (actor_id,action,entity_type,entity_id,ip_address,details_json,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (actor_id, action, entity_type, entity_id, ip_address, json.dumps(details or {}, ensure_ascii=True), utc_now()),
    )


def create_backup(reason: str = "manual") -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    try:
        BACKUP_DIR.chmod(0o700)
    except OSError:
        pass
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = BACKUP_DIR / f"renal_shared_{stamp}_{reason}.sqlite3"
    source = connect()
    target = sqlite3.connect(destination)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    try:
        destination.chmod(0o600)
    except OSError:
        pass
    return destination


def maybe_daily_backup() -> Path | None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backups = sorted(BACKUP_DIR.glob("renal_shared_*.sqlite3"), key=lambda p: p.stat().st_mtime, reverse=True)
    if backups:
        age = datetime.now(timezone.utc) - datetime.fromtimestamp(backups[0].stat().st_mtime, timezone.utc)
        if age < timedelta(hours=24):
            return None
    if DB_PATH.exists():
        return create_backup("automatico")
    return None


def prune_sessions() -> None:
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (utc_now(),))


def list_backups() -> list[dict[str, Any]]:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    return [
        {
            "name": path.name,
            "size": path.stat().st_size,
            "created_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
        }
        for path in sorted(BACKUP_DIR.glob("renal_shared_*.sqlite3"), key=lambda p: p.stat().st_mtime, reverse=True)
    ]
