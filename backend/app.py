import json
import logging
import os
import pathlib
import secrets
import smtplib
import time
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from functools import wraps

from flask import Flask, abort, jsonify, make_response, request
import mysql.connector
from mysql.connector import errorcode

# ── config ─────────────────────────────────────────────────────────────
DB = dict(
    host=os.environ["DB_HOST"],
    port=int(os.environ.get("DB_PORT", 3306)),
    database=os.environ["DB_NAME"],
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    autocommit=True,
)

SMTP_SERVER   = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT     = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
FROM_EMAIL    = os.getenv("FROM_EMAIL", SMTP_USERNAME)

# Path prefix the app is mounted at (e.g. "/velis-planner"). Host + scheme
# are derived from the incoming request so cookies match whatever origin
# the pilot is actually using (brigger.com vs www.brigger.com etc).
PATH_PREFIX = os.getenv("PATH_PREFIX", "").rstrip("/")
# Legacy fallback only — used if we can't resolve the request origin.
PUBLIC_URL  = os.getenv("PUBLIC_URL", "").rstrip("/")
SITE_URL    = os.getenv("SITE_URL", PUBLIC_URL or "/").rstrip("/") or "/"

SESSION_COOKIE_NAME   = os.getenv("SESSION_COOKIE_NAME", "velis_session")
SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "0") == "1"
SESSION_DAYS          = int(os.getenv("SESSION_DAYS", "90"))
VERIFY_HOURS          = 24
LOGIN_LINK_HOURS      = 1

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("velis-backend")

app = Flask(__name__)


def conn():
    return mysql.connector.connect(**DB)


def bootstrap():
    sql = pathlib.Path(__file__).with_name("schema.sql").read_text()
    last_err = None
    for _ in range(30):
        try:
            c = conn()
            cur = c.cursor()
            for stmt in sql.split(";"):
                if stmt.strip():
                    cur.execute(stmt)
            cur.close()
            c.close()
            return
        except mysql.connector.Error as e:
            last_err = e
            time.sleep(2)
    raise RuntimeError(f"DB bootstrap failed: {last_err}")


bootstrap()


# ── helpers ────────────────────────────────────────────────────────────
def esc(s):
    return (str(s if s is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;"))


def request_origin():
    """Scheme + host the pilot is actually using (respects reverse proxy)."""
    proto = request.headers.get("X-Forwarded-Proto") or ("https" if request.is_secure else "http")
    host  = request.headers.get("X-Forwarded-Host") or request.host
    return f"{proto}://{host}"


def build_verify_url(token):
    base = request_origin() + PATH_PREFIX
    if not base.startswith("http"):
        base = PUBLIC_URL  # fallback
    return f"{base}/api/auth/verify/{token}"


def build_site_url():
    origin = request_origin()
    if origin.startswith("http"):
        return origin + PATH_PREFIX + "/"
    return SITE_URL


def valid_email(raw):
    e = (raw or "").strip().lower()
    if "@" not in e or "." not in e.split("@")[-1] or len(e) > 255:
        return False, ""
    return True, e


def valid_name(raw):
    n = (raw or "").strip()
    if not (1 <= len(n) <= 100):
        return False, ""
    return True, n


def send_magic_email(to_email, first_name, url, purpose):
    """purpose: 'verify' (first time) or 'login' (returning)."""
    if purpose == "verify":
        subject  = "Velis Electro — verify your email"
        greeting = f"Welcome aboard, {first_name}."
        lede     = "One last step — tap the button below to verify your email and unlock your flight planner account."
        cta      = "Verify & take off"
        ttl      = f"{VERIFY_HOURS} hours"
    else:
        subject  = "Velis Electro — your sign-in link"
        greeting = f"Cleared to board, {first_name}."
        lede     = "Tap the button below to sign in to your flight planner."
        cta      = "Sign in"
        ttl      = f"{LOGIN_LINK_HOURS} hour"

    html = f"""<!DOCTYPE html><html><body style="margin:0;padding:32px 20px;background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f2ec;">
<div style="max-width:520px;margin:0 auto;background:#13131a;border:1px solid #232327;border-radius:14px;padding:32px 28px;">
  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#ffb020;font-weight:700;margin-bottom:18px;">Velis Electro · Flight Planner</div>
  <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;margin:0 0 14px;font-weight:600;color:#f5f2ec;">{esc(greeting)}</h1>
  <p style="margin:0 0 24px;color:#c8c3b7;font-size:15px;line-height:1.55;">{esc(lede)}</p>
  <p style="margin:0 0 24px;"><a href="{esc(url)}" style="display:inline-block;background:#ffb020;color:#0a0a0b;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:14px;letter-spacing:0.02em;">{esc(cta)}</a></p>
  <p style="margin:0 0 8px;color:#898579;font-size:12px;">Or paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-family:'SFMono-Regular',Menlo,monospace;font-size:11px;color:#c8c3b7;word-break:break-all;">{esc(url)}</p>
  <p style="margin:0;color:#898579;font-size:11px;">Link expires in {ttl}. If you didn't request this, ignore the email.</p>
</div>
</body></html>"""

    msg = MIMEMultipart("alternative")
    msg["From"]    = FROM_EMAIL
    msg["To"]      = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(html, "html"))

    s = smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=15)
    s.starttls()
    s.login(SMTP_USERNAME, SMTP_PASSWORD)
    s.sendmail(FROM_EMAIL, to_email, msg.as_string())
    s.quit()
    log.info("sent %s link to %s", purpose, to_email)


