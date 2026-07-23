'use strict';

// Run with: node --test test/
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./loadApp.js');

// Functions loaded via loadApp() run inside a separate vm context/realm, so
// object literals they construct and return (e.g. derivePlatformState's
// {confirmed, changed, hidden}) have a different Object.prototype than this
// test file's realm — assert.deepEqual (deepStrictEqual under assert/strict)
// checks prototype identity and would otherwise fail on structurally
// identical data. Round-tripping through JSON strips the realm-specific
// prototype so plain-data comparisons work as expected.
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('3am timetable-day boundary (see CLAUDE.md — three things must stay in tandem)', () => {
  test('todayStr() before 03:00 returns the previous calendar date', () => {
    const ctx = loadApp({ now: new Date(2026, 6, 2, 2, 30).getTime() });
    assert.equal(ctx.todayStr(), '2026-07-01');
  });

  test('todayStr() at/after 03:00 returns the current calendar date', () => {
    const ctx = loadApp({ now: new Date(2026, 6, 2, 3, 0).getTime() });
    assert.equal(ctx.todayStr(), '2026-07-02');
  });

  test('nowM() before 03:00 adds the 1440 offset to match stored depM/arrM', () => {
    const ctx = loadApp({ now: new Date(2026, 6, 2, 1, 30).getTime() });
    assert.equal(ctx.nowM(), 1530); // 01:30 -> 90 + 1440
  });

  test('nowM() at/after 03:00 is plain minutes-since-midnight', () => {
    const ctx = loadApp({ now: new Date(2026, 6, 2, 13, 23).getTime() });
    assert.equal(ctx.nowM(), 803);
  });

  test('liveMinute() applies the same 1440 offset as stored depM for post-midnight ETDs', () => {
    const ctx = loadApp();
    assert.equal(ctx.liveMinute('01:30'), 1530);
    assert.equal(ctx.liveMinute('13:23'), 803);
    assert.equal(ctx.liveMinute('03:00'), 180);
  });

  test('addDays() rolls the calendar date, independent of the 3am convention', () => {
    const ctx = loadApp();
    assert.equal(ctx.addDays('2026-07-02', 1), '2026-07-03');
    assert.equal(ctx.addDays('2026-07-01', -1), '2026-06-30');
  });
});

describe('overtakers() — a real bug (cancelled legs counted as beaters) already fixed', () => {
  test('a later leg with an earlier-or-equal arrival beats an earlier leg', () => {
    const ctx = loadApp();
    const early = { depM: 400, arrM: 600 };
    const late = { depM: 450, arrM: 580 };
    assert.deepEqual(ctx.overtakers(early, [early, late]), [late]);
  });

  test('cancelled legs are excluded from beating — regression for a real shipped bug', () => {
    const ctx = loadApp();
    const early = { depM: 400, arrM: 600 };
    const fasterButCancelled = { depM: 450, arrM: 580, _cancelled: true };
    assert.deepEqual(ctx.overtakers(early, [early, fasterButCancelled]), []);
  });

  test('a leg never beats itself', () => {
    const ctx = loadApp();
    const leg = { depM: 400, arrM: 600 };
    assert.deepEqual(ctx.overtakers(leg, [leg]), []);
  });

  test('legs with a null arrM are neither beaters nor beaten', () => {
    const ctx = loadApp();
    const noArr = { depM: 400, arrM: null };
    const later = { depM: 450, arrM: 580 };
    assert.deepEqual(ctx.overtakers(noArr, [noArr, later]), []);
    assert.deepEqual(ctx.overtakers(later, [noArr, later]), []);
  });

  test('an earlier-arriving later departure does not get beaten by a slower one', () => {
    const ctx = loadApp();
    const fast = { depM: 450, arrM: 500 };
    const slow = { depM: 400, arrM: 600 };
    assert.deepEqual(ctx.overtakers(fast, [fast, slow]), []);
  });

  test('works on connection legs the same way as direct legs (whole-journey depM/arrM)', () => {
    // Connection legs already carry whole-journey depM/arrM (origin dep,
    // final dest arr) from fetch_connection() — overtakers() doesn't need
    // to know how many legs got them there. See CLAUDE.md: don't
    // reintroduce a !isConnection gate around this.
    const ctx = loadApp();
    const slowConnection = { depM: 400, arrM: 700, uid1: 'A1', uid2: 'B1' };
    const fastConnection = { depM: 450, arrM: 650, uid1: 'A2', uid2: 'B2' };
    assert.deepEqual(ctx.overtakers(slowConnection, [slowConnection, fastConnection]), [fastConnection]);
  });
});

