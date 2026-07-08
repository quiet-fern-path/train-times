'use strict';

// Loads sw.js into a fresh vm context against a minimal `self` stub (the
// global object inside a service worker), same technique as loadApp.js —
// see that file's header comment for why this works without jsdom. Only
// pure, testable logic (responseChanged, notifyClientsOfUpdate) is
// exercised this way; the actual fetch-interception behavior needs a real
// browser (see CLAUDE.md's testing section).
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadSw() {
  const listeners = {};
  const sandbox = {
    self: {
      addEventListener(type, handler) {
        (listeners[type] = listeners[type] || []).push(handler);
      },
      skipWaiting() {},
      clients: {
        claim() {},
        matchAll() { return Promise.resolve([]); },
      },
    },
    caches: { keys: () => Promise.resolve([]), open: () => Promise.resolve({}) },
    console,
    Promise,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  new vm.Script(src, { filename: 'sw.js' }).runInContext(context);
  return context;
}

module.exports = { loadSw };
