from __future__ import annotations

import base64
import binascii
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from cac_transformer import ascii_text, process_cac_job, validate_settings
from database import (
    BACKUP_DIR,
    DATA_DIR,
    DB_PATH,
    ROLES,
    audit,
    connect,
    create_backup,
    initialize,
    list_backups,
    maybe_daily_backup,
    new_id,
    password_hash,
    prune_sessions,
    row_dict,
    utc_now,
    verify_password,
)


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CACHE_CONTROL_PRIVATE = "private, no-store"
CAC_DATA_DIR = Path(os.getenv("RENAL_CAC_DIR", DATA_DIR / "cac_jobs"))
SESSION_HOURS = int(os.getenv("RENAL_SESSION_HOURS", "8"))
COOKIE_SECURE = os.getenv("RENAL_COOKIE_SECURE", "false").lower() == "true"
MAX_BODY = int(os.getenv("RENAL_MAX_BODY_MB", "100")) * 1024 * 1024
MAX_CAC_FILE = int(os.getenv("RENAL_CAC_FILE_MB", "35")) * 1024 * 1024
TRUST_PROXY = os.getenv("RENAL_TRUST_PROXY", "false").lower() == "true"
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
LOGIN_LOCK = threading.Lock()
WRITE_ROLES = {"admin", "clinico", "gestor"}
EXAM_TASK_LABELS = {
    "creatinine": "creatinina",
    "albuminuria": "microalbuminuria/ACR",
    "hba1c": "HbA1c",
    "lipids": "perfil lipídico",
    "general": "paraclínicos",
}


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def safe_json(value: str | None) -> object:
    try:
        return json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}


def public_user(row: sqlite3.Row | dict | None) -> dict | None:
    if not row:
        return None
    data = dict(row)
    return {
        "id": data["id"],
        "email": data["email"],
        "full_name": data["full_name"],
        "role": data["role"],
        "active": bool(data["active"]),
        "must_change_password": bool(data.get("must_change_password", 0)),
        "created_at": data.get("created_at"),
    }


