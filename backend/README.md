# flightplanner backend

Tiny Flask service that persists NAV plans for `velis_navplan.html` to a
shared MariaDB. See `../docs/FLIGHTPLANNER_BACKEND.md` for the full
architecture + VPS deploy flow.

## Local dev

Requires Python 3.12+ and a reachable MariaDB with DB + user created per
§3.1 of the backend doc (either local, or SSH-tunneled from the VPS:
`ssh -L 3306:127.0.0.1:3306 root@95.217.222.205`).

```bash
cd backend
pip install -r requirements.txt

export FLIGHTPLANNER_API_KEY=devkey
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_NAME=flightplanner_db
export DB_USER=flightplanner
export DB_PASSWORD=...

python app.py    # dev server on :8003
# or: gunicorn -b 0.0.0.0:8003 -w 2 app:app
```

The app auto-creates the `flight_plans` table at startup if missing.

### Pointing the frontend at local dev

In `velis_navplan.html`, before the script runs, set:

```html
<script>window.VELIS_API_BASE='http://localhost:8003/api';</script>
```

…or paste that in the devtools console before interacting. Without this
override the frontend hits `/velis-planner/api/*` (VPS path).

## Endpoints

All require `X-API-Key: <FLIGHTPLANNER_API_KEY>`. `X-Owner` scopes the
rows (defaults to `"default"`).

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| GET    | `/api/ping`          | —                              | `{ok:true}` |
| GET    | `/api/plans`         | —                              | `[{id,name,updated_at}, …]` |
| GET    | `/api/plans/:id`     | —                              | `{id,name,updated_at,plan_json}` |
| POST   | `/api/plans`         | `{name, plan_json}`            | `{id,name}` (201) · 409 on dup |
| PUT    | `/api/plans/:id`     | `{plan_json[, name]}`          | `{ok:true}` |
| DELETE | `/api/plans/:id`     | —                              | `{ok:true}` |

Unique key: `(owner, name)`. Renaming into an existing name ⇒ 409.

## Deploy

See `../docs/FLIGHTPLANNER_BACKEND.md` §5 (compose + nginx), §7 (first-
time VPS bring-up), and §8 (build order).