describe('derivePlatformState() — regression for the platformIsConfirmed/platformIsChanged bug', () => {
  // Darwin's real schema only has `platform` and `platformIsHidden` — there
  // is no platformIsConfirmed/platformIsChanged boolean. Before the fix,
  // reading those nonexistent fields meant every live platform rendered as
  // "(planned)" forever. derivePlatformState() must derive confirmed/changed
  // from comparing the live platform to the RTT-scheduled booked one.
  test('no live platform yet -> none of confirmed/changed/hidden', () => {
    const ctx = loadApp();
    assert.deepEqual(plain(ctx.derivePlatformState(null, '3', false)), { confirmed: false, changed: false, hidden: false });
  });

  test('live platform matches booked platform -> confirmed, not changed', () => {
    const ctx = loadApp();
    assert.deepEqual(plain(ctx.derivePlatformState('3', '3', false)), { confirmed: true, changed: false, hidden: false });
  });

  test('live platform differs from booked platform -> changed, not confirmed', () => {
    const ctx = loadApp();
    assert.deepEqual(plain(ctx.derivePlatformState('4', '3', false)), { confirmed: false, changed: true, hidden: false });
  });

  test('live platform with no booked platform to compare against -> confirmed, not changed', () => {
    const ctx = loadApp();
    assert.deepEqual(plain(ctx.derivePlatformState('4', undefined, false)), { confirmed: true, changed: false, hidden: false });
  });

  test('platformIsHidden passes through as its own "hidden" state, distinct from planned', () => {
    const ctx = loadApp();
    assert.deepEqual(plain(ctx.derivePlatformState('3', '3', true)), { confirmed: true, changed: false, hidden: true });
  });
});

describe('matchByTime()', () => {
  test('finds the service whose scheduled departure (std) matches', () => {
    const ctx = loadApp();
    const board = { trainServices: [{ std: '07:03', etd: 'On time' }, { std: '07:35', etd: '5 late' }] };
    assert.equal(ctx.matchByTime(board, '07:35').etd, '5 late');
  });

  test('returns null when nothing matches or the board is empty/missing', () => {
    const ctx = loadApp();
    assert.equal(ctx.matchByTime({ trainServices: [] }, '07:03'), null);
    assert.equal(ctx.matchByTime(null, '07:03'), null);
    assert.equal(ctx.matchByTime({}, '07:03'), null);
  });

  describe('TOC disambiguation — regression for two services sharing a scheduled minute', () => {
    // Two services can share an exact scheduled departure minute (e.g. GWR
    // and Elizabeth line both at 18:48 ex-Paddington) — std alone picked
    // whichever the Darwin board listed first, silently misattributing live
    // delay/platform/cancellation to the wrong train.
    test('prefers the candidate whose operatorCode matches the given toc', () => {
      const ctx = loadApp();
      const board = { trainServices: [{ std: '18:48', operatorCode: 'XR', etd: 'On time' }, { std: '18:48', operatorCode: 'GW', etd: '10 late' }] };
      assert.equal(ctx.matchByTime(board, '18:48', 'GW').etd, '10 late');
      assert.equal(ctx.matchByTime(board, '18:48', 'XR').etd, 'On time');
    });

    test('falls back to first-match-wins when toc is omitted', () => {
      const ctx = loadApp();
      const board = { trainServices: [{ std: '18:48', operatorCode: 'XR' }, { std: '18:48', operatorCode: 'GW' }] };
      assert.equal(ctx.matchByTime(board, '18:48').operatorCode, 'XR');
    });

    test('falls back to first-match-wins when toc matches none of the candidates', () => {
      const ctx = loadApp();
      const board = { trainServices: [{ std: '18:48', operatorCode: 'XR' }, { std: '18:48', operatorCode: 'GW' }] };
      assert.equal(ctx.matchByTime(board, '18:48', 'LM').operatorCode, 'XR');
    });

    test('a single candidate is returned regardless of toc (no ambiguity to resolve)', () => {
      const ctx = loadApp();
      const board = { trainServices: [{ std: '07:03', operatorCode: 'GW' }] };
      assert.equal(ctx.matchByTime(board, '07:03', 'XR').operatorCode, 'GW');
    });
  });
});

