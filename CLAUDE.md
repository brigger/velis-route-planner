# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Pipistrel Velis Electro 3-Leg Route Planner — a static HTML/JS flight energy planner. No build system, no npm, no frameworks. Two HTML pages + one POH JSON data file.

## Development

```bash
npx live-server --open=index.html
```

Pages use `fetch()` to load `velis_electro_poh.json`, so they must be served over HTTP (not `file://`).

## Deployment

```bash
git push
ssh root@95.217.222.205 "cd /var/www/velis-planner && git pull"
```

VPS runs Nginx serving static files from `/var/www/velis-planner/`. URL: `http://95.217.222.205/velis-planner/`

## Architecture

### Data flow

```
velis_electro_poh.json → fetch() on page load → global JS vars
localStorage ←→ cross-page settings sync (OAT, cruise power, Vy, glide ratio)
Slider inputs → update() → interpolation → phase calculations → DOM render
```

### Files

- **`index.html`** — Route planner. Main calculation engine (~800 lines JS). Reads performance settings from localStorage, computes climb/cruise/descent energy per leg, renders SVG profile, SOC waterfall, detailed breakdown.
- **`velis_performance.html`** — Performance data editor. Displays POH tables (ROC, cruise power, %SOC). Writes settings to localStorage for index.html to consume.
- **`velis_electro_poh.json`** — Single source of truth for all aircraft performance data. Edit this file to update ROC table, cruise speeds, or %SOC values.

### Calculation engine (index.html)

All calculations happen in `update()`, called on every slider change:

1. `loadPOH()` — async init, populates `ROC`, `PWR`, `SOC_CRUISE`, `SOC_CLIMB_1K`, `SOC_TAKEOFF` from JSON
2. `calcClimb()` — integrates in 1,000 ft bands. Each band: interpolate ROC at (altitude, ISA deviation), scale reference %SOC by `600/actualROC`
3. `calcCruise()` — distance/speed = time, then `(time/10) × socPer10min`
4. `calcDescent()` — power-off glide: `distance = altitudeDelta × glideRatio / 6076.12`, energy = 0
5. Takeoff and approach %SOC added as fixed values from POH table

ISA deviation is computed once at departure altitude and held constant (standard lapse rate assumption).

### Interpolation functions

- `lerp(a, b, t)` — linear interpolation
- `bracket(pts, v)` — find array indices + fractional position for a value
- `interpROC(alt, isaDev)` — bilinear: altitude × ISA deviation → ft/min
- `interpSOH(vals, soh)` — linear: SOH% → %SOC consumption
- `interpCruiseKts(kw)` — power setting → cruise speed (KIAS)
- `socCruise10min(kw, soh)` — 2D: power × SOH → %SOC per 10 min

### Cross-page state

Pages share settings via localStorage keys: `velis_oat`, `velis_cruise_kw`, `velis_vy`, `velis_vglide`, `velis_glide_ratio`, `velis_soh`. Route planner state persists in `velis_route_state`.

Route save/load uses browser file download/upload (JSON files), not localStorage.

### Units

All distances in **nautical miles (nm)**, speeds in **knots (kts)**, altitudes in **feet (ft)**, energy in **%SOC**.

### Leg 2 toggle

When Leg 2 is disabled (checkbox unchecked), the code skips Leg 2 calculations and adjusts: `socs` array has 3 elements instead of 4, SVG draws 2-leg profile, Leg 3 becomes "Leg 2" in labels. Always use `socs[socs.length-1]` for arrival SOC, never `socs[3]`.
