"""
fetch_schedule.py — pulls forward-looking schedule data from the
RealTimeTrains API (new generation, data.rtt.io, Bearer token auth)
for every route in routes.json and writes schedule.json.

Auth: set RTT_TOKEN in GitHub repo secrets. Register at api-portal.rtt.io.
RTT_TOKEN is a long-lived *refresh* token, not usable directly as a Bearer
token against data.rtt.io — it must be exchanged for a short-lived access
token via GET /api/get_access_token (sent as `Authorization: Bearer
<refresh token>`), which returns {token, validUntil, entitlements}. The
access token is only valid ~20 minutes, far shorter than a full
90-day-lookahead run, so it's refreshed on demand rather than once at
startup — see _headers().

Day convention: each timetable day runs 03:00–02:59, not midnight–midnight,
to capture late-night trains correctly. A service at 01:30 on calendar
2026-07-02 is stored under date "2026-07-01". depM/arrM values for
00:00–02:59 are stored as 1440+ (e.g. 01:30 = 1530) so chronological
sorting within a day is correct. The client mirrors this convention in
its todayStr() and nowM() helpers.

API endpoint: GET /gb-nr/location
  code=RDG    → every service calling at RDG for the day, unfiltered

We deliberately do NOT use filterTo/filterFrom here. RTT's response
schema only reports temporalData for the single queried "code" location
(there's no field anywhere with the full calling pattern of a service —
confirmed against the API spec), so filterTo/filterFrom only narrows which
services are included; it doesn't add information that isn't derivable
another way. Since legs are already built by joining a departure list and
an arrival list on scheduleMetadata.identity, that join works identically
against unfiltered per-station boards. Fetching one unfiltered board per
(station, day) and caching it (see fetch_station_day) means every route
sharing a station reuses the same call instead of each route querying
that station separately per destination — for the 5 routes configured
today, that's 8 distinct stations instead of 12 origin/destination pairs,
roughly a 3x reduction in total API calls.
"""

import argparse
import json
import os
import time
from datetime import date, datetime, timedelta, timezone

import requests

LOOKAHEAD_DAYS = 90
BASE_URL = "https://data.rtt.io"
DAY_START_HOUR = 3   # timetable day begins at 03:00

# Fixed request delay. Confirmed live against the API: entitlements carry
# limits of 30/minute, 750/hour, 9000/day, 30000/week (X-RateLimit-Limit-*
# headers). 2s keeps pace at the 30/minute ceiling (with real headroom once
# request/response latency on top of the sleep is accounted for), and is
# left flat rather than ramped down as the hourly budget runs low — a full
# run's own call count (~720, see module docstring) sits under the 750/hour
# cap, so pre-emptively slowing down before hitting either limit just costs
# wall-clock time in the normal case. _adjust_delay instead pauses hard when
# a budget is actually about to run out, rather than easing off gradually.
_request_delay = 2.0

RTT_REFRESH_TOKEN = os.environ["RTT_TOKEN"]

_access_token = None
_access_token_expiry = None  # tz-aware datetime, from validUntil


def _fetch_access_token():
    """Exchange the refresh token for a short-lived access token."""
    global _access_token, _access_token_expiry
    resp = requests.get(
        f"{BASE_URL}/api/get_access_token",
        headers={"Authorization": f"Bearer {RTT_REFRESH_TOKEN}"},
        timeout=30,
    )
    if resp.status_code == 401:
        raise SystemExit(
            "RTT refresh token rejected (401 from /api/get_access_token). "
            "RTT_TOKEN is invalid or expired — check the repo secret "
            "against the token shown at api-portal.rtt.io."
        )
    resp.raise_for_status()
    data = resp.json()
    _access_token = data["token"]
    _access_token_expiry = datetime.fromisoformat(data["validUntil"])


def _headers():
    """Bearer header for data.rtt.io calls, refreshing the access token
    if it's missing or about to expire."""
    if (
        _access_token is None
        or datetime.now(timezone.utc) >= _access_token_expiry - timedelta(seconds=60)
    ):
        _fetch_access_token()
    return {"Authorization": f"Bearer {_access_token}"}