describe('findCallingPoint() — live arrival data at a downstream stop, no extra API call', () => {
  test('finds the calling point matching the given crs', () => {
    const ctx = loadApp();
    const svc = { subsequentCallingPoints: [{ callingPoint: [{ crs: 'TWY', et: '07:47' }, { crs: 'OXF', et: '08:20' }] }] };
    assert.equal(ctx.findCallingPoint(svc, 'TWY').et, '07:47');
  });

  test('searches every call-point list, not just the first (services that divide)', () => {
    const ctx = loadApp();
    const svc = {
      subsequentCallingPoints: [
        { callingPoint: [{ crs: 'TWY', et: '07:47' }] },
        { callingPoint: [{ crs: 'HOT', et: '08:05' }] },
      ],
    };
    assert.equal(ctx.findCallingPoint(svc, 'HOT').et, '08:05');
  });

  test('returns null when the crs is never called at, or there are no calling points', () => {
    const ctx = loadApp();
    assert.equal(ctx.findCallingPoint({ subsequentCallingPoints: [] }, 'TWY'), null);
    assert.equal(ctx.findCallingPoint({}, 'TWY'), null);
    const svc = { subsequentCallingPoints: [{ callingPoint: [{ crs: 'OXF' }] }] };
    assert.equal(ctx.findCallingPoint(svc, 'TWY'), null);
  });
});

describe('inlineLiveTime() — compact struck-through-scheduled live time for the change row', () => {
  test('no live time, or live equals scheduled -> plain scheduled text', () => {
    const ctx = loadApp();
    assert.equal(ctx.inlineLiveTime('07:15', null), '07:15');
    assert.equal(ctx.inlineLiveTime('07:15', '07:15'), '07:15');
  });

  test('a differing live time is shown with the scheduled time struck through', () => {
    const ctx = loadApp();
    const html = ctx.inlineLiveTime('07:15', '07:20');
    assert.match(html, /line-through/);
    assert.match(html, /07:15/);
    assert.match(html, /07:20/);
  });
});

