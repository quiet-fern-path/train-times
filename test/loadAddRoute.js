'use strict';

// Loads add-route.js into a fresh Node vm context against a minimal stub, so
// its pure helpers (buildRouteId, mergeRoute, removeRoute/readdRoute, the
// GitHub commit builders, …) can be unit tested without a DOM — same approach
// as test/loadApp.js (no jsdom, per CLAUDE.md's no-build-step preference).
//
// add-route.js is a classic (non-module) script, so every top-level
// `function` declaration attaches to the vm context's global object and is
// retrievable from the returned context. It guards its DOM bootstrap on
// `typeof document !== 'undefined'`; this harness deliberately provides NO
// `document`, so initAddRoute() never runs and only the pure logic loads.
//
// `fetch` starts as a rejecting stub; tests overwrite `context.fetch` with a
// mock before calling the GitHub commit helpers (the helpers resolve `fetch`
// as a free global at call time, so a later assignment is seen).
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

function loadAddRoute() {
  const sandbox = {
    localStorage: makeStorage(),
    fetch: () => Promise.reject(new Error('test did not set context.fetch')),
    // Node globals the module's base64/JSON helpers need (not auto-present in
    // a vm context). No `atob`, so decodeBase64Utf8 takes its Buffer path.
    Buffer,
    TextDecoder,
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'add-route.js'), 'utf8');
  new vm.Script(src, { filename: 'add-route.js' }).runInContext(context);
  return context;
}

module.exports = { loadAddRoute };
