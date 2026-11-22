'use strict';

// RTT links for quick (live-only) routes: an exact deep link when a curated
// route's schedule.json has the same train, otherwise an RTT station search.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadApp } = require('./loadApp.js');

const DATE = '2026-11-22';
const quick = { id: 'q-rdg-pad', from: 'RDG', to: 'PAD', liveOnly: true };
const qLeg = (over) => ({ date: DATE, serviceDate: DATE, uid: null, toc: 'GW', dep: '10:13', depM: 613, arrM: 640, ...over });

function setUp(ctx, routes, schedule) {
  vm.runInContext(`ROUTES = ${JSON.stringify(routes)}; SCHEDULE = ${JSON.stringify(schedule)};`, ctx);
}

describe('rttSearchUrl()', () => {
  const ctx = loadApp();

  test('builds origin → destination search at the booked HHMM', () => {
    assert.equal(ctx.rttSearchUrl('RDG', 'BRI', DATE, 613),
      'https://www.realtimetrains.co.uk/search/detailed/gb-nr:RDG/to/gb-nr:BRI/2026-11-22/1013');
  });

  test('a 00:00–02:59 departure uses the next calendar date, not the 3am timetable day', () => {
    assert.equal(ctx.rttSearchUrl('RDG', 'PAD', DATE, 1440 + 30),
      'https://www.realtimetrains.co.uk/search/detailed/gb-nr:RDG/to/gb-nr:PAD/2026-11-23/0030');
  });

  test('rolls month and year over', () => {
    assert.match(ctx.rttSearchUrl('RDG', 'PAD', '2026-12-31', 1500), /\/2027-01-01\/0100$/);
  });
});

describe('rttLinkHtml() — quick routes', () => {
  test('no curated match → "Find on RTT" search link, direction-aware', () => {
    const ctx = loadApp();
    setUp(ctx, [quick], { routes: {} });
    const out = ctx.rttLinkHtml(qLeg(), quick, 'out');
    assert.match(out, /Find on RTT/);
    assert.match(out, /gb-nr:RDG\/to\/gb-nr:PAD\/2026-11-22\/1013/);
    const ret = ctx.rttLinkHtml(qLeg(), quick, 'ret');
    assert.match(ret, /gb-nr:PAD\/to\/gb-nr:RDG\//);
  });

  test('searches by booked time even when the train is running late', () => {
    const ctx = loadApp();
    setUp(ctx, [quick], { routes: {} });
    const html = ctx.rttLinkHtml(qLeg({ _liveDepM: 625, _liveDep: '10:25' }), quick, 'out');
    assert.match(html, /\/1013"/);
  });

  test('a curated route on the same pair supplies the exact deep link', () => {
    const ctx = loadApp();
    const curated = { id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null };
    setUp(ctx, [curated, quick], { routes: { 'rdg-pad': {
      out: [{ date: DATE, serviceDate: DATE, uid: 'C12345', toc: 'GW', depM: 613, arrM: 640 }],
      ret: [],
    } } });
    const html = ctx.rttLinkHtml(qLeg(), quick, 'out');
    assert.match(html, /service\/gb-nr:C12345\/2026-11-22\/detailed/);
    assert.match(html, /View on RTT/);
  });

  test('a curated route in the reverse direction is matched via its ret legs', () => {
    const ctx = loadApp();
    const curated = { id: 'pad-rdg', from: 'PAD', to: 'RDG', change: null };
    setUp(ctx, [curated, quick], { routes: { 'pad-rdg': {
      out: [],
      ret: [{ date: DATE, serviceDate: DATE, uid: 'P99999', toc: 'GW', depM: 613, arrM: 640 }],
    } } });
    assert.match(ctx.rttLinkHtml(qLeg(), quick, 'out'), /gb-nr:P99999\//);
  });

  test('same-minute trains are split by TOC, then by arrival', () => {
    const ctx = loadApp();
    const curated = { id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null };
    setUp(ctx, [curated, quick], { routes: { 'rdg-pad': { ret: [], out: [
      { date: DATE, uid: 'XR0001', toc: 'XR', depM: 613, arrM: 680 },
      { date: DATE, uid: 'FAST01', toc: 'GW', depM: 613, arrM: 640 },
      { date: DATE, uid: 'SLOW01', toc: 'GW', depM: 613, arrM: 665 },
    ] } } });
    assert.match(ctx.rttLinkHtml(qLeg({ arrM: 641 }), quick, 'out'), /FAST01/);
    assert.match(ctx.rttLinkHtml(qLeg({ arrM: 666 }), quick, 'out'), /SLOW01/);
    assert.match(ctx.rttLinkHtml(qLeg({ toc: 'XR', arrM: 680 }), quick, 'out'), /XR0001/);
  });

  test('an unresolvable tie falls back to search rather than guess a deep link', () => {
    const ctx = loadApp();
    const curated = { id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null };
    setUp(ctx, [curated, quick], { routes: { 'rdg-pad': { ret: [], out: [
      { date: DATE, uid: 'A', toc: 'GW', depM: 613, arrM: 640 },
      { date: DATE, uid: 'B', toc: 'GW', depM: 613, arrM: 640 },
    ] } } });
    assert.match(ctx.rttLinkHtml(qLeg(), quick, 'out'), /Find on RTT/);
  });

  test('ignores connection routes and other dates', () => {
    const ctx = loadApp();
    const conn = { id: 'rdg-pad-c', from: 'RDG', to: 'PAD', change: 'TWY' };
    const curated = { id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null };
    setUp(ctx, [conn, curated, quick], { routes: {
      'rdg-pad-c': { out: [{ date: DATE, uid: 'CONN', depM: 613 }], ret: [] },
      'rdg-pad': { out: [{ date: '2026-11-23', uid: 'TMRW', depM: 613 }], ret: [] },
    } });
    assert.match(ctx.rttLinkHtml(qLeg(), quick, 'out'), /Find on RTT/);
  });

  test('a curated leg keeps its own deep link unchanged', () => {
    const ctx = loadApp();
    const curated = { id: 'rdg-pad', from: 'RDG', to: 'PAD' };
    const html = ctx.rttLinkHtml({ uid: 'C1', date: DATE, serviceDate: '2026-11-21', depM: 613 }, curated, 'out');
    assert.match(html, /service\/gb-nr:C1\/2026-11-21\/detailed/);
  });

  test('a curated leg with no uid still gets no link', () => {
    const ctx = loadApp();
    assert.equal(ctx.rttLinkHtml({ uid: null, date: DATE, depM: 613 }, { id: 'x', from: 'RDG', to: 'PAD' }, 'out'), '');
  });
});
