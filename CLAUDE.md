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
| `app.js` | All client logic: rendering, overtaking, live overlay, settings, quick (session-only) live routes (see below). |
| `add-route.html` / `add-route.js` | In-app route builder / manager (see "In-app route builder" below). Standalone page linked from the settings sheet; commits `routes.json`/`stations.json`/`parked-routes.json` via the GitHub API with the user's own token. |
| `sw.js` | Service worker — stale-while-revalidate caching. |
| `routes.json` | Route config: `{id, name, from, to, change, minConnectionMins}`. Edit this to add/change routes — no other code changes needed for a direct route. |
| `parked-routes.json` | Routes removed via the builder, kept with full config for one-click re-add. Ships as `[]`. Not read by the main app. |
| `stations.json` | CRS code → display name for the configured routes. Add an entry whenever you add a station to `routes.json`. |
| `stations_all.json` | Full national CRS → name map (~2,600). Powers station autocomplete for both the builder (`add-route.html`) and the main app's quick-route sheet; loaded lazily by each, kept out of the main app's precache. |
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

## "Now" is always UK time, never the visitor's device time

Every time this app deals with — `depM`/`arrM` in schedule.json, Darwin's
live `etd`/`st`/`et` strings — is a UK local wall-clock time (BST in summer,
GMT in winter), because that's what National Rail publishes. This shipped as
a real bug: `todayStr()`/`nowM()`/`secsUntil()` used to read `new Date().
getHours()`/`getMinutes()` directly, which is the *visitor's device*
timezone — only equal to UK time by coincidence. A visitor whose phone is
set to a different zone (travelling abroad, or just configured that way)
got every now/next/countdown/live-delay comparison skewed by the gap
between their device's offset and the UK's. Confirmed live in this sandbox,
whose container clock is UTC: with the old code, at 09:47 UTC (10:47 real
UK/BST time) the app showed "Now 09:47" and matched live boards an hour
behind where they should have been.

Fixed via `londonNow()`/`londonHm()` in `app.js`: `Intl.DateTimeFormat`
with an explicit `timeZone: 'Europe/London'` resolves the current instant's
real UK wall-clock fields (year/month/day/hour/minute/second), correctly
applying BST or GMT for whichever moment "now" actually is — and, because
the zone is passed explicitly, this is **completely unaffected by the
visitor's own device/OS timezone setting** (confirmed by temporarily
forcing the test process's own `TZ` env var to `Pacific/Auckland` and
checking the result was unchanged — see the "resolved from the real
instant" test group in `test/app.test.js`). `todayStr()`, `nowM()`, and
`secsUntil()` all now go through `londonNow()` instead of raw `new Date()`
getters; the "Now HH:MM" divider label goes through the new `londonHm()`
for the same reason instead of `toLocaleTimeString()`'s (also device-tz)
default. **Never hardcode a fixed offset (e.g. "always add 1 hour") as a
shortcut here** — that's right for exactly half the year and silently
wrong the moment the UK's clocks change; `Intl`'s IANA tz data is what
actually knows the real transition dates each year. Confirmed against the
real 2026 transition instants (`2026-03-29T01:00:00Z` GMT→BST,
`2026-10-25T01:00:00Z` BST→GMT) in the "UK clock changes" test group.

**What deliberately didn't need fixing**, and why:
- `addDays()` and the `dayLabel` weekday/day/month formatting
  (`renderDirection()`) — both are pure calendar-date arithmetic/formatting
  with no "now" involved, so they're timezone-*self-consistent* already
  (construction and read-back always agree) regardless of which zone that
  happens to be. `dayLabel` is anchored to UTC (not Europe/London) purely
  so there's never any doubt about which zone that is — a calendar date's
  day-of-week doesn't actually depend on timezone once you don't attach a
  real moment-in-time meaning to it.
- The `new Date().getSeconds()` reads for sub-minute countdown precision
  (`directCard`/`connectionCard`/`scheduleNextMinute()`) — Europe/London's
  offset from UTC is always a whole number of hours (0 or +1), so it never
  shifts the minute/second components, only the hour (and, near midnight,
  the date). These don't need `londonNow()`.
- `liveMinute()` — pure string-to-minutes parsing of an already-UK-local
  `HH:MM`, no `Date` object involved at all.
- Live data itself: `overlayDirectLive`/`overlayConnectionLive` only ever
  fetch live boards for `dateStr === todayStr()` (see `refreshLiveOverlay()`
  — live is "today only" by design), so a future date on the other side of
  a DST transition never reaches the live-overlay path; the only thing that
  needs the DST-transition-safe `londonNow()` is figuring out what "today"
  and "now" actually are at the moment the code runs, which it now does
  correctly on both sides of any transition.

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

## Train list is ordered by arrival, not departure — and reorders live

