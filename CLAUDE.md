# CLAUDE.md

Context for working in this repo. Read this before making changes — several
bugs have already been found and fixed here that look like reasonable things
to "simplify" if you don't know why they're there.

## What this is

A static, offline-first train timetable PWA covering five UK rail routes,
served entirely from GitHub Pages with no backend server. Two independent
data layers feed it:

1. **Schedule (slow-changing)**: a GitHub Action runs weekly, queries the
   RealTimeTrains API server-side using a repo secret, and commits a
   refreshed `data/schedule.json` back into the repo. This is what makes the
   timetable never go stale without a human re-uploading a PDF.
2. **Live (fast-changing)**: platforms, delays, and cancellations are fetched
   directly from the visitor's own browser against Darwin (National Rail)
   via the Rail Data Marketplace REST API, using a personal API key each
   visitor pastes in and stores in their own `localStorage`. Never touches
   the repo or the Action.

These two layers exist on purpose and should stay separate. Don't try to
unify them into one fetch path — they have different freshness needs,
different auth models, and different failure-degradation requirements.

## File map

| File | Role |
|---|---|
| `index.html` | App shell. Also contains the inline bootstrap-cache script (see below). |
| `styles.css` | All styling. Single file, no preprocessor. |
| `app.js` | All client logic: rendering, overtaking, live overlay, settings. |
| `sw.js` | Service worker — stale-while-revalidate caching. |
| `routes.json` | Route config: `{id, name, from, to, change, minConnectionMins}`. Edit this to add/change routes — no other code changes needed for a direct route. |
| `stations.json` | CRS code → display name. Add an entry whenever you add a station to `routes.json`. |
| `data/schedule.json` | Generated output. Don't hand-edit — it's overwritten by the Action every run. Ships with an empty-arrays placeholder (`is_seed_placeholder: true`) until the Action runs for real. |
| `scripts/fetch_schedule.py` | Runs in the Action. Queries RTT, writes `data/schedule.json`. |
| `.github/workflows/update-schedule.yml` | Weekly cron (Mondays 04:00 UTC) + manual trigger. |

## Two separate credentials — don't mix them up

- **RTT refresh token**: GitHub repo secret (`RTT_TOKEN`). Used only by
  `fetch_schedule.py` inside the Action. Register at `api-portal.rtt.io`.
  Server-side, never reaches a browser. This is a long-lived *refresh*
  token, not a Bearer token usable directly against `data.rtt.io` — it must
  be exchanged for a short-lived (~20 min) access token via
  `GET /api/get_access_token` first. See `_headers()` in
  `fetch_schedule.py`, which does this exchange on demand.
- **Darwin consumer key**: pasted by each visitor into the settings panel
  (⚙ icon), stored in their own `localStorage` under `darwinApiKey`. Never
  stored in the repo, never sent anywhere except directly from that
  visitor's browser to `api1.raildata.org.uk`.

If you're ever tempted to put a Darwin key in a repo secret or env var —
don't. It has to be per-visitor because of CORS/ToS constraints already
worked through; see the "why" notes in `fetch_schedule.py`'s docstring for
the RTT side of this and the commit history for the CORS investigation.

## 3am timetable day convention

Each timetable day runs **03:00–02:59**, not midnight–midnight. A late-night
service at 01:30 on calendar 2026-07-02 is stored under `date = "2026-07-01"`.

This affects three things in tandem — all three must stay consistent:

**In `fetch_schedule.py`**: `day_window(tday)` queries from `tday T03:00` to
`tday+1 T02:59`. The `date` stored in each leg is `tday.isoformat()` — the
calendar date of the 03:00 start. `depM`/`arrM` for 00:00–02:59 are stored
as 1440+ (01:30 → 1530), so chronological sort order within a day is correct
without any special-casing in the render loop.

**In `app.js` `todayStr()`**: before 03:00, returns yesterday's date, so the
client filters the correct schedule day. Changing this to a plain `new Date()`
would cause the date picker and NOW-line to break in the early hours.

**In `app.js` `nowM()` and `secsUntil()`**: before 03:00, returns
`raw + 1440`, so comparison against 1440+ depM values is correct. Changing
either without the other will cause wrong "past/next/upcoming" classification
for late-night trains.

**RTT deep links use `leg.serviceDate`, not `leg.date`**. `serviceDate` is
`scheduleMetadata.departureDate` from the API — the actual calendar date the
service departs from its origin. For a service originating the previous day,
this differs from the timetable day label. Using `leg.date` for the RTT URL
would give a 404 for any such service.

