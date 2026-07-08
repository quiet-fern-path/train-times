"""Tests for fetch_schedule.py.

Run with: python3 scripts/test_fetch_schedule.py
or:       python3 -m unittest discover -s scripts -p 'test_*.py'

RTT_TOKEN is read from the environment at import time by the module under
test, so it's set here (before the import) to a dummy value — no real
token or network access is needed to run these tests; every RTT API call
is mocked.
"""

import contextlib
import io
import json
import os
import sys
import unittest
from datetime import date, datetime, timezone
from unittest.mock import patch, MagicMock

os.environ.setdefault("RTT_TOKEN", "test-token")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_schedule as fs  # noqa: E402


def make_svc(uid, service_date, dep_iso=None, arr_iso=None, display_as="CALL",
             in_passenger_service=True, platform_planned=None, platform_actual=None,
             platform_forecast=None, operator="GW"):
    """Build a minimal RTT /gb-nr/location service item, shaped like the
    real API response (see CLAUDE.md's "New RTT API" section)."""
    svc = {
        "scheduleMetadata": {
            "identity": uid,
            "departureDate": service_date,
            "inPassengerService": in_passenger_service,
            "operator": {"code": operator},
        },
        "temporalData": {"displayAs": display_as},
        "locationMetadata": {
            "platform": {
                "planned": platform_planned,
                "actual": platform_actual,
                "forecast": platform_forecast,
            }
        },
    }
    if dep_iso:
        svc["temporalData"]["departure"] = {"scheduleAdvertised": dep_iso}
    if arr_iso:
        svc["temporalData"]["arrival"] = {"scheduleAdvertised": arr_iso}
    return svc


class TestTimeHelpers(unittest.TestCase):
    def test_dt_to_m_daytime_no_offset(self):
        self.assertEqual(fs.dt_to_m(datetime(2026, 7, 2, 7, 54)), 474)

    def test_dt_to_m_at_day_start_hour_no_offset(self):
        # 03:00 is the first minute of the *current* timetable day, not the
        # tail end of the previous one.
        self.assertEqual(fs.dt_to_m(datetime(2026, 7, 2, 3, 0)), 180)

    def test_dt_to_m_post_midnight_gets_1440_offset(self):
        # The core of the 3am timetable-day convention (see CLAUDE.md):
        # 00:00-02:59 sorts *after* 23:59 within the same timetable day.
        self.assertEqual(fs.dt_to_m(datetime(2026, 7, 2, 1, 30)), 1530)
        self.assertEqual(fs.dt_to_m(datetime(2026, 7, 2, 0, 0)), 1440)
        self.assertEqual(fs.dt_to_m(datetime(2026, 7, 2, 2, 59)), 1619)

    def test_dt_to_m_none(self):
        self.assertIsNone(fs.dt_to_m(None))

    def test_dt_to_hhmm(self):
        self.assertEqual(fs.dt_to_hhmm(datetime(2026, 7, 2, 7, 54)), "07:54")
        self.assertEqual(fs.dt_to_hhmm(datetime(2026, 7, 2, 1, 5)), "01:05")

    def test_dt_to_hhmm_none(self):
        self.assertIsNone(fs.dt_to_hhmm(None))

    def test_day_window_spans_03_00_to_02_59_next_day(self):
        self.assertEqual(
            fs.day_window(date(2026, 7, 2)),
            ("2026-07-02T03:00:00", "2026-07-03T02:59:00"),
        )

    def test_parse_dt_strips_timezone_treats_as_local(self):
        self.assertEqual(fs.parse_dt("2026-07-02T07:54:00+01:00"), datetime(2026, 7, 2, 7, 54, 0))
        self.assertEqual(fs.parse_dt("2026-07-02T07:54:00Z"), datetime(2026, 7, 2, 7, 54, 0))

    def test_parse_dt_none(self):
        self.assertIsNone(fs.parse_dt(None))
        self.assertIsNone(fs.parse_dt(""))


