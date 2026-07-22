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
| `add-route.html` / `add-route.js` | In-app route builder / manager (see "In-app route builder" below). Standalone page linked from the settings sheet; commits `routes.json`/`stations.json`/`parked-routes.json` via the GitHub API with the user's own token. |
| `sw.js` | Service worker — stale-while-revalidate caching. |
| `routes.json` | Route config: `{id, name, from, to, change, minConnectionMins}`. Edit this to add/change routes — no other code changes needed for a direct route. |
| `parked-routes.json` | Routes removed via the builder, kept with full config for one-click re-add. Ships as `[]`. Not read by the main app. |
| `stations.json` | CRS code → display name for the configured routes. Add an entry whenever you add a station to `routes.json`. |
| `stations_all.json` | Full national CRS → name map (~2,600). Powers the builder's station autocomplete only; loaded lazily by `add-route.html`, kept out of the main app's precache. |
| `data/schedule.json` | Generated output. Don't hand-edit — it's overwritten by the Action every run. Ships with an empty-arrays placeholder (`is_seed_placeholder: true`) until the Action runs for real. |
| `scripts/fetch_schedule.py` | Runs in both Actions below. Queries RTT, writes `data/schedule.json`. |
| `.github/workflows/update-schedule.yml` | Full fetch: weekly cron (Mondays 04:00 UTC) + manual trigger. |
| `.github/workflows/refresh-platforms.yml` | Cheap platform-only fetch: daily cron (03:10 UTC) + manual trigger. Runs `fetch_schedule.py --platforms-only` — see below. |
| `scripts/test_fetch_schedule.py` | Python test suite (stdlib `unittest`) — see "Automated tests" below. |
| `test/*.test.js`, `test/loadApp.js`, `test/loadSw.js`, `test/loadAddRoute.js` | JS test suite (Node's built-in `node:test`) — see "Automated tests" below. `loadAddRoute.js` loads `add-route.js` with no DOM so its pure helpers can be tested. |
| `.github/workflows/test.yml` | Runs both test suites on every push/PR. |

## Three separate credentials — don't mix them up

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
- **GitHub token** (`localStorage.githubToken`): a fine-grained PAT the owner
  pastes into the route builder (`add-route.html`), scoped to this repo with
  `Contents: Read and write`. Used only from that page, browser → GitHub API
  (`api.github.com`, which is CORS-enabled). Local-only, never committed. It
  needs *no* `actions` scope: the commit itself triggers the fetch via the
  delta-aware push, so the builder never calls `workflow_dispatch`.

If you're ever tempted to put a Darwin key in a repo secret or env var —
don't. It has to be per-visitor because of CORS/ToS constraints already
worked through; see the "why" notes in `fetch_schedule.py`'s docstring for
the RTT side of this and the commit history for the CORS investigation. The
same rule applies to the GitHub token: browser/localStorage only, never a
repo secret. `RTT_TOKEN` stays server-only; the other two stay client-only.

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
arrival index, both keyed by `(uid, serviceDate)` with **lists** of
occurrences as values, not single dicts — an identity can legitimately call
at the same station more than once on the same serviceDate (e.g. an
out-and-back working), and collapsing to one occurrence per key let a
departure get silently paired with a leftover arrival from a different,
earlier calling of the same identity (see `_resolve_arrival()`'s docstring
and the "known-correct-on-purpose" note below — this is a real bug that
shipped, not a hypothetical). `fetch_legs(origin, destination, tday)` then
does an **inner join** on `(uid, serviceDate)` between origin's departures
and destination's arrivals, resolving each departure against its candidate
arrivals via `_resolve_arrival()`: a key must appear in both to become a
leg, since an unfiltered departure list contains services going everywhere,
not just towards that destination. For the 5 routes configured today this
means 8 distinct stations fetched once each per day instead of 12
origin/destination pairs fetched separately (~2x fewer calls than
one-call-per-pair, ~3x fewer than the original two-calls-per-leg design) —
don't go back to per-route filtered queries as a "simplification," it
multiplies calls for any station shared by more than one route.

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

**A schedule update used to be invisible on the load that triggered the
background refetch, only showing up on the load after that** — annoying
enough in practice (a real visitor reported it as "missing trains" that
took a manual double-refresh to fix) that it's now fixed properly: `sw.js`
compares the background fetch's response against what was cached, by
header only (`etag`/`last-modified`/`content-length` — **never the body**,
since `data/schedule.json` alone is tens of MB and a body diff on every
background refresh would be real, needless cost). If they differ, it
`postMessage`s every open client; `app.js`'s `DATA_RELOAD_HANDLERS` listener
reloads just the changed JSON file and re-renders, in place, no reload
needed. Don't "fix" the remaining network wait by adding a cache-busting
query string or similar — that reintroduces the slow-load problem this
strategy exists to avoid; comparing headers on the background fetch already
gets the same freshness without it. This same-page hot-reload is
intentionally scoped to the JSON data files only (`data/schedule.json`,
`routes.json`, `stations.json`) — `app.js`/`styles.css`/`index.html` changes
are still only picked up on next navigation via the `CACHE` version bump,
since swapping running JS/CSS under a live page is a materially riskier
problem than swapping a JSON blob a render loop already re-reads.

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
`applyDirectOverlay()`. Connection routes (currently only `rdg-hoh`,
Reading↔Henley via Twyford) use `connectionCard()` /
`applyConnectionOverlay()`, and `fetch_schedule.py` pre-pairs legs at fetch
time using `minConnectionMins` from the route config — the client never
does connection-pairing itself, only live-delay projection onto an
already-paired leg.

**Live data at the change station itself** (not just the origin/destination
legs either side of it) comes from leg-1's own departure-board match in
`applyConnectionOverlay()`, via `findCallingPoint()`: every `GetDepBoardWithDetails`
service carries `subsequentCallingPoints[].callingPoint[]`, one entry per
stop the service makes after the queried station, each with its own
`st`/`et` (confirmed live — see below). Matching the entry whose `crs`
equals `route.change` gives a real live arrival estimate for leg-1 at the
change station, which `applyConnectionOverlay()` prefers over the older
fallback of projecting leg-1's origin delay forward onto its scheduled
change-station arrival — that projection is now only used when the calling
point isn't found (e.g. the leg-1 departure-board fetch itself failed or
didn't match). Calling points carry no `platform` field (confirmed live),
so there's no live arrival *platform* at the change station, only a time —
don't try to add one without a different data source.

A `GetArrBoardWithDetails` query directly *at* the change station was tried
first as a more obvious-looking source for this and **returned HTTP 500**
against the real API — don't reintroduce it. `subsequentCallingPoints` on
the departure board already fetched for leg-1 is the only route to this
data — and it's a bonus over adding a call, not an extra one.

**The same `findCallingPoint()` technique also drives the final destination's
live arrival time** (`leg._liveArr`), for both direct legs (`applyDirectOverlay`,
matched against `route.to`/`route.from`) and a connection leg's leg-2
(`applyConnectionOverlay`, matched against the same `destCrs`). Both
`overlayDirectLive`/`overlayConnectionLive`'s boards are already fetched with
`filterType: 'to'` targeting the destination, so the matched service is
guaranteed to call there — again no extra API call. This closed a real gap:
`directCard`/`connectionCard` already read `leg._liveArr || leg.arr` for the
destination time, but nothing ever set `_liveArr` before this, so every
"arrival" shown was scheduled-only regardless of live delays. Confirmed live
against a genuinely delayed RDG→PAD service (86 minutes late, on-time
departure) — the delay only showed up via the destination calling point, not
the origin board, which is exactly the case this was missing.

**`overtakers()` applies to both direct and connection legs.** A paired
connection leg's top-level `depM`/`arrM` is already the whole-journey
origin-departure/final-arrival pair (`fetch_connection()` in
`fetch_schedule.py` picks one leg-2 per leg-1 at fetch time), so comparing
`depM`/`arrM` across connection legs compares full journeys exactly like it
does for direct legs — it doesn't need to know how many legs got them
there, or care that two connection legs might share the same leg-2. Don't
reintroduce a `!isConnection` gate around it.

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
- **`fetch_station_day()` indexes departures/arrivals as lists keyed by
  `(uid, serviceDate)`, not single dicts.** This was a real bug: an identity
  that calls at a station more than once on the same serviceDate (an
  out-and-back working) would have all but its last occurrence silently
  overwritten, so `fetch_legs` could pair a fresh departure with a stale
  arrival left over from an earlier, unrelated calling of the same identity
  — producing a "leg" whose arrival lands before its departure. Downstream,
  `dt_to_m`'s boundary nudge (arr before dep ⇒ assume day-boundary
  crossing) turned that into an apparent ~24h journey, which client-side
  `overtakers()` then read as beaten by every real train after it — hiding
  a whole afternoon of trains from the app (confirmed: this shipped in the
  `rdg-hoh` return data for 2026-07-02 and produced a real ~10h gap with no
  trains shown between ~07:35 and ~17:01). `_resolve_arrival()` fixes this
  by picking, per departure, the earliest candidate arrival that actually
  follows it — don't collapse `fetch_station_day`'s index back to
  last-write-wins single dicts.