## New RTT API (data.rtt.io)

The script uses the new-generation API, not the old `api.rtt.io` endpoint.
Key differences:

- Base URL: `https://data.rtt.io`
- Auth: two-step. `RTT_TOKEN` is a refresh token; exchange it via
  `GET /api/get_access_token` (sent as `Authorization: Bearer {RTT_TOKEN}`)
  for a short-lived access token (`{token, entitlements, validUntil}`),
  then send *that* as `Authorization: Bearer {token}` on data calls. The
  access token is only valid ~20 minutes, far shorter than a full run, so
  `_headers()` refreshes it on demand rather than once at startup.
- Endpoint: `GET /gb-nr/location` with query params `code`, `timeFrom`,
  `timeTo` — **no `filterTo`/`filterFrom`**. The response schema only
  carries `temporalData` for the queried `code` location (confirmed
  against the API spec — there's no field anywhere with a service's full
  calling pattern), so those filters only narrow which services come back;
  they don't add anything a uid join can't already get from an unfiltered
  query. Don't reintroduce them as a "simplification" — see below.
- Times: ISO 8601 datetimes, not HHMM strings
- Platforms: `locationMetadata.platform.planned` / `.actual` objects
- Cancellation: `temporalData.displayAs === "CANCELLED"` or
  `temporalData.departure.isCancelled`
- Service UID: `scheduleMetadata.identity` (used in RTT deep links)
- Service date for links: `scheduleMetadata.departureDate`

One unfiltered call per (station, day), cached in `_station_day_cache` and
shared across every route touching that station — `fetch_station_day()`
parses each station's full board once into a departure index and an
arrival index (both keyed by uid). `fetch_legs(origin, destination, tday)`
then does an **inner join** on uid between origin's departures and
destination's arrivals: a uid must appear in both to become a leg, since
an unfiltered departure list contains services going everywhere, not just
towards that destination. For the 5 routes configured today this means 8
distinct stations fetched once each per day instead of 12 origin/destination
pairs fetched separately (~2x fewer calls than one-call-per-pair, ~3x fewer
than the original two-calls-per-leg design) — don't go back to per-route
filtered queries as a "simplification," it multiplies calls for any station
shared by more than one route.

Matched by `scheduleMetadata.identity`. The rate-limit handling in
`_adjust_delay()` reads both `X-RateLimit-Remaining-Minute` (pauses 20s
outright if ≤2 left — 30/min is the tightest, most immediate cap) and
`X-RateLimit-Remaining-Hour` (pauses until the next wall-clock hour outright
if it hits 0); `api_get()` also retries on 429 using the `Retry-After`
header. Confirmed live against the API: entitlements carry limits of
30/minute, 750/hour, 9000/day, 30000/week. A full run makes ~720 calls (8
stations × 90 days), under the hourly cap — the request pace (2s flat, no
graduated ramp) is deliberately not backed off pre-emptively as the hourly
budget runs low, since this account is only shared with occasional manual
testing, not other concurrent automated consumers. The `update-schedule.yml`
workflow's `concurrency` group is what actually prevents two Action runs
racing this same budget — don't remove that lock without reintroducing some
other protection against overlapping runs.

## Caching strategy — stale-while-revalidate, not network-first

`sw.js` serves cached responses **instantly**, with zero network wait, then
refreshes the cache in the background for next time. This was a deliberate
fix for a real problem: network-first (try network, wait for it to fail,
THEN fall back to cache) feels broken on slow/flaky connections because the
"wait for it to fail" step can take many seconds even though a perfectly
good cached copy exists.

**Implication**: a schedule update is never visible on the load that
triggered the background refetch — only on the load after that. This is
fine for data that changes a few times a year; don't "fix" it by adding a
cache-busting query string or similar, you'll just bring back the slow-load
problem.

The bootstrap-cache script inline in `index.html` (after the SW
registration) exists for a separate reason: the very first page load can
race ahead of the service worker finishing activation, so that one
navigation never passes through the SW's fetch handler at all. This is an
activation-timing fix, unrelated to the caching *strategy* — don't remove it
when touching `sw.js`.

If you add new static files the app depends on, add them to the `urls`
array in that bootstrap script too, or first-ever offline visits won't have
them cached.

## Route types: direct vs connection