class TestPassengerParsing(unittest.TestCase):
    def test_call_start_terminate_are_passenger_calls(self):
        for display in ("CALL", "STARTS", "TERMINATES"):
            with self.subTest(display=display):
                self.assertTrue(fs._is_passenger_call(make_svc("U1", "2026-07-02", display_as=display)))

    def test_pass_is_not_a_passenger_call(self):
        self.assertFalse(fs._is_passenger_call(make_svc("U1", "2026-07-02", display_as="PASS")))

    def test_missing_display_as_is_not_a_passenger_call(self):
        # None (no displayAs) is treated as PASS per the API spec.
        self.assertFalse(fs._is_passenger_call(make_svc("U1", "2026-07-02", display_as=None)))

    def test_non_passenger_service_excluded_regardless_of_display(self):
        self.assertFalse(fs._is_passenger_call(
            make_svc("U1", "2026-07-02", display_as="CALL", in_passenger_service=False)
        ))

    def test_parse_dep_extracts_fields(self):
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:54:00",
                        platform_planned="3", platform_actual="3")
        d = fs.parse_dep(svc)
        self.assertEqual(d["uid"], "U1")
        self.assertEqual(d["serviceDate"], "2026-07-02")
        self.assertEqual(d["dep"], "07:54")
        self.assertEqual(d["depM"], 474)
        self.assertEqual(d["platform"], "3")
        self.assertTrue(d["platformConfirmed"])
        self.assertEqual(d["toc"], "GW")

    def test_parse_dep_platform_not_confirmed_without_actual(self):
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:54:00", platform_planned="3")
        self.assertFalse(fs.parse_dep(svc)["platformConfirmed"])

    def test_parse_dep_none_for_non_passenger_call(self):
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:54:00", display_as="PASS")
        self.assertIsNone(fs.parse_dep(svc))

    def test_parse_dep_none_without_departure_time(self):
        self.assertIsNone(fs.parse_dep(make_svc("U1", "2026-07-02")))

    def test_parse_dep_falls_back_to_forecast_platform_when_planned_is_absent(self):
        # RTT's real (WTT-booked) `planned` platform is only populated for
        # the calendar day a query is made — confirmed live: 100% same-day
        # vs 0% a week ahead. `forecast` (a prediction, mutually exclusive
        # with `planned`) is what fills the other 89 days of the lookahead.
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:54:00", platform_forecast="4")
        self.assertEqual(fs.parse_dep(svc)["platform"], "4")

    def test_parse_dep_prefers_planned_over_forecast_when_both_present(self):
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:54:00",
                        platform_planned="3", platform_forecast="4")
        self.assertEqual(fs.parse_dep(svc)["platform"], "3")

    def test_parse_dep_platform_confirmed_still_based_on_actual_not_forecast(self):
        # A forecast platform is a prediction, not a live confirmation —
        # platformConfirmed must stay false even though a platform value is
        # now present, exactly as it would with planned+no actual.
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:54:00", platform_forecast="4")
        self.assertFalse(fs.parse_dep(svc)["platformConfirmed"])

    def test_parse_dep_platform_none_when_neither_planned_nor_forecast_present(self):
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:54:00")
        self.assertIsNone(fs.parse_dep(svc)["platform"])

    def test_parse_arr_extracts_fields(self):
        svc = make_svc("U1", "2026-07-02", arr_iso="2026-07-02T08:12:00")
        a = fs.parse_arr(svc)
        self.assertEqual(a["uid"], "U1")
        self.assertEqual(a["arr"], "08:12")
        self.assertEqual(a["arrM"], 492)

    def test_parse_arr_none_without_arrival_time(self):
        self.assertIsNone(fs.parse_arr(make_svc("U1", "2026-07-02")))


