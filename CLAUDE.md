# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Pipistrel Velis Electro flight planner — four static HTML pages + two shared JS modules, backed by a small Flask service for cross-device plan storage. No build system, no npm, no frameworks. Plain HTML/JS/CSS, POH data in a single JSON file.

## Development

```bash
npx live-server --open=index.html
```

All pages `fetch('velis_electro_poh.json')`, so they must be served over HTTP (not `file://`). Backend is optional in dev — the Save/Load FAB just fails politely if the API is unreachable. To run the backend locally see `backend/README.md`; to point the frontend at a local backend set `window.VELIS_API_BASE = 'http://localhost:8003/api'` in the devtools console before interacting.

## Deployment

Static site — VPS runs Nginx serving `/var/www/velis-planner/`:

```bash
git push
ssh root@95.217.222.205 "cd /var/www/velis-planner && git pull"
```

Backend — Docker Compose service `flightplanner` on the same VPS (`/opt/docker/docker-compose.yml`), listens on `127.0.0.1:8003`, reverse-proxied by Nginx at `/velis-planner/api/`. Rebuild after changing `backend/`: `ssh root@95.217.222.205 "cd /opt/docker/flightplanner-src && git pull && cd /opt/docker && docker compose build flightplanner && docker compose up -d flightplanner"`.

## Architecture

### Pages (frontend)

| File | Purpose |
| ---- | ------- |
| `index.html` | **Route Planner**. Sliders for SOH / SOC / reserve / OAT / cruise kW / dep-alt, dynamic leg cards, destination, approach. Computes per-leg energy, writes derived values (`velis_total_kwh`, `velis_usable_kwh`, `velis_soc0_pct`…) to localStorage for other pages. |
| `velis_takeoff.html` | **Takeoff & Landing**. Sliders for alt / OAT / wind / slope / surface / condition. Renders POH tables + SVG profiles. Computation lives in `takeoff_calc.js`. |
| `velis_navplan.html` | **NAV Plan** (paper-style flight plan). Header, waypoint table, Endurance calculator (Fuel + Electric modes), Sky Demon text-import, Totals row with REMARKS, Block-time annotations, embedded TO/LDG mini-pictures (via `takeoff_calc.js`). Print target: A4 landscape. |
| `velis_performance.html` | **Performance** — reference tables (ROC, cruise power, %SOC per phase, computed summary). Read-only for cruise power; the slider lives on the Route Planner. |

### Shared JS modules

- **`plan_sync.js`** — loaded by every page. Injects a floating disc (FAB) top-right of the viewport, a slim plan-status line in the nav bar, a settings modal and a load-plan modal. Owns `api()`, auth helpers, `doSave` / `doSaveAs` / `doLoad`, dirty tracking, Cmd/Ctrl+S shortcut. Exposes `window.velisPlan = { save, saveAs, load, openSettings, markDirty, markSaved, bundleDirty, updateStatus }`.
- **`takeoff_calc.js`** — POH loader + `computeTakeoff` / `computeLanding` + `drawTakeoff` / `drawLanding` SVG renderers + `readState()` (reads `velis_takeoff`). Exposed at `window.takeoffCalc`. Used by the NAV Plan for its mini-pictures; the Takeoff page still has its own inline functions (intentional — lets it keep showing the step-by-step detailed calculation).

### Backend (`backend/`)

Flask + Gunicorn, MySQL connector to the shared MariaDB container. Single `flight_plans` table: `id`, `owner`, `name`, `updated_at`, `plan_json` (LONGTEXT). Auth is a shared API key via `X-API-Key`; `owner` is a per-user label the pilot picks in the settings modal. Endpoints: `GET /api/ping`, `GET /api/plans`, `GET /api/plans/:id`, `POST /api/plans`, `PUT /api/plans/:id`, `DELETE /api/plans/:id`. Duplicate `(owner, name)` → 409. Full detail in `backend/README.md`.