def make_magic_token(user_id, purpose, hours):
    token = secrets.token_urlsafe(32)
    exp = datetime.utcnow() + timedelta(hours=hours)
    c = conn(); cur = c.cursor()
    cur.execute(
        "INSERT INTO magic_tokens (user_id, token, purpose, expires_at) VALUES (%s,%s,%s,%s)",
        (user_id, token, purpose, exp),
    )
    cur.close(); c.close()
    return token


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    exp   = datetime.utcnow() + timedelta(days=SESSION_DAYS)
    ua    = (request.headers.get("User-Agent") or "")[:255]
    ip    = (request.headers.get("X-Forwarded-For") or request.remote_addr or "")[:64]
    c = conn(); cur = c.cursor()
    cur.execute(
        "INSERT INTO sessions (user_id, token, expires_at, user_agent, ip_address) "
        "VALUES (%s,%s,%s,%s,%s)",
        (user_id, token, exp, ua, ip),
    )
    cur.close(); c.close()
    return token


def current_user():
    tok = request.cookies.get(SESSION_COOKIE_NAME)
    if not tok:
        hdr = request.headers.get("Authorization", "")
        if hdr.startswith("Bearer "):
            tok = hdr[7:]
    if not tok:
        return None
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT u.id, u.email, u.first_name, u.last_name "
        "FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = %s AND s.expires_at > UTC_TIMESTAMP()",
        (tok,),
    )
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE sessions SET last_seen_at = NOW() WHERE token = %s", (tok,))
    cur.close(); c.close()
    return row or None