class TestResolveArrival(unittest.TestCase):
    """_resolve_arrival() is the fix for a real shipped bug: an identity
    that calls at a station more than once on the same serviceDate (an
    out-and-back working) used to have its arrival occurrences overwritten
    down to one in fetch_station_day, so a departure could get paired with
    a leftover arrival from an unrelated earlier calling of the same
    identity — producing a leg whose arrival was before its departure. See
    CLAUDE.md's "Known-correct-on-purpose" note and the fix commit."""

    def test_single_occurrence_normal_case(self):
        dep = {"depM": 423}
        candidates = [{"arr": "07:27", "arrM": 447}]
        arr_m, arr = fs._resolve_arrival(dep, candidates)
        self.assertEqual(arr_m, 447)
        self.assertEqual(arr["arr"], "07:27")

    def test_cross_midnight_boundary_gets_1440_nudge(self):
        # dep 02:24 (depM 1584 = 144+1440), arr 03:11 (raw arrM 191).
        dep = {"depM": 1584}
        candidates = [{"arr": "03:11", "arrM": 191}]
        arr_m, _ = fs._resolve_arrival(dep, candidates)
        self.assertEqual(arr_m, 191 + 1440)

    def test_wrong_direction_join_is_dropped(self):
        # A service arriving at origin then continuing on past it (not
        # towards this leg's destination) is real but not this journey —
        # not a day-boundary crossing since depM < 1440.
        dep = {"depM": 379}  # 06:19
        candidates = [{"arr": "06:18", "arrM": 378}]
        self.assertIsNone(fs._resolve_arrival(dep, candidates))

    def test_picks_arrival_that_actually_follows_departure_among_repeats(self):
        # Reproduces the exact real-world bug: an identity's stale, earlier
        # calling left an arrival in the candidate list that precedes this
        # departure, alongside the genuine onward arrival. Must pick the
        # latter, not silently drop the leg or pick the earlier one via
        # boundary-nudging it into a bogus ~24h "journey".
        dep = {"depM": 474}  # 07:54
        candidates = [
            {"arr": "07:42", "arrM": 462},  # stale/unrelated earlier calling
            {"arr": "08:05", "arrM": 485},  # genuine onward arrival
        ]
        arr_m, arr = fs._resolve_arrival(dep, candidates)
        self.assertEqual(arr["arr"], "08:05")
        self.assertEqual(arr_m, 485)

    def test_picks_earliest_valid_candidate_when_several_follow(self):
        dep = {"depM": 400}
        candidates = [{"arr": "08:00", "arrM": 480}, {"arr": "07:10", "arrM": 430}]
        arr_m, arr = fs._resolve_arrival(dep, candidates)
        self.assertEqual(arr["arr"], "07:10")
        self.assertEqual(arr_m, 430)

    def test_no_candidates_returns_none(self):
        self.assertIsNone(fs._resolve_arrival({"depM": 400}, []))

    def test_all_candidates_invalid_returns_none(self):
        dep = {"depM": 500}
        candidates = [{"arr": "06:00", "arrM": 360}, {"arr": "07:00", "arrM": 420}]
        self.assertIsNone(fs._resolve_arrival(dep, candidates))

    def test_candidate_without_arrm_is_skipped(self):
        dep = {"depM": 400}
        candidates = [{"arr": None, "arrM": None}, {"arr": "07:00", "arrM": 420}]
        arr_m, arr = fs._resolve_arrival(dep, candidates)
        self.assertEqual(arr_m, 420)


