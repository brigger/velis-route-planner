# `flightPlanner` Backend — Save / Load / Save As

Instruction doc for building a small, **self-contained** backend that lets
`velis_navplan.html` persist NAV plans to a server-side DB across browsers
and devices.

> **Scope guardrail — read first.** This project is **completely independent
> of SwissConnect**. No shared user table, no shared JWT, no shared DB. The
> only things reused from `vps-infrastructure` are:
>
> - the Docker host + `docker-compose.yml` (we add a new service to it)
> - the shared MariaDB container (we add a new DB + DB user — nothing else)
> - the host-level Nginx (we add one new location block under the existing
>   `brigger.com` site config)
>
> Every other piece — auth model, tables, code, secrets, deploy flow —
> lives only in this project.

---

## 1. High-level architecture

```
Browser (velis_navplan.html)
        │ fetch()  /velis-planner/api/*
        ▼
Nginx on VPS (brigger.com)
        │ proxy_pass → 127.0.0.1:8003
        ▼
flightplanner Docker container (Python/Flask/Gunicorn)
        │ MySQL connection
        ▼
mariadb container (shared) → flightplanner_db
```

- **Static pages** (`index.html`, `velis_navplan.html`, `velis_takeoff.html`,
  `velis_performance.html`) keep being served by Nginx from
  `/var/www/velis-planner/` — unchanged.
- **Only** the new `/velis-planner/api/*` location hits the backend.
- Plans are saved to `flightplanner_db.flight_plans` as a JSON blob — no
  normalization; the frontend is the single source of truth for the shape.

---

## 2. Open decisions (confirm before coding)

Two calls are still open. Defaults are in **bold**:

1. **Auth scope**
   - **(a) One shared API key** stored in `.env` on the VPS. Frontend
     prompts once for the key, stores it in `localStorage`, sends as
     `X-API-Key` header. Simplest; fine for 1–3 pilots who trust each
     other.
   - (b) Per-pilot accounts with email + password → JWT. More infra for
     little gain at this size.

   **Recommend (a).** Switch to (b) later if more pilots join.

2. **Which pages get Save/Load?**
   - **(a) NAV Plan only** (`velis_navplan.html`). Route Planner keeps
     using localStorage (+ its existing JSON file download).
   - (b) Also the Route Planner (`index.html`) state, in a second table.

   **Recommend (a).** Route Planner state auto-recomputes from current POH
   anyway; the value of persisting it is lower.

The rest of this doc assumes **(1a) + (2a)**. If you pick differently, see
§9 for what changes.

---

## 3. Database

### 3.1 One-time DB + user creation (on VPS)

Run once, after the first deploy (mirrors the SwissConnect pattern in
`vps-infrastructure/README.md` but against a **new DB** and user):

```bash
ssh root@95.217.222.205
cd /opt/docker
source .env           # has DB_ROOT_PASS + our new FLIGHTPLANNER_DB_*

docker exec -i mariadb mariadb -uroot -p"$DB_ROOT_PASS" <<SQL
CREATE DATABASE IF NOT EXISTS flightplanner_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$FLIGHTPLANNER_DB_USER'@'%'
  IDENTIFIED BY '$FLIGHTPLANNER_DB_PASS';
GRANT ALL PRIVILEGES ON flightplanner_db.*
  TO '$FLIGHTPLANNER_DB_USER'@'%';
FLUSH PRIVILEGES;
SQL
```

### 3.2 Schema (auto-created on first container boot)

```sql
CREATE TABLE IF NOT EXISTS flight_plans (
  id          INT            NOT NULL AUTO_INCREMENT,
  owner       VARCHAR(64)    NOT NULL DEFAULT 'default',
  name        VARCHAR(120)   NOT NULL,
  updated_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
                             ON UPDATE CURRENT_TIMESTAMP,
  plan_json   LONGTEXT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY  uniq_owner_name (owner, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- `owner` = free-text label (e.g. `"patrick"`, `"brigger"`). Lets us filter
  plans per pilot without a full user table. With shared-API-key auth this
  is just a label the pilot picks in the frontend once.
- `plan_json` holds the entire `state` object from `velis_navplan.html`
  (see `DEFAULT_STATE()` in that file — `{hdr, route, altn, comments, end}`).

---

## 4. Backend service

New directory in the repo: `backend/` at the repo root.

```
backend/
├── Dockerfile
├── requirements.txt
├── app.py
└── schema.sql          # copy of §3.2, loaded at startup if tables missing
```

### 4.1 `backend/requirements.txt`

```
flask==3.0.3
gunicorn==22.0.0
mysql-connector-python==9.0.0
```

### 4.2 `backend/Dockerfile`

```dockerfile
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py schema.sql ./