describe('applyDirectOverlay() — cancellation + delay projection onto direct legs', () => {
  test('a matched, on-time service is marked live-checked with zero delay', () => {
    const ctx = loadApp();
    const leg = { date: '2026-07-02', dep: '07:03', depM: 423 };
    const board = { trainServices: [{ std: '07:03', etd: 'On time', platform: '3' }] };
    ctx.applyDirectOverlay([leg], '2026-07-02', board);
    assert.equal(leg._liveChecked, true);
    assert.equal(leg._cancelled, false);
    assert.equal(leg._delayMins, 0);
    assert.equal(leg._liveDepM, 423);
    assert.equal(leg._platform, '3');
  });

  test('cancellation is detected via etd === "Cancelled", not just an isCancelled boolean', () => {
    // The boolean field's exact name was never confirmed against a live
    // payload — keep both checks, don't simplify to just the boolean (see
    // CLAUDE.md "Known-correct-on-purpose").
    const ctx = loadApp();
    const leg = { date: '2026-07-02', dep: '07:03', depM: 423 };
    const board = { trainServices: [{ std: '07:03', etd: 'Cancelled' }] };
    ctx.applyDirectOverlay([leg], '2026-07-02', board);
    assert.equal(leg._cancelled, true);
  });

  test('a delayed departure projects _delayMins and _liveDepM using the 3am-aware liveMinute', () => {
    const ctx = loadApp();
    const leg = { date: '2026-07-02', dep: '23:50', depM: 1430 };
    const board = { trainServices: [{ std: '23:50', etd: '00:10' }] };
    ctx.applyDirectOverlay([leg], '2026-07-02', board);
    assert.equal(leg._delayMins, 1450 - 1430); // 00:10 -> 1450 via the 1440 boundary offset
    assert.equal(leg._liveDepM, 1430 + 20);
  });

  test('a leg on a different date than the board is left untouched', () => {
    const ctx = loadApp();
    const leg = { date: '2026-07-03', dep: '07:03', depM: 423 };
    const board = { trainServices: [{ std: '07:03', etd: 'On time' }] };
    ctx.applyDirectOverlay([leg], '2026-07-02', board);
    assert.equal(leg._liveChecked, undefined);
  });

  test('a failed fetch (null board) leaves existing live state untouched rather than wiping it', () => {
    const ctx = loadApp();
    const leg = { date: '2026-07-02', dep: '07:03', depM: 423, _liveChecked: true, _delayMins: 5 };
    ctx.applyDirectOverlay([leg], '2026-07-02', null);
    assert.equal(leg._delayMins, 5);
  });

  describe('destination live arrival (_liveArr) — fixes a real pre-existing gap', () => {
    // directCard already read leg._liveArr || leg.arr, but nothing ever set
    // _liveArr, so every arrival shown was scheduled-only regardless of
    // actual delay. Read from the matched service's own
    // subsequentCallingPoints (already fetched, filtered `to` destCrs) — no
    // extra API call.
    test('a delayed calling point sets _liveArr to the estimated time', () => {
      const ctx = loadApp();
      const leg = { date: '2026-07-02', dep: '07:03', depM: 423, arr: '07:27' };
      const board = {
        trainServices: [{
          std: '07:03', etd: 'On time',
          subsequentCallingPoints: [{ callingPoint: [{ crs: 'PAD', et: '09:13' }] }],
        }],
      };
      ctx.applyDirectOverlay([leg], '2026-07-02', board, 'PAD');
      assert.equal(leg._liveArr, '09:13');
    });

    test('an on-time calling point sets _liveArr to the scheduled arrival', () => {
      const ctx = loadApp();
      const leg = { date: '2026-07-02', dep: '07:03', depM: 423, arr: '07:27' };
      const board = {
        trainServices: [{
          std: '07:03', etd: 'On time',
          subsequentCallingPoints: [{ callingPoint: [{ crs: 'PAD', et: 'On time' }] }],
        }],
      };
      ctx.applyDirectOverlay([leg], '2026-07-02', board, 'PAD');
      assert.equal(leg._liveArr, '07:27');
    });

    test('a cancelled destination calling point marks the whole leg cancelled', () => {
      const ctx = loadApp();
      const leg = { date: '2026-07-02', dep: '07:03', depM: 423, arr: '07:27' };
      const board = {
        trainServices: [{
          std: '07:03', etd: 'On time',
          subsequentCallingPoints: [{ callingPoint: [{ crs: 'PAD', isCancelled: true }] }],
        }],
      };
      ctx.applyDirectOverlay([leg], '2026-07-02', board, 'PAD');
      assert.equal(leg._cancelled, true);
    });

    test('no matching calling point for destCrs leaves _liveArr unset (falls back to scheduled at render time)', () => {
      const ctx = loadApp();
      const leg = { date: '2026-07-02', dep: '07:03', depM: 423, arr: '07:27' };
      const board = { trainServices: [{ std: '07:03', etd: 'On time', subsequentCallingPoints: [] }] };
      ctx.applyDirectOverlay([leg], '2026-07-02', board, 'PAD');
      assert.equal(leg._liveArr, undefined);
    });
  });
});

