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