## Unverified assumptions — check these against real data, don't assume

The sandbox used to build this can't reach `rtt.io` or `raildata.org.uk`,
so the following are from docs and inference, not tested against live responses.
There is currently nothing outstanding in this category — see below for items
that were checked, including two that turned out to be wrong.

The following were originally unverified assumptions and have since been
confirmed against the live API:

- **`GetArrBoardWithDetails` at the change station doesn't work — HTTP 500**
  every time it was tried live (`GET .../GetArrBoardWithDetails/TWY?filterCrs=RDG&filterType=from`),
  regardless of which station/direction. Whatever the cause (product
  entitlement, param shape, or the operation just not being wired up on this
  account), don't add it back as "the obvious way" to get live data at the
  change station. What actually works, confirmed live: every
  `GetDepBoardWithDetails` match already carries `subsequentCallingPoints[].
  callingPoint[]`, one entry per remaining stop, each with its own `st`
  (scheduled) / `et` (estimated — confirmed live using the same `"On time"`/
  HH:MM convention as `etd`) and `isCancelled`, but **no `platform` field**
  (confirmed absent on every calling point sampled — platform only ever
  appears on the queried station's own top-level board entry). `findCallingPoint()`
  in `app.js` searches leg-1's own matched service for the entry whose `crs`
  equals `route.change`, which is how `leg._liveChangeArr` gets populated —
  no extra API call, and no live arrival platform is possible this way.
- **`subsequentCallingPoints` is an array of call-point *lists*** (each with
  its own `callingPoint[]`), not one flat list — confirmed structurally live,
  consistent with it modeling per-portion calling patterns for services that
  divide. `findCallingPoint()` searches every list, not just the first.

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
- **Darwin REST field names `platformIsConfirmed` / `platformIsChanged`
  don't exist** — this was flagged here as an unverified guess (inferred
  from SOAP equivalents that don't actually exist either) and turned out to
  be wrong: the published Darwin User Guide schema for a service item only
  has `platform` and `platformIsHidden`. Because `svc.platformIsConfirmed`
  and `svc.platformIsChanged` were always `undefined`, every live-matched
  platform rendered as `(planned)` forever, never `confirmed`/`changed`,
  even for services minutes away. Fixed via `derivePlatformState()` in
  `app.js`: a live-fetched platform *is* the confirmation (Darwin only
  reports one once it's known); "changed" is derived by comparing it
  against the RTT-scheduled booked platform (`leg.platform`/`platform1`/
  `platform2`) instead of a nonexistent boolean. Don't reintroduce
  `platformIsConfirmed`/`platformIsChanged` reads from the Darwin response.
  `platformIsHidden` *is* real (per the same User Guide): true means Darwin
  has a live platform but flags it advisory-only, not for public display as
  confirmed. `derivePlatformState()` passes it through as `hidden`, and
  `platformHtml()` still shows the platform number but labels it
  `(unconfirmed)` with its own `.platform.hidden` style — distinct from the
  grey `.planned` state (no live data at all yet), since it's a different
  situation (Darwin has data but says don't trust it yet).
- **Darwin REST field name `operatorCode` on a departure-board service
  item** — used in `matchByTime()` (`app.js`) to disambiguate two services
  sharing a scheduled departure minute (e.g. GWR vs. Elizabeth line at
  Paddington-Reading), compared against RTT's `toc`/`toc1`/`toc2` in
  schedule.json. Confirmed live: a real `GetDepBoardWithDetails` call for
  PAD→RDG returned `operatorCode: "GW"` for Great Western Railway services
  and `operatorCode: "XR"` for Elizabeth line services, matching RTT's `toc`
  values for the same operators exactly.
- **RTT `locationMetadata.platform.planned` is only populated for the
  calendar day a query is made, not for days further ahead** — confirmed
  live: a same-day `/gb-nr/location` query for PAD returned a planned
  platform on 1167/1167 services, while an identical query 7 days ahead
  returned one on 0/1215. Not a bug in `fetch_schedule.py`'s parsing; RTT
  itself doesn't have real WTT-booked platform allocations for these
  stations that far out.
- **`locationMetadata.platform.forecast` is real and populated for advance
  dates, despite the API spec documenting it as "not currently used".**
  Confirmed live: the same 7-day-ahead PAD query that returned zero
  `planned` values returned `forecast` on 439/439 services, and the two
  fields are mutually exclusive — whichever one is set, the other is null
  for that service at that point in time. `parse_dep()` in
  `fetch_schedule.py` now falls back to `forecast` when `planned` is
  null, which is the only way to get any platform at all for most of the
  90-day lookahead given the Action only runs weekly. This is very likely
  a predicted/statistical platform (based on how that schedule pattern
  usually runs) rather than a confirmed WTT booking, so treat it as
  informational, not authoritative — Darwin's live overlay on the day is
  still the source of truth and will override it via the normal
  confirmed/changed logic in `derivePlatformState()` if the real platform
  differs.

## Known limitations, not bugs

- Darwin's departure board returns roughly the next 20 services from "now."
  On the busiest stretch of the Paddington line at peak times, trains later
  in the day may simply never get live data — they stay correctly in
  scheduled-only state, this isn't an error case to handle, just a ceiling
  on live-data freshness for dense routes.
- Live↔schedule matching is by scheduled departure time string, disambiguated
  by TOC (`operatorCode` from the Darwin board vs. `toc`/`toc1`/`toc2` from
  RTT in schedule.json) when more than one service shares an exact scheduled
  minute — see `matchByTime()` in `app.js`. This was a real bug on
  `rdg-pad`: Paddington-Reading has both GWR and Elizabeth line services, and
  two of them booked at the same minute (e.g. 18:48 ex-Paddington) used to
  collide, with the live overlay for whichever the board listed second
  landing on the wrong leg. If neither candidate's `operatorCode` matches
  (missing field, or an unmapped TOC), it still falls back to first-match,
  same as before — so this doesn't add a new failure mode, only fixes the
  known one for the routes where TOC is populated.
- **The `platform` field in `schedule.json` is a mix of two different RTT
  fields depending on how far out the leg is** — `planned` (a real
  WTT-booked platform) for legs on the calendar day the Action happened to
  run on, and `forecast` (RTT's own predicted platform, despite its API
  spec entry saying "not currently used") for every other day out to the
  90-day lookahead. See `parse_dep()` in `fetch_schedule.py` and the RTT
  entries above. `platformConfirmed` is only ever true for the `planned`
  case (`actual` populated), so the client can't currently tell these two
  sources apart from `schedule.json` alone — a `forecast`-sourced platform
  should be read as "expected, not guaranteed" even though it renders the
  same as a booked one. Darwin's live overlay on the day still overrides it
  as normal if the real platform differs. `refresh-platforms.yml` (see
  below) upgrades most of *today's* legs from `forecast` to real `planned`
  each morning, but every other day in the lookahead still only has the
  `forecast` guess until its own day arrives.

## Daily platform-only refresh (`refresh-platforms.yml`)

RTT only has a real, WTT-booked `planned` platform for the calendar day a
query is made — confirmed live (see above): 100% populated same-day, 0%
populated a week ahead. Since the full fetch (`update-schedule.yml`) only
runs weekly, that means only the single day it happened to run on would
ever get a real booked platform, and everything else would sit on the
`forecast` guess for its entire 90-day approach.

`fetch_schedule.py --platforms-only` (invoked daily at 03:10 UTC by
`refresh-platforms.yml`) fixes this cheaply: it fetches *only* today's
window (one calendar day) for the 8 unique stations these routes touch —
about 8 RTT calls total, negligible against the 30/min, 750/hour, 9000/day
budget — then walks the existing `data/schedule.json` and updates just the
`platform`/`platformConfirmed` fields (`platform1`/`platform2` for
connections) of legs matching today's date, matched by `(uid, serviceDate)`
via `merge_platforms_for_today()`.

This deliberately does **not** reuse the `--routes` flag's merge, which
replaces a route's entire `out`/`ret` array — doing that with only today's
~20-30 legs fetched would silently delete the other 89 days of forecast
data for that route. `merge_platforms_for_today()` updates matching legs
in place instead, leaving every other field and every other day's legs
untouched. Both workflows share the `rtt-schedule-fetch` concurrency group
so they can never race the same RTT budget or `data/schedule.json` commit
at once.

## Adding a route

Direct route: add one object to `routes.json`, add any new station codes to
`stations.json`. Nothing else. The next Action run (or a manual
`workflow_dispatch` trigger) picks it up automatically. The in-app builder
(below) is the friction-free way to do exactly this from a phone.

Connection route: same, plus `"change": "CRS"` and `"minConnectionMins": N`.
Check the physical platform layout at the change station before picking
`N` — the Twyford value (3) was chosen based on real platform-adjacency
research for that specific station, not a generic default; don't copy it
to a different interchange without checking. The builder can create these
too (with an in-page reminder about researching `N`, defaulting the field to
5 rather than assuming any particular station's adjacency), and can remove
and re-add existing ones losslessly regardless of how they were created.

## In-app route builder (`add-route.html` / `add-route.js`)

Lets the owner add an arbitrary route — direct, or a connection with a change
station and minimum connection time — remove / re-add any route, and reorder
the active list, from the app itself — no hand-editing. There is deliberately
**no new client data path**: research established there's no free, static,
browser-only way to get a *future* timetable for an arbitrary route, so the
builder just makes the existing server-side pre-fetch frictionless. It
commits the config with the owner's `githubToken` (above) and lets the Action
fetch the schedule; the route then appears in the main app fully first-class
with **zero `app.js` changes** (the app is already data-driven off
`routes.json` + `schedule.json`, and route *order* in that array is what
`renderRoutePicker()`/`ROUTES[0]` already key off).

Key pieces, all reused rather than rebuilt:

- **One commit via the Git Data API** (`ghCommitFiles` in `add-route.js`):
  ref → base tree → tree (inline file `content`, no separate blobs) → commit
  → update ref. Writing `routes.json` (+ `stations.json` / `parked-routes.json`)
  in a single commit means the push trigger fires once.
- **Remove / re-add** move the full route object between `routes.json` and
  `parked-routes.json` (`removeRoute`/`readdRoute`). Type-agnostic — a parked
  connection route (Henley) re-adds with its exact `change`/`minConnectionMins`,
  no research. Removed data is auto-pruned by the next weekly cron full run
  (which rebuilds `schedule.json` from `routes.json` only); until then a
  re-add is instant because the data is still there.
- **Creating a connection route** in the add form (`buildRoute()`) sets
  `change`/`minConnectionMins` (default 5) alongside `from`/`to`, and includes
  the change station's display name in the `stations.json` merge. The page
  shows the same platform-adjacency research warning as this file's "Adding a
  route" section, but doesn't block on it — the owner is trusted to have
  actually checked, same as a hand-edit would be.
- **Reordering** (`moveRoute`/`commitMoveRoute`) swaps a route with its
  neighbour and commits **only** `routes.json` — always re-read fresh from
  GitHub immediately before the swap (not a stale copy from page load), so two
  reorders in quick succession can't race each other's base state. Adds no
  missing route ids, so the delta-aware push below no-ops, same as a removal —
  purely a metadata commit, no RTT calls.
- **Delta-aware push** in `update-schedule.yml`: a `push` that touches
  `routes.json` runs `fetch_schedule.py --print-missing-routes` (ids in
  `routes.json` but not yet in `schedule.json`) and fetches only those, in two
  phases so a new route is usable in ~2–3 min: `--routes NEW --days 7` (fast),
  commit, then `--routes NEW --start-day 7 --append` (backfill days 7–89),
  commit. Cron (full) and `workflow_dispatch` (scoped, full-replace) paths are
  unchanged. Removing a route adds no missing ids, so its push no-ops.
- **`--days N` / `--start-day S`** bound the fetch to `[S, S+N)`; when `--days`
  is omitted the window runs from `S` to the end of the 90-day lookahead (so
  `--start-day 7` = days 7–89, not a fresh 90). **`--append`** unions the
  fetched day range into a route's existing arrays (`merge_route_append`)
  instead of replacing them, so the backfill keeps the fast phase's first week
  and re-queries no day twice. Don't collapse these back to a single
  full-replace fetch — that's the ~7-min-vs-~2-min add UX and the call
  minimisation the two phases exist for.
- **Call minimisation**: `--print-missing-routes` returns *all* missing ids to
  one `--routes` run, and `fetch_station_day` caches per `(station, day)`, so
  routes added together that share a station fetch it once. The floor: raw
  station boards aren't persisted between runs, so a genuinely new route must
  still fetch its own stations once.
- **`stations_all.json`** (national CRS→name) powers the builder's autocomplete
  only; it's loaded lazily by that page and kept out of the main precache.

## Local development

There isn't a dev server in this repo on purpose — it's meant to be edited
directly (including via GitHub's web editor for small changes like
`routes.json`) and tested against the real GitHub Pages deployment, since
the service worker and live-overlay behaviour are both meaningfully
different in a real HTTPS context vs `file://` or `localhost`. If you add
local tooling, keep it optional and don't make the repo depend on a build
step — the whole point is that `index.html` works by being fetched as-is.

### Automated tests

There's a real, CI-enforced test suite (`.github/workflows/test.yml`, runs
on every push/PR) covering the pure logic in both `scripts/fetch_schedule.py`
and `app.js`/`sw.js` — the parts of this codebase that have actually shipped
real, silent bugs before (3am day-boundary math, RTT identity-recycling
joins, connection pairing, overtaking, live-overlay delay/cancellation
projection, the SW's stale-while-revalidate change detection). It's
optional local tooling per the rule above — no dependency is required to
run the app itself, only to run the tests.

- **Python** (`scripts/test_fetch_schedule.py`, stdlib `unittest` + `mock`,
  zero extra dependencies beyond `scripts/requirements.txt`): every RTT API
  call is mocked, so no network or real `RTT_TOKEN` is needed. Run with
  `python3 scripts/test_fetch_schedule.py` or
  `python3 -m unittest discover -s scripts -p 'test_*.py'`.
- **JS** (`test/*.test.js`, Node's built-in `node:test` — no npm
  dependencies at all, deliberately, to keep with the no-build-step rule
  above): `app.js` and `sw.js` are classic (non-module) scripts, so
  `test/loadApp.js`/`test/loadSw.js` load them into a fresh Node `vm`
  context against a minimal hand-rolled `document`/`window`/`self` stub
  (not jsdom — see those files' header comments for why this works and
  what it deliberately doesn't cover) and read back their top-level
  `function`-declared identifiers to test directly. `loadApp()` also
  accepts a fixed `now` to test the 3am day-boundary logic deterministically.
  Run with `node --test` (bare — a path argument like `node --test test/`
  does *not* do directory discovery the way you'd expect; the CI workflow
  and `npm test` both use the bare form) or `npm test`.
- `loadApp()`'s `document.getElementById()` stub returns the *same* element
  instance for a given id every call (a real DOM does too), with a real
  Set-backed `classList` and a capturing `addEventListener` — not a no-op
  stub — so tests can observe state a function mutated (e.g.
  `setLiveStatus()` toggling a class) or trigger a listener app.js's
  top-level code registered (e.g. a click handler) via the test-only
  `el._trigger(type, event)` hook. The registry itself is exposed as
  `ctx.__elements` (a `Map`) for tests to reach in with
  `ctx.__elements.get('some-id')`.
- Cross-realm gotcha if you add more object-returning function tests: a
  plain object/array a vm-loaded function *constructs and returns* has that
  vm context's `Object.prototype`, not the test file's — `assert.deepEqual`
  under `node:assert/strict` checks prototype identity and will fail on
  structurally-identical data for this reason alone. Round-trip through the
  `plain()` helper in the test files before comparing (see its comment).
  Objects the test file constructs and merely *passes into* a vm function
  (e.g. `overtakers()`'s pool of legs) don't have this problem — they keep
  the test file's own realm.

What's deliberately **not** covered here, because it needs a real browser/
real HTTPS and can't be meaningfully mocked: the service worker's actual
fetch-interception/caching behavior end-to-end, and the Darwin live-overlay
fetch — see the manual recipe below for the latter.

### Testing the live overlay end-to-end from a Claude Code sandbox

If a visitor shares a real Darwin API key in-session to ask for live
verification, it's possible to actually exercise `fetchBoard()` against
`api1.raildata.org.uk` from a real browser — not just `curl` — without
adding anything to the repo. Recipe (confirmed working):

1. Serve the repo root as-is: `python3 -m http.server 8123`. Plain HTTP
   `localhost` was sufficient to exercise `fetch()`-based CORS against the
   real Darwin API end-to-end (fetch from an `http://` page to an `https://`
   API is not mixed-content-blocked — only the reverse direction is). This
   was *not* used to verify service-worker-specific behaviour, so the
   file-map's caution about `file://`/`localhost` differing from real HTTPS
   still stands for anything SW-related.
2. Drive it with Playwright against the pre-installed Chromium
   (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; install the
   `playwright` npm package into a scratch dir, not the repo — the browser
   binary is already there, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is already
   set). Launch with these exact flags, or every external request either
   hangs or gets `net::ERR_CONNECTION_CLOSED`:
   - `--headless=new` — this build has removed old headless mode entirely.
   - `--proxy-server=$HTTPS_PROXY --proxy-bypass-list=localhost;127.0.0.1;<local>`
     as raw launch args, **not** Playwright's high-level `proxy: {...}`
     option — that option's `bypass` field routed the local `http://`
     server through the CONNECT-only proxy anyway and got `405`s back.
   - `--ssl-version-max=tls1.2` — without this, **every** external HTTPS
     request from this specific Chromium build gets silently reset
     (`net::ERR_CONNECTION_CLOSED`, ~5s after the ClientHello, confirmed via
     `--log-net-log`: `SSL_HANDSHAKE_ERROR` / `net_error: -100`, zero bytes
     back) by this sandbox's TLS-inspecting egress proxy — even to plain
     `https://example.com`, and even though `curl` through the exact same
     `$HTTPS_PROXY` works fine for the same URL. Forcing TLS 1.2 avoids
     whatever about this Chromium build's TLS 1.3 ClientHello the proxy
     doesn't like. `curl` isn't a substitute test for this: it never
     exercises the browser's CORS preflight/fetch path at all.
3. Never write the API key into any file that gets committed — pass it via
   an env var into a throwaway script under the scratch dir.