def require_user(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        u = current_user()
        if not u:
            abort(401)
        request.user = u
        return fn(*a, **kw)
    return wrap


def set_session_cookie(resp, token):
    resp.set_cookie(
        SESSION_COOKIE_NAME, token,
        max_age=SESSION_DAYS * 86400,
        httponly=True, secure=SESSION_COOKIE_SECURE, samesite="Lax", path="/",
    )


# ── auth routes ────────────────────────────────────────────────────────
@app.post("/api/auth/register")
def auth_register():
    data = request.get_json(force=True, silent=True) or {}
    ok_e, email = valid_email(data.get("email"))
    ok_f, first = valid_name(data.get("first_name"))
    ok_l, last  = valid_name(data.get("last_name"))
    if not (ok_e and ok_f and ok_l):
        return jsonify({"error": "Email, first name and last name are required."}), 400

    c = conn(); cur = c.cursor(dictionary=True)
    try:
        cur.execute("SELECT id, first_name FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
        if row:
            user_id = row["id"]
            first   = row["first_name"] or first
        else:
            cur.execute(
                "INSERT INTO users (email, first_name, last_name) VALUES (%s, %s, %s)",
                (email, first, last),
            )
            user_id = cur.lastrowid
    finally:
        cur.close(); c.close()

    tok = make_magic_token(user_id, "verify", VERIFY_HOURS)
    url = build_verify_url(tok)
    try:
        send_magic_email(email, first, url, "verify")
    except Exception as e:
        log.exception("send failed")
        return jsonify({"error": "Could not send confirmation email — please try again."}), 502
    return jsonify({"status": "check_inbox", "email": email}), 201


@app.post("/api/auth/login")
def auth_login():
    data = request.get_json(force=True, silent=True) or {}
    ok_e, email = valid_email(data.get("email"))
    if not ok_e:
        return jsonify({"error": "Invalid email."}), 400

    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute("SELECT id, first_name FROM users WHERE email = %s", (email,))
    row = cur.fetchone()
    cur.close(); c.close()
    if not row:
        # Don't leak whether the email exists — same response shape.
        return jsonify({"status": "check_inbox", "email": email}), 200

    tok = make_magic_token(row["id"], "login", LOGIN_LINK_HOURS)
    url = build_verify_url(tok)
    try:
        send_magic_email(email, row["first_name"] or "", url, "login")
    except Exception as e:
        log.exception("send failed")
        return jsonify({"error": "Could not send sign-in email — please try again."}), 502
    return jsonify({"status": "check_inbox", "email": email}), 200


@app.route("/api/auth/verify/<token>", methods=["GET", "POST"])
def auth_verify(token):
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT mt.id AS tid, mt.user_id, mt.purpose, mt.expires_at, mt.used_at, "
        "       u.email, u.first_name, u.last_name, u.email_verified_at "
        "FROM magic_tokens mt JOIN users u ON u.id = mt.user_id "
        "WHERE mt.token = %s",
        (token,),
    )
    row = cur.fetchone()
    if not row:
        cur.close(); c.close()
        return landing_html(error="invalid"), 400
    if row["used_at"] is not None:
        cur.close(); c.close()
        return landing_html(error="used"), 400
    if row["expires_at"] < datetime.utcnow():
        cur.close(); c.close()
        return landing_html(error="expired"), 400

    # GET never consumes the token — email scanners pre-fetch links and would
    # burn the token before the pilot has a chance to click. The POST below
    # (triggered by the "Confirm check-in" button) is what actually signs them in.
    if request.method == "GET":
        cur.close(); c.close()
        body = landing_html(
            first_name=row["first_name"], last_name=row["last_name"],
            email=row["email"], purpose=row["purpose"], state="confirm",
            confirm_token=token,
        )
        resp = make_response(body)
        resp.headers["Content-Type"] = "text/html; charset=utf-8"
        return resp

    cur.execute("UPDATE magic_tokens SET used_at = NOW() WHERE id = %s", (row["tid"],))
    if row["email_verified_at"] is None:
        cur.execute(
            "UPDATE users SET email_verified_at = NOW(), last_login_at = NOW() WHERE id = %s",
            (row["user_id"],),
        )
    else:
        cur.execute("UPDATE users SET last_login_at = NOW() WHERE id = %s", (row["user_id"],))
    cur.close(); c.close()

    session_token = create_session(row["user_id"])
    body = landing_html(
        first_name=row["first_name"], last_name=row["last_name"],
        email=row["email"], purpose=row["purpose"],
    )
    resp = make_response(body)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    set_session_cookie(resp, session_token)
    return resp


@app.get("/api/auth/me")
def auth_me():
    u = current_user()
    if not u:
        return jsonify({"authenticated": False}), 200
    return jsonify({"authenticated": True, "user": {
        "id": u["id"], "email": u["email"],
        "first_name": u["first_name"], "last_name": u["last_name"],
    }}), 200


@app.post("/api/auth/logout")
def auth_logout():
    tok = request.cookies.get(SESSION_COOKIE_NAME)
    if not tok:
        hdr = request.headers.get("Authorization", "")
        if hdr.startswith("Bearer "):
            tok = hdr[7:]
    if tok:
        c = conn(); cur = c.cursor()
        cur.execute("DELETE FROM sessions WHERE token = %s", (tok,))
        cur.close(); c.close()
    resp = make_response(jsonify({"ok": True}))
    resp.set_cookie(SESSION_COOKIE_NAME, "", max_age=0,
                    httponly=True, secure=SESSION_COOKIE_SECURE, samesite="Lax", path="/")
    return resp


# ── plan routes ────────────────────────────────────────────────────────
@app.get("/api/ping")
def ping():
    return {"ok": True}


@app.get("/api/plans")
@require_user
def list_plans():
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT id, name, updated_at FROM flight_plans "
        "WHERE user_id = %s ORDER BY updated_at DESC",
        (request.user["id"],),
    )
    rows = cur.fetchall()
    for r in rows:
        r["updated_at"] = r["updated_at"].isoformat()
    cur.close(); c.close()
    return jsonify(rows)


@app.get("/api/plans/<int:pid>")
@require_user
def get_plan(pid):
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT id, name, updated_at, plan_json FROM flight_plans "
        "WHERE id = %s AND user_id = %s",
        (pid, request.user["id"]),
    )
    row = cur.fetchone()
    cur.close(); c.close()
    if not row:
        abort(404)
    row["updated_at"] = row["updated_at"].isoformat()
    row["plan_json"]  = json.loads(row["plan_json"])
    return jsonify(row)


@app.post("/api/plans")
@require_user
def create_plan():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, "name required")
    plan_json = json.dumps(body.get("plan_json") or {})
    c = conn(); cur = c.cursor()
    try:
        cur.execute(
            "INSERT INTO flight_plans (user_id, name, plan_json) VALUES (%s, %s, %s)",
            (request.user["id"], name, plan_json),
        )
        pid = cur.lastrowid
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY:
            abort(409, "name exists")
        raise
    finally:
        cur.close(); c.close()
    return jsonify({"id": pid, "name": name}), 201


