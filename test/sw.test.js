'use strict';

// Run with: node --test test/
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadSw } = require('./loadSw.js');

// See test/app.test.js for why: objects constructed inside the vm context
// have a different Object.prototype than this file's realm, which trips up
// assert/strict's prototype-checking deepEqual on otherwise-identical data.
const plain = (v) => JSON.parse(JSON.stringify(v));

function mockResponse(headers) {
  return { headers: { get: (k) => (headers[k.toLowerCase()] ?? null) } };
}

describe('responseChanged() — cheap header-only change detection', () => {
  // Deliberately header-based, never a body diff: data/schedule.json is
  // tens of MB, and a body diff on every background stale-while-revalidate
  // refresh would be real, needless cost (see CLAUDE.md's caching section).

  test('same etag -> unchanged', () => {
    const ctx = loadSw();
    const a = mockResponse({ etag: '"abc"' });
    const b = mockResponse({ etag: '"abc"' });
    assert.equal(ctx.responseChanged(a, b), false);
  });

  test('different etag -> changed', () => {
    const ctx = loadSw();
    const a = mockResponse({ etag: '"abc"' });
    const b = mockResponse({ etag: '"def"' });
    assert.equal(ctx.responseChanged(a, b), true);
  });

  test('etag takes priority even when content-length happens to match', () => {
    const ctx = loadSw();
    const a = mockResponse({ etag: '"abc"', 'content-length': '100' });
    const b = mockResponse({ etag: '"def"', 'content-length': '100' });
    assert.equal(ctx.responseChanged(a, b), true);
  });

  test('falls back to last-modified when no etag on either response', () => {
    const ctx = loadSw();
    const same = 'Thu, 02 Jul 2026 08:16:56 GMT';
    const a = mockResponse({ 'last-modified': same });
    const b = mockResponse({ 'last-modified': same });
    assert.equal(ctx.responseChanged(a, b), false);

    const c = mockResponse({ 'last-modified': same });
    const d = mockResponse({ 'last-modified': 'Thu, 02 Jul 2026 09:00:00 GMT' });
    assert.equal(ctx.responseChanged(c, d), true);
  });

  test('falls back to content-length when neither etag nor last-modified present', () => {
    const ctx = loadSw();
    assert.equal(ctx.responseChanged(mockResponse({ 'content-length': '100' }), mockResponse({ 'content-length': '100' })), false);
    assert.equal(ctx.responseChanged(mockResponse({ 'content-length': '100' }), mockResponse({ 'content-length': '200' })), true);
  });

  test('no usable signal at all -> assume changed (safe default: a spurious re-render beats a missed update)', () => {
    const ctx = loadSw();
    assert.equal(ctx.responseChanged(mockResponse({}), mockResponse({})), true);
  });
});

describe('notifyClientsOfUpdate()', () => {
  test('posts a content-updated message with the URL to every open client', async () => {
    const ctx = loadSw();
    const posted = [];
    ctx.self.clients.matchAll = () => Promise.resolve([
      { postMessage: (msg) => posted.push(msg) },
      { postMessage: (msg) => posted.push(msg) },
    ]);
    ctx.notifyClientsOfUpdate('https://example.invalid/train-times/data/schedule.json');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(posted.length, 2);
    for (const msg of posted) {
      assert.deepEqual(plain(msg), { type: 'content-updated', url: 'https://example.invalid/train-times/data/schedule.json' });
    }
  });
});