describe('applyConnectionOverlay() — cancellation/delay projection onto both legs of a connection', () => {
  function baseLeg() {
    return {
      date: '2026-07-02',
      dep: '07:03', depM: 423,
      changeDep: '07:18', changeArrM: 435, changeMins: 3,
    };
  }

  test('leg-1 cancellation is recorded distinctly from leg-2 cancellation', () => {
    const ctx = loadApp();
    const leg = baseLeg();
    const boardA = { trainServices: [{ std: '07:03', etd: 'Cancelled' }] };
    ctx.applyConnectionOverlay([leg], '2026-07-02', boardA, null);
    assert.equal(leg._cancelled, true);
    assert.equal(leg._cancelledLeg, 1);
  });

  test('leg-2 cancellation is recorded as cancelledLeg 2', () => {
    const ctx = loadApp();
    const leg = baseLeg();
    const boardB = { trainServices: [{ std: '07:18', etd: 'Cancelled' }] };
    ctx.applyConnectionOverlay([leg], '2026-07-02', null, boardB);
    assert.equal(leg._cancelled, true);
    assert.equal(leg._cancelledLeg, 2);
  });

  test('a leg-1 delay projects through to _liveChangeMins against leg-2\'s scheduled departure', () => {
    const ctx = loadApp();
    const leg = baseLeg();
    // leg-1 becomes 5 min late -> arrives change point at 435+5=440,
    // leg-2 still scheduled to depart at changeArrM(435)+changeMins(3)=438
    // -> only 438-440 = -2 min to make the connection.
    const boardA = { trainServices: [{ std: '07:03', etd: '07:08' }] };
    ctx.applyConnectionOverlay([leg], '2026-07-02', boardA, null);
    assert.equal(leg._liveChangeMins, -2);
  });

  test('both boards failing leaves existing live state untouched', () => {
    const ctx = loadApp();
    const leg = Object.assign(baseLeg(), { _cancelledLeg: 1, _liveDepM: 428 });
    ctx.applyConnectionOverlay([leg], '2026-07-02', null, null);
    assert.equal(leg._cancelledLeg, 1);
    assert.equal(leg._liveDepM, 428);
  });

  describe('live arrival at the change station (_liveChangeArr) — preferred over projecting delay forward', () => {
    // A GetArrBoardWithDetails query at the change station returns HTTP 500
    // in live testing (see CLAUDE.md) — the real live arrival there comes
    // from leg-1's own departure-board match's subsequentCallingPoints
    // instead, no extra API call.
    test('a real calling-point arrival estimate is preferred over the origin-delay projection', () => {
      const ctx = loadApp();
      const leg = baseLeg();
      // Origin delay alone would project change-arrival to 435+5=440 and
      // leave only 438-440=-2 min for the connection (see the test above),
      // but the calling point says it actually only ran 2 min late into
      // Twyford (437), leaving a comfortable 1 min — the calling point
      // estimate should win, not the cruder projection.
      const boardA = {
        trainServices: [{
          std: '07:03', etd: '07:08',
          subsequentCallingPoints: [{ callingPoint: [{ crs: 'TWY', et: '07:17' }] }],
        }],
      };
      ctx.applyConnectionOverlay([leg], '2026-07-02', boardA, null, 'TWY');
      assert.equal(leg._liveChangeArr, '07:17');
      assert.equal(leg._liveChangeMins, 438 - 437);
    });

    test('falls back to the origin-delay projection when no calling point is found', () => {
      const ctx = loadApp();
      const leg = baseLeg();
      const boardA = { trainServices: [{ std: '07:03', etd: '07:08', subsequentCallingPoints: [] }] };
      ctx.applyConnectionOverlay([leg], '2026-07-02', boardA, null, 'TWY');
      assert.equal(leg._liveChangeArr, undefined);
      assert.equal(leg._liveChangeMins, -2); // same as the plain-projection test above
    });

    test('a cancelled change-station calling point marks leg-1 cancelled', () => {
      const ctx = loadApp();
      const leg = baseLeg();
      const boardA = {
        trainServices: [{
          std: '07:03', etd: 'On time',
          subsequentCallingPoints: [{ callingPoint: [{ crs: 'TWY', isCancelled: true }] }],
        }],
      };
      ctx.applyConnectionOverlay([leg], '2026-07-02', boardA, null, 'TWY');
      assert.equal(leg._cancelledLeg, 1);
    });
  });

  describe('final destination live arrival (_liveArr) via leg-2\'s calling points', () => {
    test('a delayed destination calling point on leg-2 sets _liveArr', () => {
      const ctx = loadApp();
      const leg = Object.assign(baseLeg(), { arr: '07:27' });
      const boardB = {
        trainServices: [{
          std: '07:18', etd: 'On time',
          subsequentCallingPoints: [{ callingPoint: [{ crs: 'HOT', et: '07:35' }] }],
        }],
      };
      ctx.applyConnectionOverlay([leg], '2026-07-02', null, boardB, 'TWY', 'HOT');
      assert.equal(leg._liveArr, '07:35');
    });

    test('a cancelled destination calling point on leg-2 marks leg-2 cancelled', () => {
      const ctx = loadApp();
      const leg = Object.assign(baseLeg(), { arr: '07:27' });
      const boardB = {
        trainServices: [{
          std: '07:18', etd: 'On time',
          subsequentCallingPoints: [{ callingPoint: [{ crs: 'HOT', isCancelled: true }] }],
        }],
      };
      ctx.applyConnectionOverlay([leg], '2026-07-02', null, boardB, 'TWY', 'HOT');
      assert.equal(leg._cancelledLeg, 2);
    });
  });
});