### Save / Load bundle

The backend just stores JSON blobs. `plan_sync.js` builds and applies them:

```
{
  version: 2,
  navplan:      <NAV Plan state minus meta>,
  localStorage: { <every velis_* key except auth / view / dirty-timestamps> }
}
```

`velis_navplan_state` is *included* in `bundle.localStorage`. NAV Plan flushes its in-memory state via the `velis:before-save` event before the bundle is collected; on load, every `velis_*` key is written back, then `velis:after-load` fires and each page re-reads its own slice.

### Cross-page state

- **Shared localStorage keys** (all prefixed `velis_`): `velis_route_state`, `velis_takeoff`, `velis_navplan_state`, `velis_vy`, `velis_vx`, `velis_vglide`, `velis_glide_ratio`, `velis_cruise_kw`, `velis_soh`, `velis_oat`, `velis_total_kwh`, `velis_usable_kwh`, `velis_total_min`, `velis_total_dist`, `velis_soc0_pct`, `velis_reserve_pct`.
- **Excluded from the save bundle**: `velis_navplan_auth` (per-browser API key + owner label), `velis_navplan_view` (NAV Plan on-screen view toggle), `velis_bundle_mtime` / `velis_bundle_stime` (dirty-tracking timestamps).
- **Dirty indicator**: any page mutating state calls `window.velisPlan.markDirty()`, which bumps `velis_bundle_mtime`. A successful Save / Load bumps `velis_bundle_stime`. The disc and nav-bar status show a dot when `mtime > stime`.
- **Events dispatched on `document`**: `velis:before-save` (pages flush in-memory state to localStorage) and `velis:after-load` (pages re-read localStorage and re-render). NAV Plan is the only page that needs `before-save`; all four pages listen for `after-load` so loading from any page refreshes them in place.

### Calculation engine (`index.html` Route Planner)

`update()` runs on every slider change. Computes per leg: climb (1,000 ft bands, ROC interpolated at altitude × ISA deviation, `%SOC = ref × 600 / actualROC`) → cruise (`time × socPer10min / 10`) → descent (power-off glide, `nm = ΔAlt × glideRatio / 6076.12`, 0 %SOC). Takeoff / approach %SOC added once. ISA deviation is computed at departure altitude and held constant across the profile.

Interpolation helpers: `lerp`, `bracket`, `interpROC` (bilinear), `interpSOH`, `interpCruiseKts`, `socCruise10min` (2D power × SOH). All read from the POH JSON loaded once on init.

### Units

Distances in **nm**, speeds in **kts**, altitudes in **ft**, energy in **%SOC**.

## Conventions worth knowing

- **Page bottom padding**: every page has `body { padding:0 0 48px; }` to leave room for the FAB — don't remove it.
- **Print styles on NAV Plan**: A4 landscape, 1 cm top / left margins only, both halves (`.nav-half` + `.fuel-half`) forced visible. Backgrounds are preserved via `-webkit-print-color-adjust:exact` on `.wp th`, the Endurance header rows, and the Totals row grey.
- **No backwards-compat code** in the save-bundle path — every saved plan is v2 shape.
- **`Sky Demon import`** is text-paste only, NAV Plan page. Parser (`parseSkyDemon`) detects data rows by the wind token (`XXX/XX`) and aligns columns around it.
- **The Route Planner route is dynamic N-leg** (not fixed 3). Legs are stored in a top-level `legs` array and rendered via `renderLegs()`.

## Editing the POH data

`velis_electro_poh.json` is the single source of truth for: battery capacity, ROC table (altitude × ISA deviation), cruise power settings, and the `soc_phases` list (takeoff / 1000 ft climb / 10-min cruise @ 20/25/30/35 kW / straight-in / traffic-pattern). Any edits propagate the moment you reload a page. Takeoff / landing distance tables are under `poh.takeoff` / `poh.landing` in the same file.