class TestFetchStationDay(unittest.TestCase):
    def setUp(self):
        fs._station_day_cache.clear()

    def test_repeated_identity_produces_multiple_occurrences(self):
        svcs = [
            make_svc("Y1", "2026-07-02", dep_iso="2026-07-02T07:00:00", arr_iso="2026-07-02T06:50:00"),
            make_svc("Y1", "2026-07-02", dep_iso="2026-07-02T15:00:00", arr_iso="2026-07-02T14:50:00"),
        ]
        with patch.object(fs, "api_get", return_value=svcs) as mock_get:
            deps, arrs = fs.fetch_station_day("TWY", date(2026, 7, 2))
        key = ("Y1", "2026-07-02")
        self.assertEqual(len(deps[key]), 2)
        self.assertEqual(len(arrs[key]), 2)
        mock_get.assert_called_once()

    def test_result_is_cached_per_station_and_day(self):
        with patch.object(fs, "api_get", return_value=[]) as mock_get:
            fs.fetch_station_day("RDG", date(2026, 7, 2))
            fs.fetch_station_day("RDG", date(2026, 7, 2))
        mock_get.assert_called_once()

    def test_different_station_or_day_triggers_new_call(self):
        with patch.object(fs, "api_get", return_value=[]) as mock_get:
            fs.fetch_station_day("RDG", date(2026, 7, 2))
            fs.fetch_station_day("TWY", date(2026, 7, 2))
            fs.fetch_station_day("RDG", date(2026, 7, 3))
        self.assertEqual(mock_get.call_count, 3)

    def test_non_passenger_service_excluded(self):
        svcs = [make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:00:00", display_as="PASS")]
        with patch.object(fs, "api_get", return_value=svcs):
            deps, arrs = fs.fetch_station_day("RDG", date(2026, 7, 2))
        self.assertEqual(deps, {})
        self.assertEqual(arrs, {})

    def test_service_without_identity_skipped(self):
        svc = make_svc(None, "2026-07-02", dep_iso="2026-07-02T07:00:00")
        with patch.object(fs, "api_get", return_value=[svc]):
            deps, _ = fs.fetch_station_day("RDG", date(2026, 7, 2))
        self.assertEqual(deps, {})


class TestFetchLegs(unittest.TestCase):
    def setUp(self):
        fs._station_day_cache.clear()

    def _mock_boards(self, boards):
        """boards: {station: [svc, ...]}. Feeds api_get by matching the
        'code' param, same shape as a real fetch_station_day call site."""
        def side_effect(params):
            return boards.get(params["code"], [])
        return side_effect

    def test_basic_inner_join_produces_one_leg(self):
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:03:00", arr_iso="2026-07-02T07:27:00")
        with patch.object(fs, "api_get", side_effect=self._mock_boards({"RDG": [svc], "HOT": [svc]})):
            legs = fs.fetch_legs("RDG", "HOT", date(2026, 7, 2))
        self.assertEqual(len(legs), 1)
        self.assertEqual(legs[0]["dep"], "07:03")
        self.assertEqual(legs[0]["arr"], "07:27")
        self.assertEqual(legs[0]["depM"], 423)
        self.assertEqual(legs[0]["arrM"], 447)

    def test_departure_without_matching_arrival_is_dropped(self):
        # A departure board contains every service leaving the origin, not
        # just ones heading to this destination — the inner join on
        # (uid, serviceDate) is what actually confirms the service calls
        # at destination (see fetch_legs' docstring / CLAUDE.md).
        svc = make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:03:00")
        with patch.object(fs, "api_get", side_effect=self._mock_boards({"RDG": [svc], "HOT": []})):
            legs = fs.fetch_legs("RDG", "HOT", date(2026, 7, 2))
        self.assertEqual(legs, [])

    def test_repeated_identity_produces_two_correctly_paired_legs(self):
        # End-to-end regression for the missing-trains bug: an identity
        # departing origin twice in a day (an out-and-back working) must
        # produce two legs, each paired with the arrival that actually
        # follows *that* departure, not a single leg contaminated by a
        # stale/leftover arrival.
        origin_svcs = [
            make_svc("Y1", "2026-07-02", dep_iso="2026-07-02T07:35:00"),
            make_svc("Y1", "2026-07-02", dep_iso="2026-07-02T15:00:00"),
        ]
        dest_svcs = [
            make_svc("Y1", "2026-07-02", arr_iso="2026-07-02T07:47:00"),
            make_svc("Y1", "2026-07-02", arr_iso="2026-07-02T15:12:00"),
        ]
        with patch.object(fs, "api_get", side_effect=self._mock_boards({"RDG": origin_svcs, "HOT": dest_svcs})):
            legs = fs.fetch_legs("RDG", "HOT", date(2026, 7, 2))
        self.assertEqual(len(legs), 2)
        pairs = {(l["dep"], l["arr"]) for l in legs}
        self.assertEqual(pairs, {("07:35", "07:47"), ("15:00", "15:12")})
        for leg in legs:
            self.assertLess(leg["depM"], leg["arrM"])

    def test_legs_sorted_by_departure(self):
        svcs = [
            make_svc("U2", "2026-07-02", dep_iso="2026-07-02T09:00:00", arr_iso="2026-07-02T09:20:00"),
            make_svc("U1", "2026-07-02", dep_iso="2026-07-02T07:00:00", arr_iso="2026-07-02T07:20:00"),
        ]
        with patch.object(fs, "api_get", side_effect=self._mock_boards({"RDG": svcs, "HOT": svcs})):
            legs = fs.fetch_legs("RDG", "HOT", date(2026, 7, 2))
        self.assertEqual([l["dep"] for l in legs], ["07:00", "09:00"])

    def test_different_service_dates_not_joined(self):
        # Cross-calendar-day identity recycling (see CLAUDE.md) must not
        # join a departure on one day to an arrival on another.
        dep_svc = make_svc("Y1", "2026-07-02", dep_iso="2026-07-02T07:35:00")
        arr_svc = make_svc("Y1", "2026-07-01", arr_iso="2026-07-01T07:47:00")
        with patch.object(fs, "api_get", side_effect=self._mock_boards({"RDG": [dep_svc], "HOT": [arr_svc]})):
            legs = fs.fetch_legs("RDG", "HOT", date(2026, 7, 2))
        self.assertEqual(legs, [])


class TestFetchConnection(unittest.TestCase):
    def _mock_legs(self, out_legs1, out_legs2):
        """fetch_connection's build_direction() fetches legs1/legs2 for
        *both* directions (out and ret) — key the stub by (a, b) so the
        'out' direction gets our fixtures and 'ret' gets empty lists,
        rather than assuming call order."""
        def side_effect(a, b, tday):
            if (a, b) == ("RDG", "TWY"):
                return out_legs1
            if (a, b) == ("TWY", "HOT"):
                return out_legs2
            return []
        return side_effect

    def test_picks_earliest_leg2_satisfying_min_connection(self):
        legs1 = [{"uid": "A1", "serviceDate": "2026-07-02", "dep": "07:03", "depM": 423,
                  "arr": "07:15", "arrM": 435, "platform": None, "platformConfirmed": False, "toc": "GW"}]
        legs2 = [
            {"uid": "B1", "serviceDate": "2026-07-02", "dep": "07:16", "depM": 436,
             "arr": "07:20", "arrM": 440, "platform": None, "platformConfirmed": False, "toc": "GW"},  # only 1 min - too tight
            {"uid": "B2", "serviceDate": "2026-07-02", "dep": "07:18", "depM": 438,
             "arr": "07:27", "arrM": 447, "platform": None, "platformConfirmed": False, "toc": "GW"},  # 3 min - valid, earliest
            {"uid": "B3", "serviceDate": "2026-07-02", "dep": "07:48", "depM": 468,
             "arr": "07:57", "arrM": 477, "platform": None, "platformConfirmed": False, "toc": "GW"},  # valid but later
        ]
        with patch.object(fs, "fetch_legs", side_effect=self._mock_legs(legs1, legs2)):
            result = fs.fetch_connection("RDG", "TWY", "HOT", 3, [date(2026, 7, 2)])
        out = result["out"]
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["uid2"], "B2")
        self.assertEqual(out[0]["changeMins"], 3)
        self.assertEqual(out[0]["arr"], "07:27")

    def test_leg1_with_no_valid_connection_is_dropped(self):
        legs1 = [{"uid": "A1", "serviceDate": "2026-07-02", "dep": "23:50", "depM": 1430,
                  "arr": "23:58", "arrM": 1438, "platform": None, "platformConfirmed": False, "toc": "GW"}]
        legs2 = [{"uid": "B1", "serviceDate": "2026-07-02", "dep": "23:59", "depM": 1439,
                  "arr": "00:05", "arrM": 1445, "platform": None, "platformConfirmed": False, "toc": "GW"}]
        with patch.object(fs, "fetch_legs", side_effect=self._mock_legs(legs1, legs2)):
            result = fs.fetch_connection("RDG", "TWY", "HOT", 3, [date(2026, 7, 2)])
        self.assertEqual(result["out"], [])

    def test_fetches_both_directions(self):
        with patch.object(fs, "fetch_legs", return_value=[]) as mock_legs:
            fs.fetch_connection("RDG", "TWY", "HOT", 3, [date(2026, 7, 2)])
        calls = [c.args[:2] for c in mock_legs.call_args_list]
        self.assertIn(("RDG", "TWY"), calls)
        self.assertIn(("TWY", "HOT"), calls)
        self.assertIn(("HOT", "TWY"), calls)
        self.assertIn(("TWY", "RDG"), calls)