# ── Time helpers ──────────────────────────────────────────────────────────────

def parse_dt(iso_str):
    """Parse an ISO 8601 datetime to a naive datetime.
    RTT returns UK local time when no timezone is sent in the request."""
    if not iso_str:
        return None
    # Strip timezone suffix — treat as local UK time.
    clean = iso_str.split("+")[0].rstrip("Z")
    return datetime.fromisoformat(clean)


def dt_to_hhmm(dt):
    return f"{dt.hour:02d}:{dt.minute:02d}" if dt else None


def dt_to_m(dt):
    """Minutes since midnight. 00:00–02:59 map to 1440–1619 so that
    post-midnight trains sort after 23:59 within the same timetable day."""
    if dt is None:
        return None
    m = dt.hour * 60 + dt.minute
    return m + 1440 if dt.hour < DAY_START_HOUR else m


def day_window(tday):
    """ISO datetime strings for the 23h59m window of a timetable day.
    tday is the calendar date of the 03:00 start."""
    next_cal = tday + timedelta(days=1)
    return (
        f"{tday.isoformat()}T{DAY_START_HOUR:02d}:00:00",
        f"{next_cal.isoformat()}T{DAY_START_HOUR - 1:02d}:59:00",  # 02:59:00
    )


# ── API layer ─────────────────────────────────────────────────────────────────

def _seconds_until_next_hour():
    """RTT's hourly rate-limit window appears to reset on the wall-clock
    hour, not on a rolling window measured from a run's first request —
    observed live: remaining jumped back up near the 750 cap right after a
    run's calls crossed a clock-hour boundary. That reset timing isn't
    documented anywhere (no X-RateLimit-Reset-style header), so this is a
    best-effort wait based on that observation, not a confirmed contract —
    if it's wrong, the next request either succeeds early (harmless) or
    gets a 429 whose Retry-After the retry loop in api_get() honours."""
    now = datetime.now(timezone.utc)
    next_hour = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    return max(1, int((next_hour - now).total_seconds()))


def _adjust_delay(resp):
    """Pause outright when a budget is actually about to run out, rather
    than easing off gradually as it gets low. A full run's own call count
    sits under the hourly cap (see module docstring), so this account's
    remaining-hour is expected to track this script's own pace almost
    exactly — pre-emptively slowing down before hitting either limit would
    just cost wall-clock time for no benefit in that normal case."""
    remaining_minute = resp.headers.get("X-RateLimit-Remaining-Minute")
    if remaining_minute is not None and int(remaining_minute) <= 2:
        print(f"  Minute budget nearly exhausted ({remaining_minute} left) — pausing 20s")
        time.sleep(20)

    remaining_hour = resp.headers.get("X-RateLimit-Remaining-Hour")
    if remaining_hour is not None and int(remaining_hour) <= 0:
        wait = _seconds_until_next_hour()
        print(f"  Hour budget exhausted — pausing {wait}s for the next hour window")
        time.sleep(wait)


def api_get(params):
    """GET /gb-nr/location with automatic retry on 429. Returns services list.
    Called with only code/timeFrom/timeTo — never filterTo/filterFrom, see
    module docstring."""
    while True:
        try:
            resp = requests.get(
                f"{BASE_URL}/gb-nr/location",
                params=params,
                headers=_headers(),
                timeout=30,
            )
        except requests.RequestException as e:
            print(f"  Network error ({e}), retrying in 30s")
            time.sleep(30)
            continue

        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 60))
            print(f"  429 rate-limited — sleeping {wait}s")
            time.sleep(wait)
            continue

        if resp.status_code == 401:
            # Not a transient condition like 429/empty-result — every
            # subsequent call will fail identically, so retrying would just
            # burn the whole run (and the Action's time budget) producing
            # nothing. Fail fast with a clear diagnosis instead. _headers()
            # already refreshes the access token proactively before expiry,
            # so a 401 here means the access token's entitlements don't
            # cover this endpoint, not a routine expiry.
            raise SystemExit(
                "RTT API returned 401 Unauthorized from /gb-nr/location "
                "despite a freshly-issued access token — check the "
                "entitlements on the RTT_TOKEN refresh token at "
                "api-portal.rtt.io. Aborting rather than continuing to hit "
                "every remaining endpoint with a bad token."
            )

        if resp.status_code == 204:
            # Valid empty response — no services in this window.
            _adjust_delay(resp)
            time.sleep(_request_delay)
            return []

        if resp.status_code != 200:
            print(f"  WARN HTTP {resp.status_code} — params: {params}")
            time.sleep(_request_delay)
            return []

        _adjust_delay(resp)
        time.sleep(_request_delay)
        return resp.json().get("services") or []