describe('formatting helpers', () => {
  test('countdownText()', () => {
    const ctx = loadApp();
    assert.equal(ctx.countdownText(0), 'Departing now');
    assert.equal(ctx.countdownText(-5), 'Departing now');
    assert.equal(ctx.countdownText(45), 'in 45s');
    assert.equal(ctx.countdownText(90), 'in 1m 30s');
    assert.equal(ctx.countdownText(60), 'in 1m 0s');
    assert.equal(ctx.countdownText(600), 'in 10 min');
  });

  test('durFmt()', () => {
    const ctx = loadApp();
    assert.equal(ctx.durFmt(null), '');
    assert.equal(ctx.durFmt(0), '');
    assert.equal(ctx.durFmt(24), '24 min');
    assert.equal(ctx.durFmt(60), '1 hr');
    assert.equal(ctx.durFmt(90), '1h 30m');
  });

  test('formatAge()', () => {
    const ctx = loadApp();
    assert.equal(ctx.formatAge(30 * 1000), 'just now');
    assert.equal(ctx.formatAge(5 * 60 * 1000), '5 min ago');
    assert.equal(ctx.formatAge(60 * 60 * 1000), '1 hr ago');
    assert.equal(ctx.formatAge(3 * 60 * 60 * 1000), '3 hr ago');
  });

  test('effDepM() prefers the live-adjusted departure when present', () => {
    const ctx = loadApp();
    assert.equal(ctx.effDepM({ depM: 400 }), 400);
    assert.equal(ctx.effDepM({ depM: 400, _liveDepM: 405 }), 405);
  });
});

describe('legCacheKey() — direct vs connection legs keyed differently for the live cache', () => {
  test('a direct leg is keyed by its uid', () => {
    const ctx = loadApp();
    assert.equal(ctx.legCacheKey({ uid: 'A1' }, false), 'A1');
  });

  test('a connection leg is keyed by both uids combined (no single uid identifies it)', () => {
    const ctx = loadApp();
    assert.equal(ctx.legCacheKey({ uid1: 'A1', uid2: 'B1' }, true), 'A1|B1');
  });
});

describe('setLiveStatus() — status bar reflects live-data state, including the missing-key case', () => {
  // Regression for a real bug: a visitor without a saved key (e.g. after
  // clearing site data) saw no live overlay and no visible explanation
  // anywhere — the status bar existed but wasn't flagged as actionable.
  test('the "off" (no key) state marks the status bar clickable', () => {
    const ctx = loadApp();
    ctx.setLiveStatus('off', 'Scheduled times only — tap ⚙ for live platforms & delays');
    assert.equal(ctx.__elements.get('status-bar').classList.contains('clickable'), true);
  });

  test('every other state leaves the status bar non-clickable', () => {
    const ctx = loadApp();
    for (const state of ['on', 'stale', 'error']) {
      ctx.setLiveStatus(state, 'text');
      assert.equal(ctx.__elements.get('status-bar').classList.contains('clickable'), false, `state=${state}`);
    }
  });

  test('sets the live-dot class and live-label text', () => {
    const ctx = loadApp();
    ctx.setLiveStatus('stale', 'Showing last known live data');
    assert.equal(ctx.__elements.get('live-dot').className, 'live-dot stale');
    assert.equal(ctx.__elements.get('live-label').textContent, 'Showing last known live data');
  });

  test('the "off" state clears the dot\'s state class and the header\'s live-* classes', () => {
    const ctx = loadApp();
    ctx.setLiveStatus('error', 'text'); // start from a non-off state
    ctx.setLiveStatus('off', 'Scheduled times');
    assert.equal(ctx.__elements.get('live-dot').className, 'live-dot');
    assert.equal(ctx.__elements.get('hdr').classList.contains('live-error'), false);
  });
});

describe('openSettings() and the status-bar click-to-settings shortcut', () => {
  test('openSettings() populates the key input and opens the settings overlay', () => {
    const ctx = loadApp();
    ctx.localStorage.setItem('darwinApiKey', 'my-key');
    ctx.openSettings();
    assert.equal(ctx.__elements.get('api-key-input').value, 'my-key');
    assert.equal(ctx.__elements.get('settings-overlay').classList.contains('open'), true);
  });

  test('clicking the status bar opens Settings only when no key is saved', () => {
    const ctx = loadApp();
    ctx.__elements.get('status-bar')._trigger('click');
    assert.equal(ctx.__elements.get('settings-overlay').classList.contains('open'), true);
  });

  test('clicking the status bar is a no-op when a key is already saved', () => {
    const ctx = loadApp();
    ctx.localStorage.setItem('darwinApiKey', 'my-key');
    ctx.__elements.get('status-bar')._trigger('click');
    // openSettings() never ran, so it never even touched settings-overlay.
    assert.equal(ctx.__elements.has('settings-overlay'), false);
  });
});