`renderDirection()` sorts each direction's legs with `byArrival()`
(`effArrM(a) - effArrM(b)`, tiebroken by scheduled `depM`), not by
departure. `effArrM()` mirrors `effDepM()`: it prefers the live-adjusted
arrival (`leg._liveArr`, set by `applyDirectOverlay`/`applyConnectionOverlay`/
`synthesizeLiveLegs`) over the scheduled `arrM`. Since `refreshLiveOverlay()`
already calls `renderDirection()` after every successful poll (including the
once-a-minute one from `tickMinute()`), this is enough on its own to make
the list reorder itself as a delay comes in — no separate "watch for
reorder" logic needed, it falls out of re-sorting on every render.

This was a deliberate response to a real live-overlay mismatch (see the
`matchByTime()` disambiguation entries above): two same-minute departures
with different journey times need to be tellable apart by more than "which
one currently sorts first", and ordering by arrival is also just the more
useful reading for "which train gets me there soonest" — overtaking already
tells you this per-card via the dimmed/"Faster:" treatment, this makes the
list itself reflect it.

Switching the sort key off departure order broke two things that quietly
depended on it, both fixed in `renderLegList()`:

- **"Next" train selection.** With a departure-ordered list, the first leg
  in list order with `effDepM(leg) >= curM` was necessarily the
  soonest-departing one. With an arrival-ordered list that's no longer true
  (a leg that arrives later can still depart sooner), so `renderLegList()`
  now filters to eligible legs first, then picks the *minimum* `effDepM`
  among them via `reduce()`, rather than the first list match.
- **The "Now" divider's position.** A single forward scan that inserts the
  divider at the first leg with `effDepM(leg) >= curM` assumed past and
  future legs were contiguous runs — true under departure order, not
  guaranteed under arrival order (a departed leg can sort after a
  not-yet-departed one). `renderLegList()` now splits `visible` into a past
  group and a future group by `effDepM` vs `curM` first (each keeping its
  existing arrival-sorted relative order), renders past, the divider, then
  future — so the divider still lands at exactly one clean boundary and a
  struck-through past leg can never appear below it.

`overtakers()` itself is untouched and still compares scheduled `depM`/`arrM`
only (see its own comment) — it answers "is this leg beaten on the
timetable", a different question from "what order does live running put
these legs in on screen right now".

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