# ── Service parsing ───────────────────────────────────────────────────────────

_PASSENGER_DISPLAY = {"CALL", "STARTS", "TERMINATES"}


def _is_passenger_call(svc):
    meta = svc.get("scheduleMetadata", {})
    if not meta.get("inPassengerService", True):
        return False
    td = svc.get("temporalData", {})
    display = td.get("displayAs")
    # None (no displayAs) is treated as PASS per the spec, so exclude it
    return display in _PASSENGER_DISPLAY


def parse_dep(svc):
    """Extract departure data from a service returned by a departure query.
    Returns a dict keyed by uid, or None if not a usable passenger departure."""
    if not _is_passenger_call(svc):
        return None

    td = svc.get("temporalData", {})
    meta = svc.get("scheduleMetadata", {})
    loc_meta = svc.get("locationMetadata", {})

    dep_str = (td.get("departure") or {}).get("scheduleAdvertised")
    dep_dt = parse_dt(dep_str)
    if dep_dt is None:
        return None

    platform_obj = loc_meta.get("platform") or {}
    planned = platform_obj.get("planned")
    actual = platform_obj.get("actual")
    # The API spec documents "forecast" as "not currently used", but live
    # data shows otherwise: it's populated with a predicted platform for
    # services far enough ahead that the WTT-booked `planned` value isn't
    # decided yet, and the two are mutually exclusive (confirmed live: a
    # week-ahead query returned forecast on 439/439 services vs planned on
    # 0/439). Since this script runs weekly and `planned` is null for every
    # date except the one it happens to run on, falling back to `forecast`
    # is the only way to surface any platform at all for most of the
    # 90-day lookahead.
    platform = planned if planned is not None else platform_obj.get("forecast")

    return {
        "uid": meta.get("identity"),
        "serviceDate": meta.get("departureDate"),  # used for RTT deep links
        "toc": (meta.get("operator") or {}).get("code"),
        "dep": dt_to_hhmm(dep_dt),
        "depM": dt_to_m(dep_dt),
        "platform": platform,
        "platformConfirmed": actual is not None,
    }


def parse_arr(svc):
    """Extract arrival data from a service returned by an arrival query."""
    if not _is_passenger_call(svc):
        return None

    td = svc.get("temporalData", {})
    meta = svc.get("scheduleMetadata", {})

    arr_str = (td.get("arrival") or {}).get("scheduleAdvertised")
    arr_dt = parse_dt(arr_str)
    if arr_dt is None:
        return None

    return {
        "uid": meta.get("identity"),
        "serviceDate": meta.get("departureDate"),
        "arr": dt_to_hhmm(arr_dt),
        "arrM": dt_to_m(arr_dt),
    }


# ── Core fetch: one station, one day (cached) ─────────────────────────────────

_station_day_cache = {}


