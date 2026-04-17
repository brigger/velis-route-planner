import json
import os
import pathlib
import time
from functools import wraps

from flask import Flask, request, jsonify, abort
import mysql.connector
from mysql.connector import errorcode

API_KEY = os.environ["FLIGHTPLANNER_API_KEY"]
DB = dict(
    host=os.environ["DB_HOST"],
    port=int(os.environ.get("DB_PORT", 3306)),
    database=os.environ["DB_NAME"],
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    autocommit=True,
)

app = Flask(__name__)


def conn():
    return mysql.connector.connect(**DB)


def bootstrap():
    sql = pathlib.Path(__file__).with_name("schema.sql").read_text()
    last_err = None
    for attempt in range(30):
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
    raise RuntimeError(f"DB bootstrap failed after retries: {last_err}")


bootstrap()


def require_key(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        if request.headers.get("X-API-Key") != API_KEY:
            abort(401)
        return fn(*a, **kw)
    return wrap


def owner_from_req():
    return (request.headers.get("X-Owner") or "default").strip()[:64] or "default"


@app.get("/api/ping")
def ping():
    return {"ok": True}


@app.get("/api/plans")
@require_key
def list_plans():
    c = conn()
    cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT id, name, updated_at FROM flight_plans "
        "WHERE owner=%s ORDER BY updated_at DESC",
        (owner_from_req(),),
    )
    rows = cur.fetchall()
    for r in rows:
        r["updated_at"] = r["updated_at"].isoformat()
    cur.close()
    c.close()
    return jsonify(rows)


@app.get("/api/plans/<int:pid>")
@require_key
def get_plan(pid):
    c = conn()
    cur = c.cursor(dictionary=True)
    cur.execute(
        "SELECT id, name, updated_at, plan_json FROM flight_plans "
        "WHERE id=%s AND owner=%s",
        (pid, owner_from_req()),
    )
    row = cur.fetchone()
    cur.close()
    c.close()
    if not row:
        abort(404)
    row["updated_at"] = row["updated_at"].isoformat()
    row["plan_json"] = json.loads(row["plan_json"])
    return jsonify(row)


@app.post("/api/plans")
@require_key
def create_plan():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, "name required")
    plan_json = json.dumps(body.get("plan_json") or {})
    c = conn()
    cur = c.cursor()
    try:
        cur.execute(
            "INSERT INTO flight_plans (owner, name, plan_json) VALUES (%s, %s, %s)",
            (owner_from_req(), name, plan_json),
        )
        pid = cur.lastrowid
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY:
            abort(409, "name exists")
        raise
    finally:
        cur.close()
        c.close()
    return jsonify({"id": pid, "name": name}), 201


@app.put("/api/plans/<int:pid>")
@require_key
def update_plan(pid):
    body = request.get_json(force=True) or {}
    plan_json = json.dumps(body.get("plan_json") or {})
    name = (body.get("name") or "").strip() or None
    c = conn()
    cur = c.cursor()
    try:
        if name:
            cur.execute(
                "UPDATE flight_plans SET name=%s, plan_json=%s "
                "WHERE id=%s AND owner=%s",
                (name, plan_json, pid, owner_from_req()),
            )
        else:
            cur.execute(
                "UPDATE flight_plans SET plan_json=%s "
                "WHERE id=%s AND owner=%s",
                (plan_json, pid, owner_from_req()),
            )
        ok = cur.rowcount > 0
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY:
            abort(409, "name exists")
        raise
    finally:
        cur.close()
        c.close()
    if not ok:
        abort(404)
    return {"ok": True}


@app.delete("/api/plans/<int:pid>")
@require_key
def delete_plan(pid):
    c = conn()
    cur = c.cursor()
    cur.execute(
        "DELETE FROM flight_plans WHERE id=%s AND owner=%s",
        (pid, owner_from_req()),
    )
    ok = cur.rowcount > 0
    cur.close()
    c.close()
    if not ok:
        abort(404)
    return {"ok": True}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8003, debug=True)