describe('synthesizeLiveLegs() — quick (session-only) routes built straight off a live board', () => {
  test('a matched, on-time service becomes a leg with zero delay and a confirmed platform', () => {
    const ctx = loadApp();
    const board = {
      trainServices: [{
        std: '07:03', etd: 'On time', platform: '3', operatorCode: 'GW',
        subsequentCallingPoints: [{ callingPoint: [{ crs: 'PAD', st: '07:47', et: 'On time' }] }],
      }],
    };
    const legs = ctx.synthesizeLiveLegs(board, 'PAD');
    assert.equal(legs.length, 1);
    const leg = legs[0];
    assert.equal(leg.dep, '07:03');
    assert.equal(leg.depM, 423);
    assert.equal(leg.arr, '07:47');
    assert.equal(leg.uid, null); // no RTT identity available from Darwin -> no deep link
    assert.equal(leg.toc, 'GW');
    assert.equal(leg._cancelled, false);
    assert.equal(leg._delayMins, 0);
    assert.equal(leg._liveDepM, 423);
    assert.equal(leg._liveArr, '07:47');
    // No booked platform to compare against -> confirmed, never "changed".
    assert.equal(leg._platformConfirmed, true);
    assert.equal(leg._platformChanged, false);
  });

  test('cancellation is detected via etd === "Cancelled", matching applyDirectOverlay\'s convention', () => {
    const ctx = loadApp();
    const board = {
      trainServices: [{
        std: '07:03', etd: 'Cancelled',
        subsequentCallingPoints: [{ callingPoint: [{ crs: 'PAD', st: '07:47' }] }],
      }],
    };
    assert.equal(ctx.synthesizeLiveLegs(board, 'PAD')[0]._cancelled, true);
  });

  test('a cancelled destination calling point also marks the leg cancelled', () => {
    const ctx = loadApp();
    const board = {
      trainServices: [{
        std: '07:03', etd: 'On time',
        subsequentCallingPoints: [{ callingPoint: [{ crs: 'PAD', st: '07:47', isCancelled: true }] }],
      }],
    };
    assert.equal(ctx.synthesizeLiveLegs(board, 'PAD')[0]._cancelled, true);
  });

  test('a delayed departure computes _delayMins/_liveDepM using the 3am-aware liveMinute', () => {
    const ctx = loadApp();
    const board = {
      trainServices: [{
        std: '23:50', etd: '00:10',
        subsequentCallingPoints: [{ callingPoint: [{ crs: 'PAD', st: '00:30' }] }],
      }],
    };
    const leg = ctx.synthesizeLiveLegs(board, 'PAD')[0];
    assert.equal(leg.depM, 1430); // 23:50
    assert.equal(leg._delayMins, 1450 - 1430); // 00:10 -> 1450 via the boundary offset
    assert.equal(leg._liveDepM, 1430 + 20);
  });

  test('a delayed destination calling point sets _liveArr to the estimate', () => {
    const ctx = loadApp();
    const board = {
      trainServices: [{
        std: '07:03', etd: 'On time',
        subsequentCallingPoints: [{ callingPoint: [{ crs: 'PAD', st: '07:47', et: '08:02' }] }],
      }],
    };
    assert.equal(ctx.synthesizeLiveLegs(board, 'PAD')[0]._liveArr, '08:02');
  });

  test('a service with no calling point at destCrs is skipped (board should already be filtered `to` destCrs)', () => {
    const ctx = loadApp();
    const board = { trainServices: [{ std: '07:03', etd: 'On time', subsequentCallingPoints: [] }] };
    assert.deepEqual(plain(ctx.synthesizeLiveLegs(board, 'PAD')), []);
  });

  test('a service with no std is skipped defensively', () => {
    const ctx = loadApp();
    const board = { trainServices: [{ etd: 'On time' }] };
    assert.deepEqual(plain(ctx.synthesizeLiveLegs(board, 'PAD')), []);
  });

  test('null/board-less input returns an empty array rather than throwing', () => {
    const ctx = loadApp();
    assert.deepEqual(plain(ctx.synthesizeLiveLegs(null, 'PAD')), []);
    assert.deepEqual(plain(ctx.synthesizeLiveLegs({}, 'PAD')), []);
  });
});

