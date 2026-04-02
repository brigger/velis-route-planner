# Pipistrel Velis Electro — 3-Leg Route Planner

A browser-based flight energy planner for the Pipistrel Velis Electro, supporting routes with up to two mountain passes (3 legs).

## Files

- `pipistrel_velis_3leg_v2.html` — original fragment (requires Claude's UI environment)
- `pipistrel_velis_3leg_v2_local.html` — standalone version, works directly in any browser

## How to run locally

Open `pipistrel_velis_3leg_v2_local.html` directly in your browser, **or** use live-server for auto-reload on save:

```bash
npx live-server /Users/patrick/Documents/Velis_Pipistrel_Route_Planner --open=pipistrel_velis_3leg_v2_local.html
```

> Requires Node.js. `npx` downloads `live-server` automatically on first run — no install needed.

The browser will reload instantly every time you save the file.

To stop the server: `Ctrl+C`

## Aircraft model

**Pipistrel Velis Electro**

| Parameter | Value |
|---|---|
| Nominal battery | 24.8 kWh |
| Cruise power | 40 kW @ 165 km/h |
| Climb power | 58 kW @ 270 ft/min SL |
| Climb ground speed | ~130 km/h |
| Descent power | 10 kW @ ~150 km/h |
| Descent rate | 300 ft/min |
| Service ceiling | ~14,000 ft (density-adjusted) |

## How it works

Each leg starts at the altitude where the previous leg ended (chained profile). The model computes energy for climb/descent phases first, then fills the remaining leg distance with cruise. There is no intermediate level cruise between passes — the profile is direct.

Energy is split into usable mission energy and a configurable reserve (default 20% SOC). The planner warns if the route exceeds the service ceiling or if energy margin is tight (< 12%).