ENV PYTHONUNBUFFERED=1
EXPOSE 8003

CMD ["gunicorn", "-b", "0.0.0.0:8003", "-w", "2", "--access-logfile", "-", "app:app"]
```

### 4.3 `backend/app.py` (skeleton — ~80 LOC)

```python
import json, os, pathlib
from functools import wraps
from flask import Flask, request, jsonify, abort
import mysql.connector
from mysql.connector import errorcode

API_KEY = os.environ["FLIGHTPLANNER_API_KEY"]   # fail fast if missing
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

# Bootstrap: run schema.sql once on startup
def bootstrap():
    sql = pathlib.Path(__file__).with_name("schema.sql").read_text()
    c = conn(); cur = c.cursor()
    for stmt in sql.split(";"):
        if stmt.strip(): cur.execute(stmt)
    cur.close(); c.close()

bootstrap()

def require_key(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        if request.headers.get("X-API-Key") != API_KEY: abort(401)
        return fn(*a, **kw)
    return wrap

def owner_from_req():
    # Pilot label comes from header (set once by frontend), falls back to 'default'
    return (request.headers.get("X-Owner") or "default").strip()[:64]

@app.get("/api/ping")
def ping(): return {"ok": True}

@app.get("/api/plans")
@require_key
def list_plans():
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute("SELECT id, name, updated_at FROM flight_plans "
                "WHERE owner=%s ORDER BY updated_at DESC", (owner_from_req(),))
    rows = cur.fetchall()
    # Normalize datetime for JSON
    for r in rows: r["updated_at"] = r["updated_at"].isoformat()
    cur.close(); c.close()
    return jsonify(rows)

@app.get("/api/plans/<int:pid>")
@require_key
def get_plan(pid):
    c = conn(); cur = c.cursor(dictionary=True)
    cur.execute("SELECT id, name, updated_at, plan_json FROM flight_plans "
                "WHERE id=%s AND owner=%s", (pid, owner_from_req()))
    row = cur.fetchone(); cur.close(); c.close()
    if not row: abort(404)
    row["updated_at"] = row["updated_at"].isoformat()
    row["plan_json"] = json.loads(row["plan_json"])
    return jsonify(row)

@app.post("/api/plans")
@require_key
def create_plan():
    body = request.get_json(force=True)
    name = (body.get("name") or "").strip()
    if not name: abort(400, "name required")
    plan_json = json.dumps(body.get("plan_json") or {})
    c = conn(); cur = c.cursor()
    try:
        cur.execute("INSERT INTO flight_plans (owner, name, plan_json) "
                    "VALUES (%s, %s, %s)", (owner_from_req(), name, plan_json))
        pid = cur.lastrowid
    except mysql.connector.IntegrityError as e:
        if e.errno == errorcode.ER_DUP_ENTRY: abort(409, "name exists")
        raise
    finally:
        cur.close(); c.close()
    return jsonify({"id": pid, "name": name}), 201

@app.put("/api/plans/<int:pid>")
@require_key
def update_plan(pid):
    body = request.get_json(force=True)
    plan_json = json.dumps(body.get("plan_json") or {})
    name = (body.get("name") or "").strip() or None
    c = conn(); cur = c.cursor()
    if name:
        cur.execute("UPDATE flight_plans SET name=%s, plan_json=%s "
                    "WHERE id=%s AND owner=%s",
                    (name, plan_json, pid, owner_from_req()))
    else:
        cur.execute("UPDATE flight_plans SET plan_json=%s "
                    "WHERE id=%s AND owner=%s",
                    (plan_json, pid, owner_from_req()))
    ok = cur.rowcount > 0
    cur.close(); c.close()
    if not ok: abort(404)
    return {"ok": True}

@app.delete("/api/plans/<int:pid>")
@require_key
def delete_plan(pid):
    c = conn(); cur = c.cursor()
    cur.execute("DELETE FROM flight_plans WHERE id=%s AND owner=%s",
                (pid, owner_from_req()))
    ok = cur.rowcount > 0
    cur.close(); c.close()
    if not ok: abort(404)
    return {"ok": True}
```

### 4.4 `backend/schema.sql`

Copy of the `CREATE TABLE` in §3.2.

---

## 5. Infrastructure integration

### 5.1 `vps-infrastructure/docker-compose.yml` — add block

```yaml
  flightplanner:
    build: ./flightplanner
    restart: always
    ports:
      - "127.0.0.1:8003:8003"
    depends_on:
      mariadb:
        condition: service_healthy
    environment:
      DB_HOST: mariadb
      DB_PORT: 3306
      DB_NAME: flightplanner_db
      DB_USER: ${FLIGHTPLANNER_DB_USER}
      DB_PASSWORD: ${FLIGHTPLANNER_DB_PASS}
      FLIGHTPLANNER_API_KEY: ${FLIGHTPLANNER_API_KEY}
```

The `./flightplanner` build context on the VPS will be a clone of this
repo's `backend/` directory (see §7 deployment for how it gets there).

### 5.2 `.env` additions on VPS (`/opt/docker/.env`)

```
FLIGHTPLANNER_DB_USER=flightplanner
FLIGHTPLANNER_DB_PASS=<openssl rand -hex 16>
FLIGHTPLANNER_API_KEY=<openssl rand -hex 24>
```

### 5.3 Nginx — add to the `brigger.com` server block

The static site already serves `/velis-planner/` from `/var/www/velis-planner/`.
Add a sibling location for the API:

```nginx
location /velis-planner/api/ {
    proxy_pass http://127.0.0.1:8003/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Reload:

```bash
ssh root@95.217.222.205 "nginx -t && systemctl reload nginx"
```

---

## 6. Frontend wiring (`velis_navplan.html`)

Replace the current `Clear form` / `Print` toolbar with a more complete
row (keep Clear + Print, add Save / Save As / Load). Minimal plan:

1. **Settings modal** (one-time): prompts for `API Key` and `Owner label`
   (the pilot's short name). Persisted in
   `localStorage.velis_navplan_auth = {key, owner}`.
2. **Helper**:
   ```js
   async function api(path, opts = {}) {
     const auth = JSON.parse(localStorage.getItem('velis_navplan_auth') || '{}');
     const r = await fetch('/velis-planner' + path, {
       ...opts,
       headers: {
         'Content-Type': 'application/json',
         'X-API-Key':   auth.key   || '',
         'X-Owner':     auth.owner || 'default',
         ...(opts.headers || {}),
       },
     });
     if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
     return r.json();
   }
   ```
3. **Buttons**:
   - **Save** — if `state.id` exists, `PUT /api/plans/:id`; else prompt
     for a name and `POST`.
   - **Save as…** — always prompt for a name, `POST /api/plans`. On
     `409 name exists`, re-prompt.
   - **Load…** — `GET /api/plans`, show a small list modal with
     `name` + relative `updated_at`; on click → `GET /api/plans/:id` →
     merge into `state` via a `hydrate(s)` helper → `renderWP()` +
     `refreshEndurance()`.
4. **Dirty indicator** — after Save, set a `state.id` + `state.savedAt`;
   on any input change, mark "● unsaved" in the toolbar status span.
5. **Keep localStorage autosave** as a draft-safety net (no change to the
   existing `saveState()` calls).

### Development tip

During local dev (`npx live-server`), point the API helper at
`http://localhost:8003` instead of `/velis-planner/api` via a
`window.VELIS_API_BASE` override; otherwise CORS will block.

---

## 7. Deployment

### 7.1 Where the backend lives on the VPS

Two options; pick whichever is simpler operationally:

**Option A — subdirectory of this repo** (recommended):
keep `backend/` inside `brigger/velis-route-planner`. On the VPS, clone
the repo into `/opt/docker/flightplanner` so Docker-compose's
`build: ./flightplanner` points at it.

```bash
ssh root@95.217.222.205
cd /opt/docker
git clone git@github.com:brigger/velis-route-planner.git flightplanner-src
ln -s flightplanner-src/backend flightplanner
```

Updates:
```bash
ssh root@95.217.222.205 \
  "cd /opt/docker/flightplanner-src && git pull && \
   cd /opt/docker && docker compose build flightplanner && \
   docker compose up -d flightplanner"
```

**Option B — separate repo `brigger/flightplanner-backend`.**
Cleaner domain separation. Copy `backend/` into that repo at init and
use a dedicated deploy key (`github-flightplanner`) per the pattern in
`vps-infrastructure/README.md` §"SSH Deploy-Keys".

### 7.2 First-time bring-up (run on VPS)

```bash
ssh root@95.217.222.205

# 1. Clone (Option A)
cd /opt/docker && git clone git@github.com:brigger/velis-route-planner.git flightplanner-src
ln -s flightplanner-src/backend flightplanner

# 2. Add secrets to /opt/docker/.env (see §5.2)
vi /opt/docker/.env

# 3. Create DB + user (§3.1)
source /opt/docker/.env
docker exec -i mariadb mariadb -uroot -p"$DB_ROOT_PASS" <<SQL
CREATE DATABASE IF NOT EXISTS flightplanner_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$FLIGHTPLANNER_DB_USER'@'%'
  IDENTIFIED BY '$FLIGHTPLANNER_DB_PASS';
GRANT ALL PRIVILEGES ON flightplanner_db.* TO '$FLIGHTPLANNER_DB_USER'@'%';
FLUSH PRIVILEGES;
SQL

# 4. Wire into compose (§5.1) — commit + push vps-infrastructure, then pull on VPS
cd /opt/docker && git pull
docker compose build flightplanner
docker compose up -d flightplanner
docker compose logs -f flightplanner    # expect "Listening at http://0.0.0.0:8003"

# 5. Nginx (§5.3)
# Edit /etc/nginx/sites-available/brigger.com to add the new location
nginx -t && systemctl reload nginx

# 6. Smoke test
curl -s https://brigger.com/velis-planner/api/ping
# {"ok": true}

curl -s https://brigger.com/velis-planner/api/plans \
  -H "X-API-Key: $FLIGHTPLANNER_API_KEY" \
  -H "X-Owner: patrick"
# []
```

---

## 8. Build order (from a fresh clone on another machine)

1. Pull this repo; read this doc.
2. **Confirm the two open decisions in §2.**
3. Create `backend/` with the four files from §4.
4. Run the backend locally:
   ```bash
   cd backend
   pip install -r requirements.txt
   export DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=flightplanner_db \
          DB_USER=… DB_PASSWORD=… FLIGHTPLANNER_API_KEY=devkey
   python app.py    # or: gunicorn -b 0.0.0.0:8003 app:app
   ```
   Either stand up a local MariaDB, or SSH-tunnel to the VPS:
   `ssh -L 3306:127.0.0.1:3306 root@95.217.222.205`.
5. Wire the frontend (§6).
6. When happy, update `vps-infrastructure`:
   - Add the `flightplanner` service to `docker-compose.yml` (§5.1).
   - Add the `/velis-planner/api/` block to `nginx/brigger.com.conf`
     (§5.3).
   - Commit + push that repo.
7. On the VPS, follow §7.2.

---

## 9. What changes if you pick different §2 options

- **Per-pilot JWT auth (1b)** instead of shared key:
  - Add a `users` table (id, email, password_hash).
  - Add `POST /api/auth/login` returning a signed JWT.
  - Replace `X-API-Key` with `Authorization: Bearer <jwt>` in both
    backend and frontend.
  - Add `JWT_SECRET_KEY` to `.env`.
  - Extra ~80 LOC, one extra table, but no shared infra with
    SwissConnect — they stay independent.
- **Also persist Route Planner state (2b)**:
  - Add a second table `route_plans (id, owner, name, updated_at,
    plan_json, UNIQUE(owner, name))`.
  - Mirror the plans routes under `/api/routes/*`.
  - Add three buttons to `index.html` next to its existing JSON
    download.

---

## 10. Status snapshot (2026-04-17)

Done in the frontend so far (NAV Plan page):
- Printable A4-landscape layout: NAV Flightplan (left) + Endurance
  Calculator (right), with screen-only toggle between the two halves.
- Waypoint table with DEP / intermediates / auto-totals / ALTN rows,
  add/delete intermediate, per-row ALT trend toggle (↗ / ↘ / ·), ATO
  column for hand-written "actual time over".
- Endurance Calculator: Fuel vs Electric modes.
  - Fuel: `Fuel flow` + `Total fuel`, Qty = Time × FF, classic
    Trip / Alt / Final-reserve-45 / Min / Extra / Actual.
  - Electric: `Avg power` + `Total SOC`, Trip SOC pulled from Route
    Planner's `velis_total_kwh`, Alt SOC derived, Reserve 30 % SOC
    below Min, no Extra row, Actual = Min + Reserve.
- Comments box, header fields (ACFT / Type / Pilot / Date / Hobbs /
  Start / End / RWY / QNH / Wind), print margins 2 cm top + 1 cm left.
- localStorage autosave of the whole form (`velis_navplan_state`).

**Not done** — this doc: the backend, its deployment, and the
frontend Save / Load / Save As buttons.