class TestRateLimiting(unittest.TestCase):
    def _resp(self, headers):
        r = MagicMock()
        r.headers = headers
        return r

    def test_pauses_20s_when_minute_budget_nearly_exhausted(self):
        with patch.object(fs.time, "sleep") as mock_sleep:
            fs._adjust_delay(self._resp({"X-RateLimit-Remaining-Minute": "2"}))
        mock_sleep.assert_called_once_with(20)

    def test_no_pause_when_minute_budget_healthy(self):
        with patch.object(fs.time, "sleep") as mock_sleep:
            fs._adjust_delay(self._resp({"X-RateLimit-Remaining-Minute": "10"}))
        mock_sleep.assert_not_called()

    def test_pauses_until_next_hour_when_hour_budget_exhausted(self):
        with patch.object(fs.time, "sleep") as mock_sleep, \
             patch.object(fs, "_seconds_until_next_hour", return_value=42):
            fs._adjust_delay(self._resp({"X-RateLimit-Remaining-Hour": "0"}))
        mock_sleep.assert_called_once_with(42)

    def test_no_pause_when_headers_absent(self):
        with patch.object(fs.time, "sleep") as mock_sleep:
            fs._adjust_delay(self._resp({}))
        mock_sleep.assert_not_called()

    def test_seconds_until_next_hour_is_within_the_hour(self):
        secs = fs._seconds_until_next_hour()
        self.assertGreaterEqual(secs, 1)
        self.assertLessEqual(secs, 3600)