class RenalRequestHandler(BaseHTTPRequestHandler):
    server_version = "NeurumRenal/1.0"

    def log_message(self, format: str, *args: object) -> None:
        if os.getenv("RENAL_QUIET", "false").lower() != "true":
            super().log_message(format, *args)

    @property
    def ip_address(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() if TRUST_PROXY else ""
        return forwarded or self.client_address[0]

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if COOKIE_SECURE:
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        )
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/health":
            self.send_json({"status": "ok", "database": DB_PATH.name})
            return
        if path.startswith("/api/"):
            self.handle_api_get(path, query)
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        self.handle_api_write("POST")

    def do_PATCH(self) -> None:
        self.handle_api_write("PATCH")

    def do_DELETE(self) -> None:
        self.handle_api_write("DELETE")

    def send_json(self, payload: object, status: int = 200, cookie: str | None = None) -> None:
        data = json_text(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("El archivo supera el tamaño permitido por el servidor.")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Solicitud JSON no válida.") from exc
        if not isinstance(value, dict):
            raise ValueError("La solicitud debe ser un objeto JSON.")
        return value

    def session_token(self) -> str | None:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        return cookie.get("renal_session").value if cookie.get("renal_session") else None

    def authenticate(self) -> tuple[dict | None, str | None]:
        token = self.session_token()
        if not token:
            return None, None
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with connect() as conn:
            row = conn.execute(
                """SELECT u.*, s.csrf_token, s.expires_at
                   FROM sessions s JOIN users u ON u.id=s.user_id
                   WHERE s.token_hash=? AND s.expires_at>? AND u.active=1""",
                (token_hash, utc_now()),
            ).fetchone()
            if not row:
                return None, None
            conn.execute("UPDATE sessions SET last_seen_at=? WHERE token_hash=?", (utc_now(), token_hash))
            return public_user(row), row["csrf_token"]

    def require_user(self, allowed_roles: set[str] | None = None, csrf: bool = False) -> dict | None:
        user, expected_csrf = self.authenticate()
        if not user:
            self.error_json(HTTPStatus.UNAUTHORIZED, "Debes iniciar sesión.")
            return None
        if allowed_roles and user["role"] not in allowed_roles:
            self.error_json(HTTPStatus.FORBIDDEN, "Tu rol no permite realizar esta acción.")
            return None
        if csrf and not secrets.compare_digest(self.headers.get("X-CSRF-Token", ""), expected_csrf or ""):
            self.error_json(HTTPStatus.FORBIDDEN, "La sesión de seguridad no es válida. Actualiza la página.")
            return None
        return user

    def handle_api_get(self, path: str, query: dict[str, list[str]]) -> None:
        user = self.require_user()
        if not user:
            return
        if path == "/api/auth/me":
            _, csrf = self.authenticate()
            self.send_json({"user": user, "csrf_token": csrf, "permissions": self.permissions(user)})
            return
        if path == "/api/clinical/snapshot":
            self.get_clinical_snapshot()
            return
        if path == "/api/stats":
            self.get_stats(user)
            return
        if path == "/api/tasks":
            self.get_tasks(query, user)
            return
        if path.startswith("/api/tasks/") and path.endswith("/history"):
            task_id = path.split("/")[3]
            self.get_task_history(task_id)
            return
        if path == "/api/imports":
            self.get_imports()
            return
        if path == "/api/cac/jobs":
            self.get_cac_jobs()
            return
        cac_download = re.fullmatch(r"/api/cac/jobs/([^/]+)/download/(xlsx|txt)", path)
        if cac_download:
            self.download_cac_output(cac_download.group(1), cac_download.group(2))
            return
        cac_detail = re.fullmatch(r"/api/cac/jobs/([^/]+)", path)
        if cac_detail:
            self.get_cac_job(cac_detail.group(1))
            return
        if path == "/api/team":
            self.get_team()
            return
        if path == "/api/users":
            if not self.ensure_role(user, {"admin"}):
                return
            self.get_users()
            return
        if path == "/api/audit":
            if not self.ensure_role(user, {"admin", "auditor"}):
                return
            self.get_audit(query)
            return
        if path == "/api/backups":
            if not self.ensure_role(user, {"admin"}):
                return
            self.send_json({"backups": list_backups()})
            return
        if path.startswith("/api/backups/"):
            if not self.ensure_role(user, {"admin"}):
                return
            self.download_backup(unquote(path.split("/")[-1]))
            return
        self.error_json(HTTPStatus.NOT_FOUND, "Recurso no encontrado.")

    def handle_api_write(self, method: str) -> None:
        path = urlparse(self.path).path
        if path == "/api/auth/login" and method == "POST":
            self.login()
            return
        user = self.require_user(csrf=True)
        if not user:
            return
        try:
            payload = self.read_json()
        except ValueError as exc:
            self.error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if path == "/api/auth/logout" and method == "POST":
            self.logout(user)
        elif path == "/api/auth/password" and method == "POST":
            self.change_password(user, payload)
        elif path == "/api/clinical/sync" and method == "POST":
            if self.ensure_role(user, WRITE_ROLES):
                self.sync_clinical(user, payload)
        elif path == "/api/clinical/clear" and method == "DELETE":
            if self.ensure_role(user, {"admin"}):
                self.clear_clinical(user)
        elif path == "/api/cac/jobs" and method == "POST":
            if self.ensure_role(user, WRITE_ROLES):
                self.create_cac_job(user, payload)
        elif re.fullmatch(r"/api/cac/jobs/[^/]+/consultations", path) and method == "POST":
            if self.ensure_role(user, WRITE_ROLES):
                self.upload_cac_consultations(user, path.split("/")[4], payload)
        elif re.fullmatch(r"/api/cac/jobs/[^/]+/supports", path) and method == "POST":
            if self.ensure_role(user, WRITE_ROLES):
                self.upload_cac_support(user, path.split("/")[4], payload)
        elif re.fullmatch(r"/api/cac/jobs/[^/]+/process", path) and method == "POST":
            if self.ensure_role(user, WRITE_ROLES):
                self.process_cac_job_request(user, path.split("/")[4])
        elif path == "/api/tasks" and method == "POST":
            if self.ensure_role(user, WRITE_ROLES):
                self.create_task(user, payload)
        elif path == "/api/tasks/from-exam" and method == "POST":
            if self.ensure_role(user, WRITE_ROLES):
                self.manage_exam_task(user, payload)
        elif path.startswith("/api/tasks/") and path.endswith("/events") and method == "POST":
            if self.ensure_role(user, WRITE_ROLES):
                self.add_task_note(user, path.split("/")[3], payload)
        elif path.startswith("/api/tasks/") and method == "PATCH":
            if self.ensure_role(user, WRITE_ROLES):
                self.update_task(user, path.split("/")[3], payload)
        elif path == "/api/users" and method == "POST":
            if self.ensure_role(user, {"admin"}):
                self.create_user(user, payload)
        elif path.startswith("/api/users/") and method == "PATCH":
            if self.ensure_role(user, {"admin"}):
                self.update_user(user, path.split("/")[3], payload)
        elif path == "/api/backups" and method == "POST":
            if self.ensure_role(user, {"admin"}):
                backup = create_backup("manual")
                with connect() as conn:
                    audit(conn, user["id"], "backup.create", "backup", backup.name, self.ip_address)
                self.send_json({"backup": {"name": backup.name, "size": backup.stat().st_size}}, 201)
        else:
            self.error_json(HTTPStatus.NOT_FOUND, "Recurso no encontrado.")

    def ensure_role(self, user: dict, roles: set[str]) -> bool:
        if user["role"] in roles:
            return True
        self.error_json(HTTPStatus.FORBIDDEN, "Tu rol no permite realizar esta acción.")
        return False

    @staticmethod
    def permissions(user: dict) -> dict:
        role = user["role"]
        return {
            "write_clinical": role in WRITE_ROLES,
            "manage_tasks": role in WRITE_ROLES,
            "view_audit": role in {"admin", "auditor"},
            "manage_users": role == "admin",
            "manage_backups": role == "admin",
        }

    def login_allowed(self) -> bool:
        now = time.time()
        with LOGIN_LOCK:
            recent = [stamp for stamp in LOGIN_ATTEMPTS.get(self.ip_address, []) if now - stamp < 900]
            LOGIN_ATTEMPTS[self.ip_address] = recent
            return len(recent) < 8

    def record_failed_login(self) -> None:
        with LOGIN_LOCK:
            LOGIN_ATTEMPTS.setdefault(self.ip_address, []).append(time.time())

    def login(self) -> None:
        if not self.login_allowed():
            self.error_json(HTTPStatus.TOO_MANY_REQUESTS, "Demasiados intentos. Espera 15 minutos.")
            return
        try:
            payload = self.read_json()
        except ValueError as exc:
            self.error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return
        email = str(payload.get("email", "")).strip().lower()
        password = str(payload.get("password", ""))
        with connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE email=? AND active=1", (email,)).fetchone()
            if not row or not verify_password(password, row["password_salt"], row["password_hash"]):
                self.record_failed_login()
                audit(conn, row["id"] if row else None, "auth.failed", "session", None, self.ip_address, {"email": email})
                self.error_json(HTTPStatus.UNAUTHORIZED, "Correo o contraseña incorrectos.")
                return
            raw_token = secrets.token_urlsafe(48)
            token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
            csrf_token = secrets.token_urlsafe(32)
            now = datetime.now(timezone.utc)
            expires = now + timedelta(hours=SESSION_HOURS)
            conn.execute("DELETE FROM sessions WHERE user_id=?", (row["id"],))
            conn.execute(
                "INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)",
                (token_hash, row["id"], csrf_token, now.isoformat(), expires.isoformat(), now.isoformat()),
            )
            audit(conn, row["id"], "auth.login", "session", token_hash[:12], self.ip_address)
        attributes = [f"renal_session={raw_token}", "Path=/", "HttpOnly", "SameSite=Strict", f"Max-Age={SESSION_HOURS * 3600}"]
        if COOKIE_SECURE:
            attributes.append("Secure")
        self.send_json(
            {"user": public_user(row), "csrf_token": csrf_token, "permissions": self.permissions(public_user(row))},
            cookie="; ".join(attributes),
        )

    def logout(self, user: dict) -> None:
        token = self.session_token()
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest() if token else ""
        with connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
            audit(conn, user["id"], "auth.logout", "session", token_hash[:12], self.ip_address)
        suffix = "; Secure" if COOKIE_SECURE else ""
        self.send_json({"ok": True}, cookie=f"renal_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{suffix}")

    def change_password(self, user: dict, payload: dict) -> None:
        current = str(payload.get("current_password", ""))
        new_password = str(payload.get("new_password", ""))
        if len(new_password) < 12 or not any(c.isdigit() for c in new_password) or not any(c.isalpha() for c in new_password):
            self.error_json(400, "La nueva contraseña debe tener al menos 12 caracteres, letras y números.")
            return
        with connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            if not row or not verify_password(current, row["password_salt"], row["password_hash"]):
                self.error_json(400, "La contraseña actual no coincide.")
                return
            salt, digest = password_hash(new_password)
            conn.execute(
                "UPDATE users SET password_salt=?,password_hash=?,must_change_password=0,updated_at=? WHERE id=?",
                (salt, digest, utc_now(), user["id"]),
            )
            audit(conn, user["id"], "user.password_changed", "user", user["id"], self.ip_address)
        self.send_json({"ok": True})

    def get_clinical_snapshot(self) -> None:
        with connect() as conn:
            patients = [safe_json(row["payload_json"]) for row in conn.execute("SELECT payload_json FROM patients WHERE active=1")]
            labs = [
                safe_json(row["payload_json"])
                for row in conn.execute(
                    "SELECT l.payload_json FROM labs l JOIN patients p ON p.id=l.patient_id WHERE p.active=1 ORDER BY l.id"
                )
            ]
            managed_exams = [
                dict(row)
                for row in conn.execute(
                    """SELECT t.patient_id,t.exam_type,t.status,t.updated_at
                       FROM tasks t
                       JOIN patients p ON p.id=t.patient_id AND p.active=1
                       WHERE t.exam_type IN ('creatinine','albuminuria','hba1c','lipids')
                         AND NOT EXISTS (
                           SELECT 1 FROM tasks newer
                           WHERE newer.patient_id=t.patient_id
                             AND newer.exam_type=t.exam_type
                             AND (newer.updated_at > t.updated_at OR (newer.updated_at=t.updated_at AND newer.id > t.id))
                         )"""
                )
            ]
        self.send_json({"patients": patients, "labs": labs, "managed_exams": managed_exams})

    def sync_clinical(self, user: dict, payload: dict) -> None:
        mode = str(payload.get("mode", ""))
        patients = payload.get("patients") if isinstance(payload.get("patients"), list) else []
        labs = payload.get("labs") if isinstance(payload.get("labs"), list) else []
        file_name = str(payload.get("file_name", ""))[:255]
        requested_import_id = str(payload.get("import_id", "")).strip()[:100]
        import_id = requested_import_id or new_id()
        import_start = bool(payload.get("import_start"))
        import_final = bool(payload.get("import_final")) or not requested_import_id
        if mode not in {"cohort", "labs"}:
            self.error_json(400, "Tipo de cargue no válido.")
            return
        now = utc_now()
        patient_count = 0
        lab_count = 0
        skipped_labs = 0
        with connect() as conn:
            if mode == "cohort":
                conn.execute("UPDATE patients SET active=0")
                for patient in patients:
                    if not isinstance(patient, dict):
                        continue
                    patient_id = str(patient.get("id", "")).strip()
                    document = str(patient.get("document", patient_id)).strip()
                    if not patient_id or not document:
                        continue
                    conn.execute(
                        """INSERT INTO patients(id,doc_type,document,name,active,payload_json,source,updated_at,updated_by)
                           VALUES(?,?,?,?,1,?,?,?,?)
                           ON CONFLICT(id) DO UPDATE SET doc_type=excluded.doc_type,document=excluded.document,
                           name=excluded.name,active=1,payload_json=excluded.payload_json,source=excluded.source,
                           updated_at=excluded.updated_at,updated_by=excluded.updated_by""",
                        (
                            patient_id,
                            str(patient.get("docType", patient.get("type", "")))[:30],
                            document,
                            str(patient.get("name", ""))[:255],
                            json_text(patient),
                            str(patient.get("source", file_name))[:255],
                            now,
                            user["id"],
                        ),
                    )
                    patient_count += 1
            valid_patients = {row[0] for row in conn.execute("SELECT id FROM patients WHERE active=1")}
            for lab in labs:
                if not isinstance(lab, dict):
                    continue
                patient_id = str(lab.get("patientId", "")).strip()
                if not patient_id or patient_id not in valid_patients:
                    skipped_labs += 1
                    continue
                key = str(lab.get("key", "")).strip() or hashlib.sha256(json_text(lab).encode("utf-8")).hexdigest()
                cursor = conn.execute(
                    """INSERT OR IGNORE INTO labs
                       (lab_key,patient_id,lab_type,result_date,value_text,source,payload_json,created_at,created_by)
                       VALUES(?,?,?,?,?,?,?,?,?)""",
                    (
                        key,
                        patient_id,
                        str(lab.get("type", "desconocido"))[:80],
                        str(lab.get("date", ""))[:30],
                        str(lab.get("value", ""))[:120],
                        str(lab.get("source", file_name))[:255],
                        json_text(lab),
                        now,
                        user["id"],
                    ),
                )
                lab_count += max(cursor.rowcount, 0)
            existing_import = conn.execute("SELECT import_type FROM imports WHERE id=?", (import_id,)).fetchone()
            if import_start or not existing_import:
                conn.execute(
                    """INSERT OR IGNORE INTO imports
                       (id,import_type,file_name,record_count,lab_count,imported_by,created_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (import_id, mode, file_name, 0, 0, user["id"], now),
                )
                existing_import = conn.execute("SELECT import_type FROM imports WHERE id=?", (import_id,)).fetchone()
            import_type = existing_import["import_type"] if existing_import else mode
            if mode == "cohort":
                conn.execute(
                    "UPDATE imports SET file_name=?,record_count=?,lab_count=lab_count+? WHERE id=?",
                    (file_name, patient_count, lab_count, import_id),
                )
            else:
                record_increment = len(labs) if import_type == "labs" else 0
                conn.execute(
                    "UPDATE imports SET record_count=record_count+?,lab_count=lab_count+? WHERE id=?",
                    (record_increment, lab_count, import_id),
                )
            if import_final:
                totals = conn.execute(
                    "SELECT import_type,record_count,lab_count FROM imports WHERE id=?",
                    (import_id,),
                ).fetchone()
                audit(
                    conn,
                    user["id"],
                    f"clinical.import.{totals['import_type'] if totals else mode}",
                    "import",
                    import_id,
                    self.ip_address,
                    {
                        "records": totals["record_count"] if totals else patient_count,
                        "labs_added": totals["lab_count"] if totals else lab_count,
                        "labs_skipped_last_batch": skipped_labs,
                        "file": file_name,
                    },
                )
        self.send_json({"patients": patient_count, "labs_added": lab_count, "labs_skipped": skipped_labs}, 201)

    def clear_clinical(self, user: dict) -> None:
        create_backup("antes_borrado")
        with connect() as conn:
            counts = {
                "patients": conn.execute("SELECT count(*) FROM patients").fetchone()[0],
                "labs": conn.execute("SELECT count(*) FROM labs").fetchone()[0],
            }
            conn.execute("DELETE FROM task_events")
            conn.execute("DELETE FROM tasks")
            conn.execute("DELETE FROM labs")
            conn.execute("DELETE FROM patients")
            audit(conn, user["id"], "clinical.clear", "clinical", None, self.ip_address, counts)
        self.send_json({"ok": True})

    def task_select(self) -> str:
        return """SELECT t.*, p.document, p.name AS patient_name,
                  a.full_name AS assignee_name, c.full_name AS creator_name,
                  z.full_name AS closer_name,
                  (SELECT count(*) FROM task_events e WHERE e.task_id=t.id) AS event_count
                  FROM tasks t LEFT JOIN patients p ON p.id=t.patient_id
                  LEFT JOIN users a ON a.id=t.assigned_to LEFT JOIN users c ON c.id=t.created_by
                  LEFT JOIN users z ON z.id=t.closed_by"""

    def get_tasks(self, query: dict[str, list[str]], user: dict) -> None:
        clauses = []
        params: list[str] = []
        status = query.get("status", [""])[0]
        assigned = query.get("assigned", [""])[0]
        if status and status != "all":
            clauses.append("t.status=?")
            params.append(status)
        if assigned == "me":
            clauses.append("t.assigned_to=?")
            params.append(user["id"])
        sql = self.task_select()
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY CASE t.priority WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 ELSE 4 END, t.due_date, t.updated_at DESC LIMIT 2000"
        with connect() as conn:
            tasks = [dict(row) for row in conn.execute(sql, params)]
        self.send_json({"tasks": tasks})

    def create_task(self, user: dict, payload: dict) -> None:
        title = str(payload.get("title", "")).strip()
        if not title:
            self.error_json(400, "La tarea necesita un título.")
            return
        priority = str(payload.get("priority", "media"))
        status = str(payload.get("status", "pendiente"))
        if priority not in {"critica", "alta", "media", "baja"} or status not in {"pendiente", "en_gestion", "programada", "completada", "cancelada"}:
            self.error_json(400, "Prioridad o estado no válido.")
            return
        task_id = new_id()
        now = utc_now()
        closed = status in {"completada", "cancelada"}
        with connect() as conn:
            patient_id = payload.get("patient_id") or None
            assigned_to = payload.get("assigned_to") or None
            if patient_id and not conn.execute("SELECT 1 FROM patients WHERE id=?", (patient_id,)).fetchone():
                self.error_json(400, "El documento no pertenece a la cohorte activa.")
                return
            if assigned_to and not conn.execute("SELECT 1 FROM users WHERE id=? AND active=1", (assigned_to,)).fetchone():
                self.error_json(400, "El responsable seleccionado no está activo.")
                return
            conn.execute(
                """INSERT INTO tasks(id,patient_id,title,exam_type,priority,status,due_date,assigned_to,created_by,closed_by,description,created_at,updated_at,closed_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task_id,
                    patient_id,
                    title[:255],
                    str(payload.get("exam_type", ""))[:80],
                    priority,
                    status,
                    payload.get("due_date") or None,
                    assigned_to,
                    user["id"],
                    user["id"] if closed else None,
                    str(payload.get("description", ""))[:4000],
                    now,
                    now,
                    now if closed else None,
                ),
            )
            conn.execute(
                "INSERT INTO task_events(task_id,event_type,to_status,note,actor_id,created_at) VALUES(?,?,?,?,?,?)",
                (task_id, "creada", status, str(payload.get("note", ""))[:2000], user["id"], now),
            )
            audit(conn, user["id"], "task.create", "task", task_id, self.ip_address, {"status": status, "priority": priority})
            task = row_dict(conn.execute(self.task_select() + " WHERE t.id=?", (task_id,)).fetchone())
        self.send_json({"task": task}, 201)

    def update_task(self, user: dict, task_id: str, payload: dict) -> None:
        allowed = {"title", "exam_type", "priority", "status", "due_date", "assigned_to", "description"}
        updates = {key: payload[key] for key in allowed if key in payload}
        with connect() as conn:
            current = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not current:
                self.error_json(404, "Tarea no encontrada.")
                return
            if updates.get("priority", current["priority"]) not in {"critica", "alta", "media", "baja"}:
                self.error_json(400, "Prioridad no válida.")
                return
            if updates.get("status", current["status"]) not in {"pendiente", "en_gestion", "programada", "completada", "cancelada"}:
                self.error_json(400, "Estado no válido.")
                return
            assigned_to = updates.get("assigned_to", current["assigned_to"])
            if assigned_to and not conn.execute("SELECT 1 FROM users WHERE id=? AND active=1", (assigned_to,)).fetchone():
                self.error_json(400, "El responsable seleccionado no está activo.")
                return
            fields = []
            params = []
            for key, value in updates.items():
                fields.append(f"{key}=?")
                params.append(value or None)
            now = utc_now()
            fields.append("updated_at=?")
            params.append(now)
            next_status = updates.get("status", current["status"])
            if next_status in {"completada", "cancelada"} and current["status"] not in {"completada", "cancelada"}:
                fields.extend(["closed_by=?", "closed_at=?"])
                params.extend([user["id"], now])
            elif next_status not in {"completada", "cancelada"}:
                fields.extend(["closed_by=NULL", "closed_at=NULL"])
            params.append(task_id)
            conn.execute(f"UPDATE tasks SET {','.join(fields)} WHERE id=?", params)
            event_type = "estado" if next_status != current["status"] else "actualizada"
            conn.execute(
                "INSERT INTO task_events(task_id,event_type,from_status,to_status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
                (task_id, event_type, current["status"], next_status, str(payload.get("note", ""))[:2000], user["id"], now),
            )
            audit(conn, user["id"], "task.update", "task", task_id, self.ip_address, {"fields": list(updates), "status": next_status})
            task = row_dict(conn.execute(self.task_select() + " WHERE t.id=?", (task_id,)).fetchone())
        self.send_json({"task": task})

    def manage_exam_task(self, user: dict, payload: dict) -> None:
        patient_id = str(payload.get("patient_id", ""))
        exam_type = str(payload.get("exam_type", ""))
        managed = bool(payload.get("managed"))
        if not patient_id or exam_type not in EXAM_TASK_LABELS:
            self.error_json(400, "Paciente y paraclínico son obligatorios.")
            return
        with connect() as conn:
            task = conn.execute(
                """SELECT * FROM tasks
                   WHERE patient_id=? AND exam_type=? AND status NOT IN ('completada','cancelada')
                   ORDER BY updated_at DESC LIMIT 1""",
                (patient_id, exam_type),
            ).fetchone()
            if not task and not managed:
                task = conn.execute(
                    "SELECT * FROM tasks WHERE patient_id=? AND exam_type=? ORDER BY updated_at DESC LIMIT 1",
                    (patient_id, exam_type),
                ).fetchone()
        if not task:
            payload = {
                "patient_id": patient_id,
                "exam_type": exam_type,
                "title": f"Gestionar toma de {EXAM_TASK_LABELS[exam_type]}",
                "priority": str(payload.get("priority", "media")),
                "status": "en_gestion" if managed else "pendiente",
                "due_date": payload.get("due_date"),
                "assigned_to": user["id"],
                "description": "Creada desde la gestión clínica del paciente.",
                "note": "Gestión iniciada desde la cohorte." if managed else "Pendiente de gestión desde la cohorte.",
            }
            self.create_task(user, payload)
            return
        next_status = "en_gestion" if managed else "pendiente"
        self.update_task(
            user,
            task["id"],
            {
                "status": next_status,
                "assigned_to": user["id"],
                "due_date": payload.get("due_date") or task["due_date"],
                "note": "Gestión iniciada desde la cohorte." if managed else "Gestión devuelta a pendiente desde la cohorte.",
            },
        )

    def add_task_note(self, user: dict, task_id: str, payload: dict) -> None:
        note = str(payload.get("note", "")).strip()
        if not note:
            self.error_json(400, "Escribe una nota de gestión.")
            return
        with connect() as conn:
            if not conn.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                self.error_json(404, "Tarea no encontrada.")
                return
            conn.execute(
                "INSERT INTO task_events(task_id,event_type,note,actor_id,created_at) VALUES(?,?,?,?,?)",
                (task_id, "nota", note[:2000], user["id"], utc_now()),
            )
            conn.execute("UPDATE tasks SET updated_at=? WHERE id=?", (utc_now(), task_id))
            audit(conn, user["id"], "task.note", "task", task_id, self.ip_address)
        self.send_json({"ok": True}, 201)

    def get_task_history(self, task_id: str) -> None:
        with connect() as conn:
            rows = conn.execute(
                """SELECT e.*,u.full_name AS actor_name,u.email AS actor_email
                   FROM task_events e JOIN users u ON u.id=e.actor_id
                   WHERE e.task_id=? ORDER BY e.created_at DESC""",
                (task_id,),
            )
            events = [dict(row) for row in rows]
        self.send_json({"events": events})

    def get_stats(self, user: dict) -> None:
        with connect() as conn:
            tasks = conn.execute(
                """SELECT count(*) total,
                   sum(status='pendiente') pending,
                   sum(status='en_gestion') managing,
                   sum(status='programada') scheduled,
                   sum(status='completada') completed,
                   sum(status NOT IN ('completada','cancelada') AND due_date < date('now')) overdue
                   FROM tasks"""
            ).fetchone()
            counts = {
                "patients": conn.execute("SELECT count(*) FROM patients WHERE active=1").fetchone()[0],
                "labs": conn.execute("SELECT count(*) FROM labs").fetchone()[0],
                "users": conn.execute("SELECT count(*) FROM users WHERE active=1").fetchone()[0],
                "tasks": dict(tasks),
            }
        self.send_json(counts)

    def get_imports(self) -> None:
        with connect() as conn:
            rows = conn.execute(
                """SELECT i.*,u.full_name AS imported_by_name FROM imports i
                   JOIN users u ON u.id=i.imported_by ORDER BY i.created_at DESC LIMIT 100"""
            )
            imports = [dict(row) for row in rows]
        self.send_json({"imports": imports})

    @staticmethod
    def decode_cac_file(payload: dict, suffixes: set[str]) -> tuple[str, bytes]:
        file_name = Path(str(payload.get("file_name", ""))).name
        suffix = Path(file_name).suffix.lower()
        if not file_name or suffix not in suffixes:
            raise ValueError("El tipo de archivo no está permitido.")
        encoded = str(payload.get("data_base64", ""))
        if "," in encoded:
            encoded = encoded.split(",", 1)[1]
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("El contenido del archivo no es válido.") from exc
        if not data:
            raise ValueError("El archivo está vacío.")
        if len(data) > MAX_CAC_FILE:
            raise ValueError("El archivo supera el tamaño individual permitido.")
        if suffix == ".pdf" and not data.startswith(b"%PDF"):
            raise ValueError("El soporte no corresponde a un PDF válido.")
        if suffix == ".xlsx" and not data.startswith(b"PK"):
            raise ValueError("El archivo no corresponde a un Excel XLSX válido.")
        return file_name[:255], data

    @staticmethod
    def cac_job_dir(job_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", job_id):
            raise ValueError("Identificador de proceso no válido.")
        path = (CAC_DATA_DIR / job_id).resolve()
        path.relative_to(CAC_DATA_DIR.resolve())
        return path

    def create_cac_job(self, user: dict, payload: dict) -> None:
        raw_settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
        try:
            settings = validate_settings(raw_settings)
        except ValueError as exc:
            self.error_json(400, str(exc))
            return
        job_id = new_id()
        now = utc_now()
        job_dir = self.cac_job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=False)
        try:
            job_dir.chmod(0o700)
        except OSError:
            pass
        with connect() as conn:
            conn.execute(
                """INSERT INTO cac_jobs
                   (id,status,cutoff_date,settings_json,created_by,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (
                    job_id,
                    "creado",
                    settings["cutoff_date"],
                    json_text(settings),
                    user["id"],
                    now,
                    now,
                ),
            )
            audit(
                conn,
                user["id"],
                "cac.job.create",
                "cac_job",
                job_id,
                self.ip_address,
                {"cutoff_date": settings["cutoff_date"]},
            )
        self.send_json({"job": {"id": job_id, "status": "creado", "settings": settings}}, 201)

    def upload_cac_consultations(self, user: dict, job_id: str, payload: dict) -> None:
        try:
            file_name, data = self.decode_cac_file(payload, {".xlsx"})
            job_dir = self.cac_job_dir(job_id)
        except ValueError as exc:
            self.error_json(400, str(exc))
            return
        with connect() as conn:
            if not conn.execute("SELECT 1 FROM cac_jobs WHERE id=?", (job_id,)).fetchone():
                self.error_json(404, "Proceso CAC no encontrado.")
                return
            target = job_dir / "atenciones.xlsx"
            target.write_bytes(data)
            try:
                target.chmod(0o600)
            except OSError:
                pass
            conn.execute(
                """UPDATE cac_jobs SET status='cargando',consultations_name=?,
                   consultations_path=?,updated_at=?,error_message=NULL WHERE id=?""",
                (file_name, str(target), utc_now(), job_id),
            )
            audit(
                conn,
                user["id"],
                "cac.consultations.upload",
                "cac_job",
                job_id,
                self.ip_address,
                {"file": file_name, "size": len(data)},
            )
        self.send_json({"ok": True, "file_name": file_name, "size": len(data)}, 201)

    def upload_cac_support(self, user: dict, job_id: str, payload: dict) -> None:
        try:
            file_name, data = self.decode_cac_file(payload, {".pdf"})
            job_dir = self.cac_job_dir(job_id)
        except ValueError as exc:
            self.error_json(400, str(exc))
            return
        digest = hashlib.sha256(data).hexdigest()
        match = re.match(
            r"^(?P<type>[A-Za-z]+)(?P<doc>\d+)_(?P<specialty>.+)_(?P<date>\d{4}-\d{2}-\d{2})\.pdf$",
            file_name,
            re.I,
        )
        document = match.group("doc") if match else ""
        doc_type = match.group("type").upper() if match else ""
        attention_date = match.group("date") if match else ""
        specialty = match.group("specialty").replace("_", " ") if match else ""
        support_dir = job_dir / "supports"
        support_dir.mkdir(parents=True, exist_ok=True)
        target = support_dir / f"{digest[:12]}__{file_name}"
        with connect() as conn:
            if not conn.execute("SELECT 1 FROM cac_jobs WHERE id=?", (job_id,)).fetchone():
                self.error_json(404, "Proceso CAC no encontrado.")
                return
            duplicate = conn.execute(
                "SELECT id FROM cac_supports WHERE job_id=? AND sha256=?",
                (job_id, digest),
            ).fetchone()
            if duplicate:
                self.send_json({"ok": True, "duplicate": True, "file_name": file_name})
                return
            target.write_bytes(data)
            try:
                target.chmod(0o600)
            except OSError:
                pass
            support_id = new_id()
            conn.execute(
                """INSERT INTO cac_supports
                   (id,job_id,file_name,storage_path,sha256,document,doc_type,attention_date,
                    specialty,uploaded_by,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    support_id,
                    job_id,
                    file_name,
                    str(target),
                    digest,
                    document,
                    doc_type,
                    attention_date or None,
                    specialty,
                    user["id"],
                    utc_now(),
                ),
            )
            conn.execute(
                "UPDATE cac_jobs SET status='cargando',updated_at=?,error_message=NULL WHERE id=?",
                (utc_now(), job_id),
            )
            audit(
                conn,
                user["id"],
                "cac.support.upload",
                "cac_support",
                support_id,
                self.ip_address,
                {"job_id": job_id, "file": file_name, "document_detected": bool(document)},
            )
        self.send_json(
            {
                "ok": True,
                "duplicate": False,
                "file_name": file_name,
                "document_detected": bool(document),
            },
            201,
        )

    def process_cac_job_request(self, user: dict, job_id: str) -> None:
        try:
            job_dir = self.cac_job_dir(job_id)
        except ValueError as exc:
            self.error_json(400, str(exc))
            return
        with connect() as conn:
            job = conn.execute("SELECT * FROM cac_jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                self.error_json(404, "Proceso CAC no encontrado.")
                return
            if not job["consultations_path"] or not Path(job["consultations_path"]).is_file():
                self.error_json(400, "Primero carga el Excel de atenciones.")
                return
            supports = [
                Path(row["storage_path"])
                for row in conn.execute(
                    "SELECT storage_path FROM cac_supports WHERE job_id=? ORDER BY created_at",
                    (job_id,),
                )
                if Path(row["storage_path"]).is_file()
            ]
            conn.execute(
                "UPDATE cac_jobs SET status='procesando',updated_at=?,error_message=NULL WHERE id=?",
                (utc_now(), job_id),
            )
        try:
            output_dir = job_dir / "output"
            preview = process_cac_job(
                Path(job["consultations_path"]),
                supports,
                output_dir,
                safe_json(job["settings_json"]),
            )
            summary = preview["summary"]
            xlsx_path = output_dir / summary["xlsx_name"]
            txt_path = output_dir / summary["txt_name"] if summary.get("txt_name") else None
            with connect() as conn:
                conn.execute(
                    """UPDATE cac_jobs SET status='completado',output_xlsx_path=?,
                       output_txt_path=?,summary_json=?,updated_at=?,error_message=NULL WHERE id=?""",
                    (
                        str(xlsx_path),
                        str(txt_path) if txt_path else None,
                        json_text(summary),
                        utc_now(),
                        job_id,
                    ),
                )
                audit(
                    conn,
                    user["id"],
                    "cac.job.process",
                    "cac_job",
                    job_id,
                    self.ip_address,
                    {
                        "patients": summary["patients"],
                        "supports": summary["supports"],
                        "ready": summary["ready"],
                        "review": summary["review"],
                    },
                )
        except Exception as exc:
            with connect() as conn:
                conn.execute(
                    "UPDATE cac_jobs SET status='error',error_message=?,updated_at=? WHERE id=?",
                    (str(exc)[:1000], utc_now(), job_id),
                )
                audit(
                    conn,
                    user["id"],
                    "cac.job.error",
                    "cac_job",
                    job_id,
                    self.ip_address,
                    {"error": type(exc).__name__},
                )
            self.error_json(400, f"No fue posible generar la malla: {exc}")
            return
        self.send_json({"job_id": job_id, **preview})

    def get_cac_jobs(self) -> None:
        with connect() as conn:
            rows = conn.execute(
                """SELECT j.*,u.full_name AS created_by_name,
                   (SELECT count(*) FROM cac_supports s WHERE s.job_id=j.id) AS support_count
                   FROM cac_jobs j JOIN users u ON u.id=j.created_by
                   ORDER BY j.created_at DESC LIMIT 100"""
            )
            jobs = []
            for row in rows:
                item = dict(row)
                item["summary"] = safe_json(item.pop("summary_json", None))
                item["settings"] = safe_json(item.pop("settings_json", None))
                for key in ("consultations_path", "output_xlsx_path", "output_txt_path"):
                    item.pop(key, None)
                jobs.append(item)
        self.send_json({"jobs": jobs})

    def get_cac_job(self, job_id: str) -> None:
        with connect() as conn:
            row = conn.execute(
                """SELECT j.*,u.full_name AS created_by_name,
                   (SELECT count(*) FROM cac_supports s WHERE s.job_id=j.id) AS support_count
                   FROM cac_jobs j JOIN users u ON u.id=j.created_by WHERE j.id=?""",
                (job_id,),
            ).fetchone()
            if not row:
                self.error_json(404, "Proceso CAC no encontrado.")
                return
            job = dict(row)
        job["summary"] = safe_json(job.pop("summary_json", None))
        job["settings"] = safe_json(job.pop("settings_json", None))
        for key in ("consultations_path", "output_xlsx_path", "output_txt_path"):
            job.pop(key, None)
        preview_path = self.cac_job_dir(job_id) / "output" / "preview.json"
        preview = safe_json(preview_path.read_text(encoding="utf-8")) if preview_path.is_file() else {}
        self.send_json({"job": job, "preview": preview})

    def download_cac_output(self, job_id: str, output_type: str) -> None:
        column = "output_xlsx_path" if output_type == "xlsx" else "output_txt_path"
        with connect() as conn:
            row = conn.execute(
                f"SELECT {column} AS file_path FROM cac_jobs WHERE id=? AND status='completado'",
                (job_id,),
            ).fetchone()
        if not row or not row["file_path"]:
            self.error_json(404, "El archivo solicitado todavía no está disponible.")
            return
        path = Path(row["file_path"]).resolve()
        try:
            path.relative_to(CAC_DATA_DIR.resolve())
        except ValueError:
            self.error_json(404, "Ruta de archivo no válida.")
            return
        if not path.is_file():
            self.error_json(404, "Archivo no encontrado.")
            return
        data = path.read_bytes()
        content_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if output_type == "xlsx"
            else "text/plain; charset=windows-1252"
        )
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{ascii_text(path.name)}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", CACHE_CONTROL_PRIVATE)
        self.end_headers()
        self.wfile.write(data)

    def get_users(self) -> None:
        with connect() as conn:
            users = [public_user(row) for row in conn.execute("SELECT * FROM users ORDER BY full_name")]
        self.send_json({"users": users})

    def get_team(self) -> None:
        with connect() as conn:
            users = [
                public_user(row)
                for row in conn.execute("SELECT * FROM users WHERE active=1 ORDER BY full_name")
            ]
        self.send_json({"users": users})

    def create_user(self, actor: dict, payload: dict) -> None:
        email = str(payload.get("email", "")).strip().lower()
        name = str(payload.get("full_name", "")).strip()
        role = str(payload.get("role", "gestor"))
        password = str(payload.get("password", ""))
        if "@" not in email or not name or role not in ROLES or len(password) < 12:
            self.error_json(400, "Completa nombre, correo, rol y una contraseña de mínimo 12 caracteres.")
            return
        salt, digest = password_hash(password)
        user_id = new_id()
        now = utc_now()
        try:
            with connect() as conn:
                conn.execute(
                    "INSERT INTO users(id,email,full_name,role,password_salt,password_hash,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (user_id, email, name[:255], role, salt, digest, 1, 1, now, now),
                )
                audit(conn, actor["id"], "user.create", "user", user_id, self.ip_address, {"email": email, "role": role})
        except sqlite3.IntegrityError:
            self.error_json(409, "Ya existe un usuario con ese correo.")
            return
        self.send_json({"user": {"id": user_id, "email": email, "full_name": name, "role": role, "active": True}}, 201)

    def update_user(self, actor: dict, user_id: str, payload: dict) -> None:
        fields = []
        params: list[object] = []
        for key in ("full_name", "role", "active"):
            if key not in payload:
                continue
            if key == "role" and payload[key] not in ROLES:
                self.error_json(400, "Rol no válido.")
                return
            fields.append(f"{key}=?")
            params.append(1 if key == "active" and payload[key] else 0 if key == "active" else payload[key])
        if payload.get("password"):
            if len(str(payload["password"])) < 12:
                self.error_json(400, "La contraseña debe tener mínimo 12 caracteres.")
                return
            salt, digest = password_hash(str(payload["password"]))
            fields.extend(["password_salt=?", "password_hash=?", "must_change_password=1"])
            params.extend([salt, digest])
        if not fields:
            self.error_json(400, "No hay cambios para guardar.")
            return
        fields.append("updated_at=?")
        params.extend([utc_now(), user_id])
        with connect() as conn:
            conn.execute(f"UPDATE users SET {','.join(fields)} WHERE id=?", params)
            audit(conn, actor["id"], "user.update", "user", user_id, self.ip_address, {"fields": list(payload)})
            row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            self.error_json(404, "Usuario no encontrado.")
            return
        self.send_json({"user": public_user(row)})

    def get_audit(self, query: dict[str, list[str]]) -> None:
        limit = min(max(int(query.get("limit", ["300"])[0]), 1), 1000)
        with connect() as conn:
            rows = conn.execute(
                """SELECT a.*,u.full_name AS actor_name,u.email AS actor_email
                   FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
                   ORDER BY a.created_at DESC LIMIT ?""",
                (limit,),
            )
            entries = [dict(row) | {"details": safe_json(row["details_json"])} for row in rows]
        self.send_json({"entries": entries})

    def download_backup(self, name: str) -> None:
        if Path(name).name != name:
            self.error_json(400, "Nombre de respaldo no válido.")
            return
        path = BACKUP_DIR / name
        if not path.exists() or path.suffix != ".sqlite3":
            self.error_json(404, "Respaldo no encontrado.")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.sqlite3")
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, path: str) -> None:
        allowed_root = STATIC_DIR
        if path in {"", "/"}:
            target = STATIC_DIR / "index.html"
        elif path == "/plantilla_cargue_cohorte_paraclinicos.xlsx":
            target = STATIC_DIR / "plantilla_cargue_cohorte_paraclinicos.xlsx"
        elif path == "/plantilla_atenciones_diabetes.xlsx":
            allowed_root = BASE_DIR / "resources"
            target = allowed_root / "plantilla_atenciones_diabetes.xlsx"
        elif path.startswith("/static/"):
            target = STATIC_DIR / unquote(path[len("/static/") :])
        else:
            target = STATIC_DIR / "index.html"
        try:
            resolved = target.resolve()
            resolved.relative_to(allowed_root.resolve())
        except (ValueError, OSError):
            self.send_error(404)
            return
        if not resolved.is_file():
            self.send_error(404)
            return
        data = resolved.read_bytes()
        content_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        if resolved.suffix == ".js":
            content_type = "application/javascript"
        self.send_response(200)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith(("text/", "application/javascript")) else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if resolved.name == "index.html" else "private, max-age=300")
        self.end_headers()
        self.wfile.write(data)


class RenalHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128


def run(host: str = "127.0.0.1", port: int = 8780) -> None:
    credentials = initialize()
    prune_sessions()
    maybe_daily_backup()
    server = RenalHTTPServer((host, port), RenalRequestHandler)
    print(f"Neurum Renal compartida: http://{host}:{port}")
    if credentials:
        print("Primer ingreso (cambia la contraseña al entrar):")
        print(f"  Usuario: {credentials['email']}")
        print(f"  Contraseña temporal: {credentials['password']}")
    print("Presiona Ctrl+C para detener el servidor.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run(
        os.getenv("RENAL_HOST", "127.0.0.1"),
        int(os.getenv("PORT", os.getenv("RENAL_PORT", "8780"))),
    )