def fetch_station_day(station, tday):
    """Fetch the full, unfiltered board at `station` for one timetable day,
    and parse it into (deps, arrs) dicts keyed by (uid, serviceDate). Cached
    per (station, day): every route whose origin or destination is this
    station on this day reuses the same single API call rather than each
    route querying it separately with its own filterTo/filterFrom.

    Keying on uid alone is not safe: `scheduleMetadata.identity` (e.g.
    "Y15289") is a headcode-style code that TOCs recycle across different
    calendar days, and day_window()'s ~24h query spans parts of two
    calendar dates. Without serviceDate in the key, an unrelated service on
    the other calendar date that happens to reuse the same identity would
    silently overwrite (or get joined with) the correct one in fetch_legs,
    producing a bogus ~24h "leg". serviceDate (scheduleMetadata.departureDate)
    is constant for every call of a single service instance, so it's the
    right disambiguator without affecting genuine same-instance joins."""
    key = (station, tday)
    if key in _station_day_cache:
        return _station_day_cache[key]

    time_from, time_to = day_window(tday)
    svcs = api_get({"code": station, "timeFrom": time_from, "timeTo": time_to})

    deps, arrs = {}, {}
    for svc in svcs:
        d = parse_dep(svc)
        if d and d["uid"]:
            deps[(d["uid"], d["serviceDate"])] = d
        a = parse_arr(svc)
        if a and a["uid"]:
            arrs[(a["uid"], a["serviceDate"])] = a

    result = (deps, arrs)
    _station_day_cache[key] = result
    return result


def fetch_legs(origin, destination, tday):
    """Build legs from origin to destination for one timetable day by
    joining origin's departure index against destination's arrival index on
    (uid, serviceDate) (both from fetch_station_day). A key must appear in
    both — unlike the old filterTo/filterFrom-scoped queries, an unfiltered
    station's departure index contains every service leaving that station,
    so an inner join (not "arrival info if we have it") is what actually
    confirms the service calls at destination.
    Returns a list of leg dicts with date = tday.isoformat()."""
    day_label = tday.isoformat()

    deps, _ = fetch_station_day(origin, tday)
    _, arrs = fetch_station_day(destination, tday)

    legs = []
    for (uid, service_date), dep in deps.items():
        arr = arrs.get((uid, service_date))
        if arr is None:
            continue
        arr_m = arr.get("arrM")
        # dt_to_m() decides the 1440+ offset per-timestamp from hour alone, with
        # no knowledge of the other end of the journey. A leg that crosses the
        # 03:00 day-start boundary (e.g. dep 02:24, arr 03:11) gets its depM
        # offset but not its arrM, leaving arrM < depM. Nudge it into the same
        # 1440+ range so duration/ordering/overtaking comparisons stay correct.
        #
        # But arr_m < depM isn't always a boundary crossing — a service that
        # calls at destination *before* origin in its real running order (e.g.
        # it arrives at origin from further out, then continues on past origin
        # in the opposite direction from destination) will have a departure at
        # "origin" and an arrival at "destination" that are real, but represent
        # the wrong direction of travel, not a same-journey origin->destination
        # hop. Confirmed against live data: e.g. a service arriving Reading
        # 06:18, departing Reading 06:19 (continuing on to Twyford/Henley) has
        # a genuine Twyford departure at 06:25 — joining that Twyford departure
        # to the 06:18 Reading arrival (same uid) would wrongly claim a
        # Twyford->Reading leg, when the service never actually travels that
        # way. Only treat arr_m < depM as a boundary crossing when the
        # departure itself is in the legitimate 00:00-02:59 range (depM already
        # has dt_to_m's 1440+ offset applied); otherwise this is a
        # wrong-direction join and the "leg" is bogus — drop it.
        if arr_m is not None and arr_m < dep["depM"]:
            if dep["depM"] >= 1440:
                arr_m += 1440
            else:
                continue
        legs.append({
            "uid": uid,
            "serviceDate": dep["serviceDate"],
            "date": day_label,
            "dep": dep["dep"],
            "depM": dep["depM"],
            "arr": arr.get("arr"),
            "arrM": arr_m,
            "platform": dep["platform"],
            "platformConfirmed": dep["platformConfirmed"],
            "toc": dep["toc"],
        })

    return sorted(legs, key=lambda l: l["depM"])


# ── Route-level fetch ─────────────────────────────────────────────────────────

def fetch_direct(origin, destination, days):
    """Fetch both directions of a direct route across all lookahead days."""
    out_legs, ret_legs = [], []
    for tday in days:
        out_legs.extend(fetch_legs(origin, destination, tday))
        ret_legs.extend(fetch_legs(destination, origin, tday))
    return {"out": out_legs, "ret": ret_legs}


