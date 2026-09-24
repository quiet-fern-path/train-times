'use strict';

// Loads sw.js into a fresh vm context against a minimal `self` stub (the
// global object inside a service worker), same technique as loadApp.js —
// see that file's header comment for why this works without jsdom.
//
// The pure logic (responseChanged, notifyClientsOfUpdate) is read back and
// called directly. The fetch handler is also drivable, via a fake Cache that
// records its put() calls (`ctx.__sw`) — enough to test which *decisions*
// the handler makes (does it re-store a 15MB entry that hasn't changed? does
// it notify?), which is where its bugs have actually been. It is NOT a real
// browser: request/response bodies are inert stubs and nothing here proves
// anything about real fetch interception, HTTP-cache interaction or
// revalidation timing (see CLAUDE.md's testing section).
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// A Response-shaped stub carrying just what sw.js reads off one: `ok`, and
// the three headers responseChanged() compares. `clone()` returns the same
// object — sw.js only clones to hand a second copy to cache.put(), and no
// body is ever consumed here.
function makeResponse({ ok = true, headers = {}, body = null } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const resp = {
    ok,
    body,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    clone() { return resp; },
  };
  return resp;
}

function loadSw({ origin = 'https://example.invalid' } = {}) {
  const listeners = {};
  // One fake Cache behind caches.open(), recording every put so a test can
  // assert on whether the handler wrote — the question this stub exists for.
  const store = new Map();
  const putCalls = [];
  const cache = {
    match: (req) => Promise.resolve(store.get(req.url)),
    put: (req, resp) => { putCalls.push(req.url); store.set(req.url, resp); return Promise.resolve(); },
  };
  const posted = [];
  const sandbox = {
    self: {
      addEventListener(type, handler) {
        (listeners[type] = listeners[type] || []).push(handler);
      },
      skipWaiting() {},
      location: { origin },
      clients: {
        claim() {},
        matchAll() {
          return Promise.resolve([{ postMessage: (m) => posted.push(m) }]);
        },
      },
    },
    caches: { keys: () => Promise.resolve([]), open: () => Promise.resolve(cache) },
    fetch: () => Promise.reject(new Error('loadSw: set ctx.fetch before driving the fetch handler')),
    URL,
    console,
    Promise,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  new vm.Script(src, { filename: 'sw.js' }).runInContext(context);

  // Test-only hooks (not service-worker APIs).
  context.__sw = {
    putCalls,
    posted,
    makeResponse,
    seedCache: (url, resp) => store.set(url, resp),
    // Drives the registered fetch listener with a GET for `url` and returns
    // whatever it passed to respondWith (or undefined if it declined to
    // handle the request at all).
    dispatchFetch: (url) => {
      let responded;
      const event = {
        request: { url, method: 'GET' },
        respondWith: (p) => { responded = p; },
      };
      (listeners.fetch || []).forEach((h) => h(event));
      return responded;
    },
  };
  return context;
}

module.exports = { loadSw, makeResponse };