class TestApiGet(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(fs, "_headers", return_value={"Authorization": "Bearer x"})
        patcher.start()
        self.addCleanup(patcher.stop)
        sleep_patcher = patch.object(fs.time, "sleep")
        self.mock_sleep = sleep_patcher.start()
        self.addCleanup(sleep_patcher.stop)

    def _resp(self, status, services=None, headers=None):
        r = MagicMock()
        r.status_code = status
        r.headers = headers or {}
        r.json.return_value = {"services": services or []}
        return r

    def test_retries_on_429_then_succeeds(self):
        responses = [self._resp(429, headers={"Retry-After": "5"}), self._resp(200, services=[{"a": 1}])]
        with patch.object(fs.requests, "get", side_effect=responses):
            result = fs.api_get({"code": "RDG"})
        self.assertEqual(result, [{"a": 1}])
        self.mock_sleep.assert_any_call(5)

    def test_401_raises_system_exit(self):
        with patch.object(fs.requests, "get", return_value=self._resp(401)):
            with self.assertRaises(SystemExit):
                fs.api_get({"code": "RDG"})

    def test_204_returns_empty_list(self):
        with patch.object(fs.requests, "get", return_value=self._resp(204)):
            self.assertEqual(fs.api_get({"code": "RDG"}), [])

    def test_unexpected_status_returns_empty_list_without_looping(self):
        with patch.object(fs.requests, "get", return_value=self._resp(500)):
            self.assertEqual(fs.api_get({"code": "RDG"}), [])

    def test_network_error_retries(self):
        with patch.object(
            fs.requests, "get",
            side_effect=[fs.requests.RequestException("boom"), self._resp(200, services=[{"a": 1}])],
        ):
            result = fs.api_get({"code": "RDG"})
        self.assertEqual(result, [{"a": 1}])


class TestMainRoutesMerge(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir.name)
        self.addCleanup(os.chdir, self.orig_cwd)

        self.routes = [
            {"id": "rdg-oxf", "from": "RDG", "to": "OXF"},
            {"id": "rdg-mai", "from": "RDG", "to": "MAI"},
        ]
        with open("routes.json", "w") as f:
            json.dump(self.routes, f)

    def _run_main_quietly(self):
        with contextlib.redirect_stdout(io.StringIO()):
            fs.main()

    def test_full_run_overwrites_all_routes(self):
        with patch.object(sys, "argv", ["fetch_schedule.py"]), \
             patch.object(fs, "fetch_direct", return_value={"out": [], "ret": []}) as mock_fetch:
            self._run_main_quietly()
        self.assertEqual(mock_fetch.call_count, 2)
        with open("data/schedule.json") as f:
            result = json.load(f)
        self.assertEqual(set(result["routes"]), {"rdg-oxf", "rdg-mai"})

    def test_scoped_run_merges_and_preserves_other_routes(self):
        os.makedirs("data", exist_ok=True)
        existing = {
            "routes": {
                "rdg-oxf": {"out": [{"stale": True}], "ret": []},
                "rdg-mai": {"out": [{"stale": True}], "ret": []},
            },
            "generated_at": "2026-01-01T00:00:00Z",
        }
        with open("data/schedule.json", "w") as f:
            json.dump(existing, f)

        with patch.object(sys, "argv", ["fetch_schedule.py", "--routes", "rdg-mai"]), \
             patch.object(fs, "fetch_direct", return_value={"out": [{"fresh": True}], "ret": []}):
            self._run_main_quietly()

        with open("data/schedule.json") as f:
            result = json.load(f)
        # Only the targeted route was refetched...
        self.assertEqual(result["routes"]["rdg-mai"]["out"], [{"fresh": True}])
        # ...the other route's last-known-good data survives untouched.
        self.assertEqual(result["routes"]["rdg-oxf"]["out"], [{"stale": True}])

    def test_unknown_route_id_raises(self):
        with patch.object(sys, "argv", ["fetch_schedule.py", "--routes", "nonexistent"]):
            with self.assertRaises(SystemExit):
                fs.main()


class TestMergePlatformsForToday(unittest.TestCase):
    """--platforms-only: a cheap daily refresh of just today's platform
    fields, matched by (uid, serviceDate) — must never touch any other
    field or any other day's legs (see merge_platforms_for_today's
    docstring: this is deliberately not the --routes whole-route merge,
    which would wipe out the other 89 days of data)."""

    def setUp(self):
        import tempfile
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir.name)
        self.addCleanup(os.chdir, self.orig_cwd)

        self.routes = [
            {"id": "rdg-oxf", "from": "RDG", "to": "OXF"},
            {"id": "rdg-hoh", "from": "RDG", "to": "HOT", "change": "TWY", "minConnectionMins": 3},
        ]

    def _run_quietly(self, fn, *args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return fn(*args, **kwargs)

    def test_direct_route_updates_only_platform_fields_of_matched_leg(self):
        os.makedirs("data", exist_ok=True)
        existing = {
            "routes": {
                "rdg-oxf": {
                    "out": [{
                        "uid": "U1", "serviceDate": "2026-07-08",
                        "dep": "07:03", "depM": 423, "arr": "07:40", "arrM": 460,
                        "platform": None, "platformConfirmed": False,
                    }],
                    "ret": [],
                },
            },
            "generated_at": "2026-01-01T00:00:00Z",
        }
        with open("data/schedule.json", "w") as f:
            json.dump(existing, f)

        fresh = {
            "out": [{
                "uid": "U1", "serviceDate": "2026-07-08",
                "dep": "07:03", "depM": 423, "arr": "07:40", "arrM": 460,
                "platform": "2", "platformConfirmed": True,
            }],
            "ret": [],
        }
        with patch.object(fs, "fetch_direct", return_value=fresh) as mock_fetch:
            self._run_quietly(fs.merge_platforms_for_today, self.routes)

        # Only today's single-day window was queried, not the 90-day lookahead.
        self.assertEqual(mock_fetch.call_args.args[2], [fs.date.today()])

        with open("data/schedule.json") as f:
            result = json.load(f)
        leg = result["routes"]["rdg-oxf"]["out"][0]
        self.assertEqual(leg["platform"], "2")
        self.assertTrue(leg["platformConfirmed"])
        # Every other field is untouched.
        self.assertEqual(leg["dep"], "07:03")
        self.assertEqual(leg["arr"], "07:40")
        self.assertEqual(leg["arrM"], 460)

    def test_connection_route_updates_platform1_and_platform2(self):
        os.makedirs("data", exist_ok=True)
        existing = {
            "routes": {
                "rdg-hoh": {
                    "out": [{
                        "uid1": "A1", "serviceDate1": "2026-07-08",
                        "uid2": "B1", "serviceDate2": "2026-07-08",
                        "dep": "07:03", "changeDep": "07:18", "arr": "07:40",
                        "platform1": None, "platform1Confirmed": False,
                        "platform2": None, "platform2Confirmed": False,
                    }],
                    "ret": [],
                },
            },
            "generated_at": "2026-01-01T00:00:00Z",
        }
        with open("data/schedule.json", "w") as f:
            json.dump(existing, f)

        fresh = {
            "out": [{
                "uid1": "A1", "serviceDate1": "2026-07-08",
                "uid2": "B1", "serviceDate2": "2026-07-08",
                "platform1": "1", "platform1Confirmed": True,
                "platform2": "3", "platform2Confirmed": True,
            }],
            "ret": [],
        }
        with patch.object(fs, "fetch_connection", return_value=fresh):
            self._run_quietly(fs.merge_platforms_for_today, self.routes)

        with open("data/schedule.json") as f:
            result = json.load(f)
        leg = result["routes"]["rdg-hoh"]["out"][0]
        self.assertEqual(leg["platform1"], "1")
        self.assertEqual(leg["platform2"], "3")
        self.assertEqual(leg["dep"], "07:03")  # untouched

    def test_leg_with_no_matching_fresh_counterpart_is_untouched(self):
        os.makedirs("data", exist_ok=True)
        existing = {
            "routes": {"rdg-oxf": {"out": [{
                "uid": "U1", "serviceDate": "2026-07-08",
                "platform": None, "platformConfirmed": False,
            }], "ret": []}},
            "generated_at": "2026-01-01T00:00:00Z",
        }
        with open("data/schedule.json", "w") as f:
            json.dump(existing, f)

        with patch.object(fs, "fetch_direct", return_value={"out": [], "ret": []}):
            self._run_quietly(fs.merge_platforms_for_today, self.routes)

        with open("data/schedule.json") as f:
            result = json.load(f)
        self.assertIsNone(result["routes"]["rdg-oxf"]["out"][0]["platform"])

    def test_route_not_yet_in_existing_data_is_skipped(self):
        os.makedirs("data", exist_ok=True)
        with open("data/schedule.json", "w") as f:
            json.dump({"routes": {}, "generated_at": "2026-01-01T00:00:00Z"}, f)

        with patch.object(fs, "fetch_direct") as mock_fetch, \
             patch.object(fs, "fetch_connection") as mock_conn:
            self._run_quietly(fs.merge_platforms_for_today, self.routes)
        mock_fetch.assert_not_called()
        mock_conn.assert_not_called()

    def test_missing_schedule_json_is_a_no_op(self):
        with patch.object(fs, "fetch_direct") as mock_fetch:
            self._run_quietly(fs.merge_platforms_for_today, self.routes)
        mock_fetch.assert_not_called()
        self.assertFalse(os.path.exists("data/schedule.json"))


class TestPlatformsOnlyCli(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir.name)
        self.addCleanup(os.chdir, self.orig_cwd)

        self.routes = [
            {"id": "rdg-oxf", "from": "RDG", "to": "OXF"},
            {"id": "rdg-mai", "from": "RDG", "to": "MAI"},
        ]
        with open("routes.json", "w") as f:
            json.dump(self.routes, f)

    def _run_main_quietly(self):
        with contextlib.redirect_stdout(io.StringIO()):
            fs.main()

    def test_platforms_only_calls_merge_not_the_full_fetch(self):
        with patch.object(sys, "argv", ["fetch_schedule.py", "--platforms-only"]), \
             patch.object(fs, "merge_platforms_for_today") as mock_merge, \
             patch.object(fs, "fetch_direct") as mock_full_fetch:
            self._run_main_quietly()
        mock_merge.assert_called_once()
        mock_full_fetch.assert_not_called()
        # Called with every configured route (no --routes filter given).
        called_routes = mock_merge.call_args.args[0]
        self.assertEqual({r["id"] for r in called_routes}, {"rdg-oxf", "rdg-mai"})

    def test_platforms_only_combined_with_routes_filter(self):
        with patch.object(sys, "argv", ["fetch_schedule.py", "--platforms-only", "--routes", "rdg-mai"]), \
             patch.object(fs, "merge_platforms_for_today") as mock_merge:
            self._run_main_quietly()
        called_routes = mock_merge.call_args.args[0]
        self.assertEqual({r["id"] for r in called_routes}, {"rdg-mai"})


if __name__ == "__main__":
    unittest.main()