describe('mergeLiveOnlyBoard() — a failed board fetch must never blank the last-known board', () => {
  const route = { from: 'RDG', to: 'BRI' };
  const boardFor = (crs) => ({
    trainServices: [{ std: '07:00', etd: 'On time', subsequentCallingPoints: [{ callingPoint: [{ crs, st: '08:00' }] }] }],
  });

  test('both boards succeed -> both directions replaced', () => {
    const ctx = loadApp();
    const result = ctx.mergeLiveOnlyBoard(null, boardFor('BRI'), boardFor('RDG'), route);
    assert.equal(result.out.length, 1);
    assert.equal(result.ret.length, 1);
  });

  test('one board fails -> only that direction keeps its previous legs, the other still updates', () => {
    const ctx = loadApp();
    const existing = { out: [{ dep: 'stale-out' }], ret: [{ dep: 'stale-ret' }] };
    const result = ctx.mergeLiveOnlyBoard(existing, null, boardFor('RDG'), route);
    assert.deepEqual(result.out, existing.out); // failed fetch -> untouched, never blanked
    assert.equal(result.ret.length, 1); // succeeded fetch -> replaced with fresh legs
    assert.notEqual(result.ret[0].dep, 'stale-ret');
  });

  test('both boards fail -> both directions keep their previous legs entirely', () => {
    const ctx = loadApp();
    const existing = { out: [{ dep: 'stale-out' }], ret: [{ dep: 'stale-ret' }] };
    const result = ctx.mergeLiveOnlyBoard(existing, null, null, route);
    assert.deepEqual(plain(result), existing);
  });

  test('no existing board and both fetches fail -> empty arrays, not a crash', () => {
    const ctx = loadApp();
    assert.deepEqual(plain(ctx.mergeLiveOnlyBoard(null, null, null, route)), { out: [], ret: [] });
  });
});

describe('quick-route id/CRS helpers', () => {
  test('buildQuickRouteId prefixes with q- so it can never collide with a curated route id', () => {
    const ctx = loadApp();
    assert.equal(ctx.buildQuickRouteId('RDG', 'BRI'), 'q-rdg-bri');
  });

  test('parseQuickCrs handles bare codes and the "Name (CRS)" datalist form', () => {
    const ctx = loadApp();
    assert.equal(ctx.parseQuickCrs('RDG'), 'RDG');
    assert.equal(ctx.parseQuickCrs('Reading (RDG)'), 'RDG');
    assert.equal(ctx.parseQuickCrs('reading (rdg)'), 'RDG');
    assert.equal(ctx.parseQuickCrs('not a station'), '');
    assert.equal(ctx.parseQuickCrs(''), '');
  });
});

describe('quick-route sessionStorage (loadUserRoutes/saveUserRoutes/mergeUserRoutes)', () => {
  test('round-trips a saved list through sessionStorage', () => {
    const ctx = loadApp();
    const routes = [{ id: 'q-rdg-bri', name: 'Reading ↔ Bristol', from: 'RDG', to: 'BRI', change: null, liveOnly: true }];
    ctx.saveUserRoutes(routes);
    assert.deepEqual(plain(ctx.loadUserRoutes()), routes);
  });

  test('returns an empty array when nothing is stored', () => {
    const ctx = loadApp();
    assert.deepEqual(plain(ctx.loadUserRoutes()), []);
  });

  test('discards a malformed sessionStorage value rather than throwing', () => {
    const ctx = loadApp();
    ctx.sessionStorage.setItem('userRoutes', 'not json');
    assert.deepEqual(plain(ctx.loadUserRoutes()), []);
    ctx.sessionStorage.setItem('userRoutes', '{"not":"an array"}');
    assert.deepEqual(plain(ctx.loadUserRoutes()), []);
  });

  test('filters out entries missing id/from/to', () => {
    const ctx = loadApp();
    ctx.sessionStorage.setItem('userRoutes', JSON.stringify([
      { id: 'q-a-b', from: 'A', to: 'B' },
      { from: 'A', to: 'B' }, // no id
      { id: 'q-c-d', from: 'C' }, // no to
      null,
    ]));
    const loaded = ctx.loadUserRoutes();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'q-a-b');
  });

  test('mergeUserRoutes appends session routes AFTER curated ones, so ROUTES[0] stays curated', () => {
    const ctx = loadApp();
    ctx.saveUserRoutes([{ id: 'q-rdg-bri', from: 'RDG', to: 'BRI' }]);
    const curated = [{ id: 'rdg-pad', from: 'RDG', to: 'PAD' }];
    const merged = ctx.mergeUserRoutes(curated);
    assert.deepEqual(plain(merged).map((r) => r.id), ['rdg-pad', 'q-rdg-bri']);
  });
});