def fetch_connection(origin, change, destination, min_conn_mins, days):
    """Fetch both directions of a change-required route.

    For each direction, leg-1s and leg-2s are fetched independently then
    paired: for every leg-1, find the earliest leg-2 that departs at least
    min_conn_mins after leg-1 arrives.
    """

    def build_direction(a, b, c):
        paired = []
        for tday in days:
            legs1 = fetch_legs(a, b, tday)
            legs2 = fetch_legs(b, c, tday)

            # Index leg-2s by tday so we can cross-reference even when
            # leg-1 and leg-2 straddle midnight within the same timetable day
            for l1 in legs1:
                if l1["arrM"] is None:
                    continue
                candidates = [
                    l2 for l2 in legs2
                    if l2["depM"] is not None
                    and l2["depM"] - l1["arrM"] >= min_conn_mins
                ]
                if not candidates:
                    continue
                l2 = min(candidates, key=lambda x: x["depM"])
                paired.append({
                    "uid1": l1["uid"],
                    "uid2": l2["uid"],
                    "serviceDate1": l1["serviceDate"],
                    "serviceDate2": l2["serviceDate"],
                    "date": tday.isoformat(),
                    "dep": l1["dep"],
                    "depM": l1["depM"],
                    "changeArr": l1["arr"],
                    "changeArrM": l1["arrM"],
                    "changeDep": l2["dep"],
                    "arr": l2["arr"],
                    "arrM": l2["arrM"],
                    "changeMins": l2["depM"] - l1["arrM"],
                    "platform1": l1["platform"],
                    "platform1Confirmed": l1["platformConfirmed"],
                    "platform2": l2["platform"],
                    "platform2Confirmed": l2["platformConfirmed"],
                    "toc1": l1["toc"],
                    "toc2": l2["toc"],
                })
        return paired

    return {
        "out": build_direction(origin, change, destination),
        "ret": build_direction(destination, change, origin),
    }


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--routes",
        help="Comma-separated route ids (from routes.json) to refetch, e.g. "
             "'rdg-oxf,rdg-mai'. Only queries the stations those routes need "
             "and merges the result into the existing data/schedule.json, "
             "leaving other routes' data untouched — use this for a cheap "
             "targeted refresh instead of the full every-route run. Omit "
             "for the normal full run (all routes, full overwrite).",
    )
    args = parser.parse_args()
    route_filter = (
        {r.strip() for r in args.routes.split(",") if r.strip()}
        if args.routes else None
    )

    with open("routes.json") as f:
        routes = json.load(f)

    if route_filter is not None:
        unknown = route_filter - {route["id"] for route in routes}
        if unknown:
            raise SystemExit(f"Unknown route id(s) in --routes: {', '.join(sorted(unknown))}")
        routes = [route for route in routes if route["id"] in route_filter]

    # Timetable days are calendar dates — the day starts at 03:00 on that date.
    days = [date.today() + timedelta(days=i) for i in range(LOOKAHEAD_DAYS)]

    # A scoped run (--routes) merges into whatever's already on disk instead
    # of overwriting every route, so the other routes' last-known-good data
    # survives a targeted refetch of just the broken ones.
    if route_filter is not None and os.path.exists("data/schedule.json"):
        with open("data/schedule.json") as f:
            result = json.load(f)
        result.setdefault("routes", {})
    else:
        result = {"routes": {}}

    for route in routes:
        rid = route["id"]
        print(f"\nFetching {rid} ({route['from']} ↔ {route['to']})…")
        if route.get("change"):
            result["routes"][rid] = fetch_connection(
                route["from"], route["change"], route["to"],
                route.get("minConnectionMins", 5), days,
            )
        else:
            result["routes"][rid] = fetch_direct(route["from"], route["to"], days)

        out_c = len(result["routes"][rid]["out"])
        ret_c = len(result["routes"][rid]["ret"])
        print(f"  {out_c} outward legs, {ret_c} return legs")

    result["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    os.makedirs("data", exist_ok=True)
    with open("data/schedule.json", "w") as f:
        json.dump(result, f, separators=(",", ":"))

    print("\nDone.")


if __name__ == "__main__":
    main()