`routes.json`'s `change` field (null vs a CRS code) determines which code
path a route takes through `app.js`. Direct routes use `directCard()` /
`overtakers()` / `applyDirectOverlay()`. Connection routes (currently only
`rdg-hoh`, Reading↔Henley via Twyford) use `connectionCard()` /
`applyConnectionOverlay()`, and `fetch_schedule.py` pre-pairs legs at fetch
time using `minConnectionMins` from the route config — the client never
does connection-pairing itself, only live-delay projection onto an
already-paired leg.

**Overtaking only applies to direct routes.** A connection route's
"fastest" comparison would mean comparing different leg-1/leg-2 pairings
against each other, which is a different problem that hasn't been built.
Don't extend `overtakers()` to connection routes without designing that
properly first — it's not a small generalization.

## Known-correct-on-purpose things that look like bugs

- **`overtakers()` excludes `_cancelled` legs.** This was a real bug once:
  a cancelled train counted as a valid "faster alternative" and could hide
  a perfectly catchable real train. Don't remove the `!o._cancelled` check.
- **Cancellation is detected via `etd === 'Cancelled'`**, not just an
  `isCancelled`-style boolean field. The boolean field's exact name in the
  REST API response was never confirmed against a live payload — `etd`
  string comparison is the well-documented Darwin convention and is the
  reliable check. Keep both checks; don't simplify to just the boolean.
- **Station labels in `directCard`/`connectionCard` are direction-aware**
  (`dir === 'out' ? route.from : route.to`). This was a real bug — labels
  used to always show `route.from`/`route.to` regardless of which way the
  Return tab was actually going. Any new card-rendering code must take
  `dir` into account the same way.
- **"Next train" selection skips both cancelled and overtaken-slower
  legs**, falling back to a slower one only if nothing else qualifies. Two
  separate `.find()` calls, intentionally, not one clever combined filter —
  keep them separate for readability when modifying.

## Unverified assumptions — check these against real data, don't assume

The sandbox used to build this can't reach `rtt.io` or `raildata.org.uk`,
so the following are from docs and inference, not tested against live responses:

- **Darwin REST field names** `platformIsConfirmed` / `platformIsChanged` —
  inferred from the SOAP equivalents. If platforms show but never update to
  confirmed/changed, `console.log` the raw `fetchBoard()` response and check
  the actual field names.

The following were originally unverified assumptions and have since been
confirmed against the live API:

- **Auth exchange, uid-join, and `arr`/`arrM` population** — the two-step
  refresh→access token exchange, the unfiltered-per-station-then-join
  approach in `fetch_station_day`/`fetch_legs`, and `arr`/`arrM` being
  populated for the great majority of legs were all confirmed against real
  `data.rtt.io` responses.
- **RTT rate limits for the new API** — confirmed live: 30/minute,
  750/hour, 9000/day, 30000/week (`X-RateLimit-Limit-*` headers). The pacing
  in `_adjust_delay()` is tuned against these real numbers. The hourly
  window's reset timing is *not* confirmed (no reset-time header exists) —
  `_seconds_until_next_hour()`'s wall-clock-hour assumption is inferred from
  observed behaviour, not documented, and falls back to `api_get()`'s
  429/`Retry-After` handling if it's wrong.

## Known limitations, not bugs

- Darwin's departure board returns roughly the next 20 services from "now."
  On the busiest stretch of the Paddington line at peak times, trains later
  in the day may simply never get live data — they stay correctly in
  scheduled-only state, this isn't an error case to handle, just a ceiling
  on live-data freshness for dense routes.
- Live↔schedule matching is by scheduled departure time string. Two
  services on the same route sharing an exact scheduled minute would
  collide (first match wins). Not currently an issue for any of the five
  configured routes; would need a sturdier match key (e.g. TOC + time) if
  a future route had this property.

## Adding a route

Direct route: add one object to `routes.json`, add any new station codes to
`stations.json`. Nothing else. The next Action run (or a manual
`workflow_dispatch` trigger) picks it up automatically.

Connection route: same, plus `"change": "CRS"` and `"minConnectionMins": N`.
Check the physical platform layout at the change station before picking
`N` — the Twyford value (3) was chosen based on real platform-adjacency
research for that specific station, not a generic default; don't copy it
to a different interchange without checking.

## Local development

There isn't a dev server in this repo on purpose — it's meant to be edited
directly (including via GitHub's web editor for small changes like
`routes.json`) and tested against the real GitHub Pages deployment, since
the service worker and live-overlay behaviour are both meaningfully
different in a real HTTPS context vs `file://` or `localhost`. If you add
local tooling, keep it optional and don't make the repo depend on a build
step — the whole point is that `index.html` works by being fetched as-is.