- **Station pickers (`add-route.html`'s From/To/Change-at, the quick-route
  sheet's From/To) use a custom JS-rendered suggestions list
  (`attachStationPicker()` in both `add-route.js` and `app.js`), not a native
  `<input list="...">` + `<datalist>`.** This shipped as a datalist originally
  and looked fine in testing (works in desktop Chromium/Firefox) but was a
  real, live bug, and on more than one mobile browser, not just one: **iOS
  Safari silently ignores the `list` attribute and renders zero suggestions,
  ever**, and **Firefox for Android does the same — confirmed via Mozilla's
  own tracker (`bugzilla.mozilla.org` #1840724, "Neither `<datalist>` nor its
  `<option>`s are exposed in Firefox for Android") and multiple independent
  user reports, not a one-off** — both treat the input as a plain text field,
  no error, no fallback, no announcement that suggestions exist. Don't read
  this as "an iOS thing" — it's a wider pattern: **mobile browsers have
  historically underinvested in `<datalist>`'s native autocomplete UI full
  stop**, across at least two unrelated engines (WebKit and Gecko), so treat
  *any* mobile browser as suspect for this element rather than assuming
  Chromium-based mobile browsers are safe merely because desktop Chromium is.
  Since this app is explicitly designed to be used from a visitor's phone
  (the Darwin key, the whole point of the settings ⚙ flow), that's not an
  edge case. It also compounded with validation: typing a station name
  without picking a datalist option failed with "pick a valid station" (only
  the "Name (CRS)" form a datalist selection produces was accepted), so
  affected visitors got no suggestions *and* a hard failure on typed input.
  `resolveCrs()`/`resolveQuickCrs()` now also accept an exact, case-insensitive
  name match as a fallback for the same reason. Don't reintroduce a
  `<datalist>` for a station picker as a "simplification" — it silently
  regresses to zero-suggestions on multiple real mobile browsers. The
  suggestions box is deliberately in normal document flow, not
  `position:absolute` — these are short bottom sheets with little vertical
  gap before the next control (e.g. Add/Cancel right after the To field), and
  an overlaid box tall enough to reach that row visually covers it, silently
  swallowing a tap meant for the button underneath.
- **`directCard()` checks `isCancelled` *before* the delay tags, not after.**
  Darwin reports a cancelled service with no estimated departure time, so
  `_delayMins` lands at 0 with `_liveChecked` true — structurally identical
  to a punctual train — and the "on time" branch used to put a green
  **"On time" badge on a cancelled train**. It also never said the word
  "Cancelled" anywhere: the strike-through and red border were the only
  cue. (`connectionCard()` always had its own explicit cancelled tag and
  never had the problem.) This was only reachable once live data actually
  reached these cards, which is why it sat unnoticed behind the 500ing
  board above. Don't reorder these branches.
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

## Darwin's board-size ceiling — why `fetchBoard()` retries smaller

`GetDepBoardWithDetails` refuses, with **HTTP 500
`{"Message":"The service is currently unavailable"}`**, to assemble a board
past a certain number of detailed services. It does not truncate and it does
not tell you the limit — it fails the whole request, so one over-large ask
takes out an entire direction's live data.

Measured live at Paddington on 2026-08-12, a day of **weather disruption**
(all reproduced twice):

| request | 18:46 (disrupted) | 19:37 (calm) |
|---|---|---|
| `PAD?numRows=23` (unfiltered) | 200 | 200 |
| `PAD?numRows=24` (unfiltered) | 500 | 200 |
| `PAD?numRows=30` (unfiltered) | 500 | 200 |
| `PAD?filterCrs=RDG&numRows=9` | 200 | 200 |
| `PAD?filterCrs=RDG&numRows=10` | 500 | 200 |
| `PAD?filterCrs=RDG&numRows=20` | 500 | 200 |
| `PAD?filterCrs=MAI&numRows=20` | 500 | — |
| `RDG?filterCrs=PAD&numRows=20` | 200 | 200 |
| `KGX?filterCrs=CBG&numRows=50` | 200 | — |

**What drives it is live-forecast volume, not departure density and not
response size.** This was initially written up here as a density/peak effect
and that was wrong — the two boards either side of the fix say so directly:

| | services | span | rate | size | delayed | cancelled | calling points with revised times | ceiling |
|---|---|---|---|---|---|---|---|---|
| 18:46 | 23 | 48 min | 29/hr | 111KB | 7 | 4 | 40 | fails at 24 |
| 19:37 | 23 | 43 min | 32/hr | 108KB | 3 | 0 | 10 | fine at 30 |

The calm board is **denser** and the same size, and copes with far more rows.
Every delayed or cancelled service makes Darwin re-estimate each of that
service's downstream calling points and attach `cancelReason` /
`currentOrigins` — work *per service*, not bytes, which is consistent with a
server-side timeout rather than a payload limit. Two corollaries:

1. **`filterCrs` doesn't dodge it.** The filter is applied *after* the board
   is built, so a filtered request scans just as far and hits the same wall
   from the other side. Hence a sparse destination off a busy station
   (`PAD→MAI`) failing where a dense one (`PAD→RDG`) survives.
2. **The safe numRows collapses exactly when the network is disrupted** —
   i.e. exactly when live data matters most, and exactly why this read as
   "live data is just flaky at Paddington" rather than a breakage. Within one
   evening the ceiling moved from 9 to 4 to unlimited-as-far-as-tested.

### `BOARD_LADDER` — two kinds of request, not just smaller ones

`filterCrs` is the *expensive* half of this, not the cheap one, so the ladder
in `app.js` alternates between two shapes of request rather than only
shrinking `numRows`:

| | cost | what you get |
|---|---|---|
| **server-filtered** (`filterCrs=RDG&numRows=20`) | deep scan — first to fall over | 20 trains that actually go there, spanning 1h45m at PAD |
| **unfiltered** (`numRows=25`) | bounded — exactly N departures, no search | ~N × the destination's share of departures, narrowed client-side |

At 18:46, unfiltered `numRows=20` returned **200 at the same moment** filtered
`numRows=10` was returning **500**. So the unfiltered board is a genuinely
stronger rung than a shrunken filtered one on a dense route — and we can do
the filtering ourselves with `findCallingPoint()`, which every call site
already has in hand and needs anyway for arrival times. No extra request.

Measured destination yields (share of a station's departures that call there):
PAD→RDG 36%, KGX→CBG 35%, RDG→PAD 29%, PAD→MAI 16%, RDG→OXF 12%, RDG→MAI 8%.
So neither shape dominates: on a dense route an unfiltered 25 still yields ~9
usable trains (much better than a filtered board shrunk to 3), while on a
sparse one it yields almost nothing and a small filtered board — which
searches much further ahead — is the better answer. Hence both, interleaved,
largest value first: filtered 20, unfiltered 25, filtered 8, unfiltered 12,
filtered 5, 3, 2. Don't collapse this to a single shape or a single constant:
one under-serves every calm board, the other breaks in a storm.

**Client-side filtering was verified against Darwin's own filter** across
seven station pairs: identical on six. On the seventh it returned a
**superset** — Darwin's filtered MAI board silently omitted a
**fully-cancelled** Maidenhead→Reading service that the unfiltered board
reported with `etd: "Cancelled"` and all seven calling points cancelled
(stable over three consecutive runs, so not a race). Partially-cancelled
services *do* survive the filter (two at PAD, one with its Reading call
itself cancelled), so the rule looks like "no usable call left at the
destination" — mechanism inferred from three samples, not documented, so
don't rely on the exact boundary. The consequence is what matters: **the
server-side filter can hide a wholly cancelled train**, which is the single
most important thing this app can tell someone, and the unfiltered path picks
it up. Treat that as a reason to prefer client-side narrowing, not drift to
be corrected.

Two rules keep the mixed ladder honest:

- **An empty *server-filtered* board is accepted as definitive** — Darwin
  searched its own window for that destination and found nothing, i.e. "no
  more trains today". Walking the rest of the ladder every minute all night
  would be pure waste.
- **An empty *unfiltered* board is not** — it only means "none in the next N
  departures", which on a sparse route is expected. Keep it as a fallback and
  carry on to a filtered rung that searches further ahead.

Two cost controls keep the ladder from becoming a rate-limit problem, since
the app re-polls every minute:

- **The rung that worked is remembered** per `(crs, filterCrs, filterType)`
  and is where the next poll starts, so steady state stays at one call per
  board. It's re-probed from the top after `BOARD_ROWS_REPROBE_MS` (10 min)
  so an evening-peak clamp lifts itself once the station quietens down.
- **A board that 500s on every rung parks at the smallest one**, so the next
  poll spends one call rather than replaying the whole ladder. A *non*-5xx failure
  (offline, CORS, 4xx, bad key) deletes the hint instead — it says nothing
  about board size, and must not leave a good board clamped for ten minutes
  because of one dropped request.
- **Only one live round per route+date runs at a time** (`liveRoundInFlight`).
  `tickMinute()`'s poll can otherwise land while a round is still walking its
  boards — a connection route fetches four, and the ladder can add rungs to
  each — which both doubles the calls and lets two rounds interleave their
  writes into `liveErrorDetails`, corrupting the one report meant to explain
  what went wrong. Confirmed live on `rdg-nmc`: eight requests for four
  boards, interleaved `A,A,B,B,C,C,D,D`. The key is route+date, not a bare
  flag, so switching route or day is never blocked by the previous route's
  in-flight round (also confirmed live).
- **A round's boards are fetched concurrently** (`fetchBoards()`), not one
  after the next. They're independent requests — nothing in one informs
  another — and serially a round cost the *sum* of every board's latency,
  with each board able to walk several ladder rungs before it lands. That
  sum is what the visitor waits through between "Updating live data…" and
  the delays appearing, and on a connection route (four boards) during
  disruption it could run to most of a minute. Concurrency is bounded by the
  route shape (2 boards direct/quick, 4 connection) and the poll only runs
  once a minute, so this is well inside Darwin's limits. Don't put the
  `await`s back in sequence as a "simplification" — the ladder means a slow
  board is *slower* than it looks, not faster.

This file previously said the unfiltered fallback had been "considered and
rejected on measurement", on the grounds that unfiltered `numRows=20` at PAD
returned 200 at 18:46 and 500 at 19:00 and so was subject to the same moving
ceiling. That reasoning was wrong and the conclusion with it: a fallback rung
doesn't have to be immune to the ceiling, only *better than the rung it
replaces* — and it can be laddered too. The unfiltered board is strictly
cheaper for the same row count, and it survived at 18:46 precisely when the
filtered one didn't.

Because the trigger is disruption, **the degraded states below will show up
precisely during disruption** — so the status bar must never let "no delays
shown" be read as "no delays". That's the other half of this fix.

### How confident is any of this, and what would falsify it

Three things are solidly established and worth not re-litigating:

- **The failures were deterministic, not random.** Two identical
  back-to-back requests were made at each of six sizes; every size gave the
  same result both times (6/6). So this is not the API being intermittently
  flaky under load, and — importantly — **an immediate same-size retry does
  not recover it**. That negative result is what justifies the ladder
  *shrinking* rather than just retrying at 20, which would cost no coverage.
  If the ⚠ reports ever show a same-size retry succeeding, revisit that.
- **Smaller genuinely helps, independent of elapsed time.** The in-browser
  ladder runs *descending* (20, 12, 8, 5, 3) and succeeded on its **last and
  smallest** attempt in three separate runs. A "the service was just having
  a bad minute" model predicts the opposite ordering.
- **It is not a global outage.** PAD returned 500 while RDG and KGX returned
  200 for equivalent requests, repeatedly, across ~40 minutes.

What is *not* established is that request size is the whole story. The
threshold itself moves with conditions, so the honest model is an
**interaction — request cost × whatever server headroom exists at that
moment** — and "demand/server strain during disruption" is the second half of
that, not a competing theory. It could not be separated further because by
the time the controlled experiment was designed the board had recovered and
the failure was no longer reproducible.

Two traps for whoever picks this up next:

- **Sweep sizes in interleaved or random order, never ascending.** Several of
  the original sweeps went `for n in 6 7 8 9 10 12`, which confounds "bigger
  request" with "later in time" — an ascending sweep cannot by itself
  distinguish a size ceiling from a service degrading mid-sweep. Only the
  descending in-browser runs actually break that confound.
- **`numRows` above ~25 is a no-op on an unfiltered board.** Darwin caps the
  assembled board at 25 services (confirmed: `numRows` of 26, 30, 50 and 150
  all return exactly the same 25-service, 105KB board, and `timeWindow=120`
  doesn't extend it). So an A/B of `numRows=150` vs `20` is really 25 vs 20
  and proves much less than it looks like. A *filtered* board is not capped
  the same way — `PAD?filterCrs=RDG&numRows=20` returns 20 matches spanning
  1h45m, which is why the filtered scan is the expensive one.

The one untried lever is `GetDepartureBoard` (the non-`WithDetails`
operation), which wouldn't assemble calling points at all and so shouldn't
hit this. It's a *different* Rail Data Marketplace product (separate
subscription, unverified on this key) and it returns no
`subsequentCallingPoints`, which `_liveArr`, the change-station arrival and
`matchByTime`'s arrival tie-break all depend on — so it isn't a drop-in, and
it would cost a second call per board to keep those. Worth revisiting only if
the ladder's floor stops being enough.

## "Live" in the status bar means live data reached a card

`refreshLiveOverlay()` used to call the round a success on
`!!(outBoard || retBoard)` — true if *any* board fetch returned anything.
Combined with the ceiling above this produced the bug that led here: the
Reading board succeeded, the Paddington board 500'd every single time, and
the app showed a green "Live platforms & delays" dot over a Return tab where
every card was on scheduled times — real delays, a real platform change and
a real cancellation all invisible. Worse, `lastLiveErrorReport` was only
built `if (!ok)`, so the ⚠ diagnostics button stayed hidden and the captured
500s were discarded: the one state most in need of an explanation was the
one state that couldn't produce one.

So the overlay functions now report an **outcome**, not a boolean —
`boardOutcome()` returns `{boardsOk, boardsFailed, matched}`, where `matched`
is the number of legs that actually received live data (`applyDirectOverlay`
/ `applyConnectionOverlay` each return their own count). Green requires
`boardsFailed === 0 && matched > 0`. Everything else gets its own honest
state:

- some boards up, some down → `stale`, "Live data incomplete — some trains
  not updating (tap ⚠)"
- all boards up, nothing matched, but trains still to come today
  (`hasUpcomingLegs()`) → `stale`, "Live data fetched but matched no trains"
- all boards up, nothing left to match today → green, because after the last
  train zero matches is the correct answer, not a fault. Flagging it nightly
  would train the warning out of being noticed.

`lastLiveErrorReport` is now built whenever `liveErrorDetails` is non-empty
regardless of outcome, and carries the board/match tally, so a screenshot of
that panel is self-diagnosing. Don't collapse these states back into one
boolean — "a fetch returned something" and "live data is on screen" are
genuinely different questions, and only the second is what the dot claims.

### A round only reports if it's still the round that matters

The same "the dot must not claim more than the cards show" rule has a timing
half, and getting it wrong is what produced a reported ~1-minute lag between
the indicator going green and the updates actually appearing.

`refreshLiveOverlay()` is `async`, so by the time its awaits resolve the view
can have moved on — the reader switched route or day, or (the common one)
`sw.js`'s stale-while-revalidate hot-reload swapped `SCHEDULE` out from under
it. It used to write its status and re-render **unconditionally** at that
point, and clear `liveRoundInFlight` in a `finally`. Both are wrong for a
round that has been superseded: it reports an outcome for legs that are no
longer on screen (green dot, scheduled-times cards), and it unlocks the guard
belonging to the *newer* round, so the next `tickMinute()` poll fires a
duplicate.

So a round now takes a `liveRoundSeq` ticket when it starts and checks it
before reporting: `if (mySeq !== liveRoundSeq) return;` — no status write, no
re-render, and `liveRoundInFlight` left alone because it belongs to whoever
superseded it. `invalidateLiveRound()` bumps the sequence and clears the key,
which is how a caller says "whatever is in flight is now writing into legs
that no longer exist". The round itself keeps running to completion; there's
no `AbortController` threaded through the ladder, and adding one would buy a
couple of cancelled requests a minute at the cost of plumbing it through
every rung.

**The in-place data hot-reload has to do three things in order** — see
`applyDataUpdate()`, split out of the service-worker message listener purely
so this sequence is testable (the listener isn't, it only exists when a real
SW does). Reloading `data/schedule.json` replaces **every leg object**, and
the fresh ones carry no `_live*` fields at all, so on its own the swap silently
throws away the whole live overlay:

1. reload the changed file;
2. `ROUTES.forEach(restoreLiveCacheForRoute)` — replay the last successful
   round's live fields onto the new leg objects, so the cards never visibly
   drop back to scheduled times (this is the same cache that already survives
   a page reload; it just also has to survive a swap);
3. `invalidateLiveRound()` **before** `render()` — otherwise `render()`'s own
   `refreshLiveOverlay()` call is skipped as a duplicate of the in-flight
   round, and nothing re-fetches until the next minute tick. That skip, plus
   the orphaned round going on to paint the dot green, *is* the minute-long
   green-but-stale window.

Note what makes this fire in normal use rather than rarely:
`checkForDataUpdates()` re-issues all three data fetches on every tab focus,
and `refresh-platforms.yml` commits a new `schedule.json` daily — so the first
focus after each daily commit takes exactly this path.

## Known limitations, not bugs

- Darwin's departure board returns roughly the next 20 services from "now."
  On the busiest stretch of the Paddington line at peak times, trains later
  in the day may simply never get live data — they stay correctly in
  scheduled-only state, this isn't an error case to handle, just a ceiling
  on live-data freshness for dense routes. At the very peak that ceiling is
  much lower than 20 and is imposed by the API refusing to build a board
  that big at all — see "Darwin's board-size ceiling" below.
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
- **TOC alone doesn't disambiguate two same-operator services at the same
  minute** — `rdg-pad` also has real parallel-platform GWR departures at the
  same minute (a fast and a stopper, e.g. both booked 10:13 ex-Reading), so
  `toc` ties between candidates too. This shipped as a real bug: the old
  `candidates.find(operatorCode === toc)` returned the *first* same-operator
  candidate regardless of which leg (fast or stopper) was being resolved, so
  both legs' cards showed identical live status (platform/delay/on-time)
  copied from whichever one the board happened to list first — confirmed
  from a live screenshot where the slower, dimmed/overtaken leg and the
  faster leg both showed "Plat 15A" / "On time" even though the faster train
  was actually running late with no platform change shown. `matchByTime()`
  now takes a `destCrs`/`arrM` pair (the change-station or final destination
  CRS and that leg's scheduled arrival there, in minutes — `leg.arrM`/
  `leg.changeArrM`, the same day-boundary-relative representation used
  everywhere else) as a second disambiguation tier: when the toc tier still
  leaves more than one candidate, it breaks the tie by comparing each
  candidate's own `subsequentCallingPoints` scheduled arrival (`st`) at that
  stop against `arrM`, within `MATCH_ARR_TOLERANCE_MINS` (2) rather than
  requiring an exact match — RTT and Darwin are independently-sourced
  schedules and have been observed live to disagree on the same service's
  scheduled arrival by a minute or two (WTT-derived vs public-timetable
  rounding), and an exact match would silently miss the right candidate on
  exactly the ambiguous routes this tier exists to fix, falling back to
  first-match-wins for the case it's supposed to resolve. This is free (same
  `findCallingPoint()` data every call site already has in hand, no extra
  API call). Still falls back to first-match-wins if that tier can't resolve
  it either (e.g. the board didn't return calling points, or two services
  somehow share std/toc and land within tolerance of each other at the same
  stop), so this doesn't add a new failure mode, only fixes the known one
  everywhere destCrs/arrM are populated.
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

### Staging model — every action queues locally, one Submit commits it all

Add/remove/re-add/reorder are **local edits against an in-memory working
copy** (`STAGE` — a `{base, routes, stations, parked, log}` object built by
`rebaseStage()`); nothing touches GitHub until the owner clicks **"Submit N
changes"**, at which point every queued edit lands in **one commit**. This is
what lets adding a route, removing a different one, and reordering the rest
all happen in a single push instead of one noisy commit per click.

- **`ensureStage()`** lazily fetches `routes.json`/`stations.json`/
  `parked-routes.json` fresh from GitHub **once** per session (via
  `ghGetStageBase()`) and anchors `STAGE` with `rebaseStage()`. Every
  subsequent action reuses the in-memory copy — no further network reads
  until Submit. Clearing the GitHub token does **not** clear `STAGE`, so an
  in-progress queue survives a token swap.
- **`stageAdd`/`stageRemove`/`stageReadd`/`stageMove`** are pure functions
  (mirroring `mergeRoute`/`removeRoute`/`readdRoute`/`moveRoute`, which they
  call internally) that return a **new** stage object with the working copy
  updated and a human-readable entry appended to `log` — `base` is passed
  through untouched, so the diff against it always reflects the *whole*
  session's queued changes, not just the last action.
- **`buildCommitPlan(stage)`** diffs the working copy against `stage.base`
  file-by-file (`routes.json`/`stations.json`/`parked-routes.json`) and only
  includes a file if it actually changed — a pure reorder, for instance,
  never touches `stations.json` or `parked-routes.json`. `buildCommitMessage`
  turns `log` into a short subject (the single entry verbatim, or an "N route
  changes" summary) plus one bullet per entry in the body, so the whole batch
  is visible in the commit.
- **`commitStage(stage)`** calls `buildCommitPlan` then `ghCommitFiles` **once**
  with every changed file — this is the only network write in the whole flow.
  On success the DOM layer re-anchors `STAGE` via `rebaseStage()` on the
  just-committed values (not a re-fetch), so the owner can immediately keep
  queuing more changes. **`discardStage(stage)`** reverts the working copy to
  `stage.base` and clears `log`, also without a network round trip.
- **`stageAdd` validates against the current working copy**, not just the
  original base — so queuing two routes with the same id in one session (or a
  route whose id collides with one added earlier in the same batch) is still
  rejected, exactly as if each had gone through its own commit.

Key pieces, all reused rather than rebuilt:

- **One commit via the Git Data API** (`ghCommitFiles` in `add-route.js`):
  ref → base tree → tree (inline file `content`, no separate blobs) → commit
  → update ref. `commitStage` always writes every changed file in this single
  call, so the push trigger fires exactly once regardless of how many
  add/remove/reorder actions were queued.
- **Remove / re-add** move the full route object between the working `routes`
  and `parked` arrays (`removeRoute`/`readdRoute`, called by `stageRemove`/
  `stageReadd`). Type-agnostic — a parked connection route (Henley) re-adds
  with its exact `change`/`minConnectionMins`, no research. Removed data is
  auto-pruned by the next weekly cron full run (which rebuilds `schedule.json`
  from `routes.json` only); until then a re-add is instant because the data
  is still there.
- **Delete forever** (`purgeParked`, called by `stageDelete`) drops a parked
  route from `parked-routes.json` entirely rather than moving it anywhere —
  unlike Remove, this isn't reversible from the UI once submitted (only by
  restoring `parked-routes.json` from git history). A confirm dialog spells
  this out; the button styling (`.manage-btn-danger`) is deliberately
  distinct from Re-add's so the two aren't confused at a glance.
- **Creating a connection route** in the add form (`buildRoute()`, called by
  `stageAdd`) sets `change`/`minConnectionMins` (default 5) alongside
  `from`/`to`, and includes the change station's display name in the
  `stations.json` merge. The page shows the same platform-adjacency research
  warning as this file's "Adding a route" section, but doesn't block on it —
  the owner is trusted to have actually checked, same as a hand-edit would be.
- **Reordering** (`moveRoute`, called by `stageMove`) swaps a route with its
  neighbour in the working copy only — nothing is written until Submit, so
  several reorders (and any other queued edits) land together. A pure reorder
  batch adds no missing route ids, so the delta-aware push below no-ops, same
  as a removal — purely a metadata commit, no RTT calls.
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

## Quick (session-only) live routes

A second, much lighter way to see an arbitrary route, built directly into
`app.js` (not the builder page) — no GitHub token, no commit, no schedule
fetch, just an instant view of Darwin's live departure board. A "**+**" chip
at the end of the route picker (`renderRoutePicker()`) opens a small sheet
(`#quick-route-overlay` in `index.html`) with From/To station autocomplete
(`stations_all.json`, lazily fetched the first time the sheet opens — same
reasoning as the builder page keeping it out of the main precache). The
resulting route object gets `liveOnly: true` and an id prefixed `q-` (e.g.
`q-rdg-bri`) so it can never collide with a real, git-committed route id.

**Deliberately session-scoped, not a permanent add** — this was an explicit
design decision, not an oversight: quick routes and their live-board cache
live in **`sessionStorage`**, not `localStorage`, so the browser itself
enforces "gone when the tab/browser session ends" rather than needing cleanup
code. `loadUserRoutes()`/`saveUserRoutes()`/`mergeUserRoutes()` read/write
`sessionStorage.userRoutes`; `ROUTES` is `routes.json`'s curated entries with
these appended (curated ones stay first, so `ROUTES[0]` — the default active
route — is never displaced by a quick route). Don't "fix" this to
`localStorage` — that's the opposite of what was asked for.

**No schedule.json entry at all** — `LIVE_ONLY_BOARDS` (routeId → `{out,
ret}`) plays the same role `SCHEDULE.routes[id]` plays for curated routes, but
is populated purely by fetching the live board and mapping it straight into
leg-shaped objects (`synthesizeLiveLegs()`), since there's no RTT schedule to
overlay live data onto. This reuses everything the existing live overlay
already does — `fetchBoard()` (same two calls `overlayDirectLive` makes),
`liveMinute()`, `findCallingPoint()` (for the destination's scheduled/live
arrival — the board is already filtered `filterType:'to'`), and
`derivePlatformState()` — called with a **null booked platform** (there isn't
one for a quick route), so a live platform always reads as confirmed, never
"changed": there's nothing to compare it against. `leg.uid` is always `null`
— Darwin's `serviceID` isn't the RTT identity RTT deep links need, so
`directCard()`'s existing `leg.uid ? ... : ''` guard already hides the link
with no card changes. Quick routes are **direct only** — no change-station
field in the sheet, matching the connection-scope decision already made for
the builder.

**Never wipe the last-known board on a failed fetch** — `mergeLiveOnlyBoard()`
(factored out specifically so this is unit-testable) only replaces `out`/
`ret` for whichever board actually succeeded that round, mirroring
`applyDirectOverlay`'s own no-wipe-on-failure behaviour. This is what makes a
quick route robust to a dropped connection (e.g. a Tube tunnel): the last
board keeps rendering, the status bar shows "stale" via the *existing*
`staleLiveLabel()` machinery, and `window.addEventListener('online', ...)`
already re-fetches on reconnect — none of that needed any new code.

**The live-board cache shape differs from curated routes'** — `saveLiveCache`/
`restoreLiveCacheForRoute` branch on `route.liveOnly`: curated routes cache a
*sparse diff* of `_live*` fields keyed by uid (`snapshotLegs`/`restoreLegs`),
merged onto freshly-loaded schedule legs on restore. A quick route has no
separate schedule to merge onto, so its cached payload is the **full
synthesized leg array** itself, stored under the same `liveCache:<id>` key
name (same 1-hour staleness check) but in `sessionStorage` instead of
`localStorage`. This is why a quick route's last board still shows instantly
after a reload *within the same tab session*, but is gone after the tab/
browser closes — the same mechanism the requirement asked for, just backed by
a different store.

**Date nav is hidden and forced to today** for a quick route (`render()`) —
there's no other day to show, only "now". `#schedule-age` is blanked for the
same reason: `schedule.json`'s generation time is meaningless for a route
that has no entry in it. Removing a quick route (the chip's "×") needs no
confirmation dialog, unlike the builder's Remove/Delete-forever — it's
local-only and instantly reversible by just re-adding it.

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

**This sandbox only has Chromium pre-installed, not WebKit, and not a real
Firefox-for-Android build either** — so even the manual Playwright recipe
below can't catch a bug that's specific to either of the app's actual
visitor browsers. The station-picker bug this section exists to warn about
wasn't a single-engine problem: it hit both iOS Safari (WebKit) *and*
Firefox for Android (Gecko) — two unrelated rendering engines, independently
confirmed (the latter via Mozilla's own bug tracker, not just guesswork).
That's the real lesson: mobile-browser support for less-common native form
controls (`<datalist>` here, but this generalizes) is inconsistent enough
that "which mobile engine" isn't a safe way to scope the risk down — assume
any of them might be the one that silently fails. This isn't hypothetical:
the original `<datalist>`-based station pickers passed every unit test and
looked correct end-to-end in a real, Playwright-driven Chromium session —
the bug (zero suggestions, ever) only surfaced when actual visitors tried it
on their own phones, on two different browsers. `npm install playwright`'s
WebKit build isn't an option either — downloading a new browser binary isn't
possible in this sandbox (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set
specifically to stop that) — and there's no Firefox-for-Android equivalent
available here at all, real or emulated. Given this app's design center is a
visitor's phone (the whole Darwin-key/settings-⚙ flow), any new non-trivial
interactive widget (dropdowns, comboboxes, custom pickers — anything beyond
a plain input/button) should either (a) be checked against known mobile
support gaps — across engines, not just one — for whatever native element
it might otherwise lean on, before writing it, or (b) be
flagged to the visitor as needing a real on-device check, rather than
reported as verified off of a Chromium-only pass.

### When a UI change needs a real-device check — always hand over Termux steps

The visitor's main browser is **Firefox for Android**, not desktop Chrome or
iOS Safari — worth remembering as the primary real-device target for this
kind of check, alongside whatever else might come up (this is exactly the
browser that hit the `<datalist>` bug above). Whenever a change touches any
non-trivial interactive widget — anything beyond a plain input/button/link,
so dropdowns, comboboxes, custom pickers, anything relying on a native form
control's rendering — and could plausibly render or behave differently
between Chromium and Firefox for Android, **always give the visitor the
concrete steps to check it themselves**, rather than assuming they'll
remember the process or ask for it. Don't just say "please verify on your
phone" — spell out the actual recipe every time, since re-deriving it isn't
something to expect of the visitor between sessions.

The recipe (confirmed workable — this is the one path that actually gets a
real Firefox-for-Android/GeckoView session onto a live copy of a branch,
after two others were tried and ruled out in this same investigation: an
outbound tunnel from this sandbox to expose a local server publicly was
blocked at the network-policy level — `localtunnel`'s relay port and
`cloudflared`'s QUIC/HTTP2 tunnel transport were both confirmed unreachable
here, only plain client-initiated HTTPS gets through — and a LAN-style test
doesn't work either, since this sandbox isn't on the visitor's home network
no matter what keeps a server process alive on this end):

1. Install **Termux** (from F-Droid, not the Play Store build — outdated/
   unmaintained there) on the Android phone itself.
2. `pkg update -y && pkg install -y git python`
3. `git clone https://github.com/quiet-fern-path/train-times.git && cd train-times`
   (add a PAT into the URL, `https://<token>@github.com/...`, if the repo is
   private — the same kind of fine-grained token already used for the route
   builder works) then `git checkout <branch-name>`.
4. `python -m http.server 8123`
5. Open **Firefox for Android** on the same phone, navigate to
   `http://127.0.0.1:8123/` (or `localhost`).

This sidesteps every network restriction above entirely, because the server
and the browser under test are the same device — no tunnel, no LAN, no
sandbox egress policy involved. The only gotcha worth flagging up front:
some Android builds suspend backgrounded apps aggressively, so if the server
drops when switching to Firefox, either split-screen the two apps or use
Termux's persistent notification to hold a wake lock while testing.

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
