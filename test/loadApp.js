'use strict';

// Loads app.js into a fresh Node vm context against a minimal, hand-rolled
// browser-shape stub (no jsdom dependency — see CLAUDE.md's "no build
// step" preference), so its pure logic (overtakers, applyDirectOverlay,
// derivePlatformState, the 3am day-boundary helpers, etc.) can be unit
// tested directly.
//
// app.js is a classic (non-module) script — same as how index.html loads
// it via <script src="app.js">. Every top-level `function name() {}`
// declaration in it therefore attaches to the vm context's global object,
// exactly like it attaches to `window` in a real browser, and is
// retrievable from the returned context. Top-level `let`/`const` bindings
// (ROUTES, SCHEDULE, activeRouteId, etc.) do NOT attach to the global
// object — they're internal render/init state, not what these tests are
// after.
//
// `now`, if given, fixes `Date`/`Date.now()` inside the context, since
// several helpers (todayStr, nowM, secsUntil) call `new Date()` directly
// with no way to inject a clock — needed to deterministically test the
// 03:00 timetable-day-boundary logic that CLAUDE.md flags as historically
// fragile.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeElement() {
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0 }; },
    setAttribute() {},
    getAttribute() { return null; },
    offsetHeight: 0,
  };
}

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

function loadApp({ now } = {}) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0 && now !== undefined) {
        super(now);
      } else {
        super(...args);
      }
    }
    static now() {
      return now !== undefined ? new RealDate(now).getTime() : RealDate.now();
    }
  }

  const sandbox = {
    document: {
      getElementById: () => makeElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { style: { setProperty() {}, getPropertyValue() { return ''; } } },
      addEventListener() {},
      createElement: () => makeElement(),
    },
    navigator: { onLine: true },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: { hash: '', href: 'https://example.invalid/train-times/' },
    history: { replaceState() {} },
    fetch: () => Promise.reject(new Error('no network in tests')),
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    scrollY: 0,
    scrollTo() {},
    addEventListener() {},
    console,
    URL,
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date: now !== undefined ? FixedDate : RealDate,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const script = new vm.Script(src, { filename: 'app.js' });
  try {
    script.runInContext(context);
  } catch (e) {
    // Defensive only: every top-level `function` declaration in app.js
    // (which is what these tests call) is already bound on the context by
    // the time any statement runs — hoisting happens before execution
    // starts, regardless of where a later statement might throw against
    // this minimal stub.
  }
  return context;
}

module.exports = { loadApp };