@app.put("/api/plans/<int:pid>")
@require_user
def update_plan(pid):
    body = request.get_json(force=True) or {}
    plan_json = json.dumps(body.get("plan_json") or {})
    name = (body.get("name") or "").strip() or None
    c = conn(); cur = c.cursor()
    try:
        if name:
            cur.execute(
                "UPDATE flight_plans SET name = %s, plan_json = %s "
                "WHERE id = %s AND user_id = %s",
                (name, plan_json, pid, request.user["id"]),
            )
        else:
            cur.execute(
                "UPDATE flight_plans SET plan_json = %s "
                "WHERE id = %s AND user_id = %s",
                (plan_json, pid, request.user["id"]),
            )
        ok = cur.rowcount > 0
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY:
            abort(409, "name exists")
        raise
    finally:
        cur.close(); c.close()
    if not ok:
        abort(404)
    return {"ok": True}


@app.delete("/api/plans/<int:pid>")
@require_user
def delete_plan(pid):
    c = conn(); cur = c.cursor()
    cur.execute(
        "DELETE FROM flight_plans WHERE id = %s AND user_id = %s",
        (pid, request.user["id"]),
    )
    ok = cur.rowcount > 0
    cur.close(); c.close()
    if not ok:
        abort(404)
    return {"ok": True}


# ── landing page ───────────────────────────────────────────────────────
def landing_html(first_name="", last_name="", email="", purpose="verify",
                 error=None, state=None, confirm_token=None):
    template = pathlib.Path(__file__).with_name("landing.html").read_text()
    now = datetime.utcnow().strftime("%Y-%m-%d · %H:%M UTC")
    site = build_site_url() or "/"

    if error:
        titles = {
            "invalid": ("Clearance denied", "That link isn't recognised. It may have been typed wrong or already been superseded by a newer one."),
            "used":    ("Already on board", "This link has been used. If you need another, request a fresh sign-in link from the flight planner."),
            "expired": ("Clearance expired", "This link has timed out. Request a new one from the flight planner and we'll send a fresh link to your inbox."),
        }
        title, body = titles.get(error, titles["invalid"])
        state_cls, callsign, status = "error", "DENIED", "REJECTED"
        stamp_color = "#e0342c"
        greeting    = title
        subtitle    = body
        captain     = ""
        email_line  = ""
        cta_html    = f'<a href="{esc(site)}" class="cta">Back to flight planner <span class="arrow">→</span></a>'
    elif state == "confirm":
        # Interstitial: GET only. The button below POSTs to consume the token.
        state_cls, callsign, status = "ok", "PENDING", "CONFIRM"
        stamp_color = "#ffb020"
        if purpose == "verify":
            greeting = "One tap to take off."
            subtitle = "Confirm your check-in to activate your account and sign in on this device."
            cta_label = "Confirm & take off"
        else:
            greeting = "Ready when you are."
            subtitle = "Confirm to sign in to your flight planner on this device."
            cta_label = "Confirm & sign in"
        captain    = f"{first_name} {last_name}".strip()
        email_line = email
        # Empty action → POSTs back to the current URL, which already includes
        # the correct /velis-planner prefix (Nginx reverse proxy).
        cta_html   = (f'<form class="cta-form" method="POST" action="">'
                      f'<button type="submit" class="cta">{esc(cta_label)} <span class="arrow">→</span></button>'
                      f'</form>')
    else:
        state_cls, callsign, status = "ok", "CLEARED", "ACTIVE"
        stamp_color = "#7ed97a"
        if purpose == "verify":
            greeting = "Cleared for takeoff."
            subtitle = "Your Velis Electro flight planner account is verified and this device is signed in. Happy flying."
        else:
            greeting = "Welcome back, Captain."
            subtitle = "You're signed in on this device. Your saved plans are a click away."
        captain    = f"{first_name} {last_name}".strip()
        email_line = email
        cta_html   = f'<a href="{esc(site)}" class="cta">Continue to flight planner <span class="arrow">→</span></a>'

    replacements = {
        "{{STATE}}":       state_cls,
        "{{GREETING}}":    esc(greeting),
        "{{SUBTITLE}}":    esc(subtitle),
        "{{CAPTAIN}}":     esc(captain),
        "{{EMAIL}}":       esc(email_line),
        "{{CALLSIGN}}":    callsign,
        "{{STATUS}}":      status,
        "{{STAMP_COLOR}}": stamp_color,
        "{{TIMESTAMP}}":   now,
        "{{CTA_HTML}}":    cta_html,
    }
    out = template
    for k, v in replacements.items():
        out = out.replace(k, v)
    return out


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8003, debug=True)
