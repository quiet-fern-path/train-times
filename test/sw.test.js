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

describe('fetch handler — an unchanged revalidation must not rewrite the cache entry', () => {
  // data/schedule.json is ~15MB. The handler used to cache.put() on every
  // background revalidation, including the case where responseChanged() had
  // just established the response was byte-for-byte what was already stored
  // — so every check cost a 15MB Cache Storage write to store what was
  // already there. That write, not the network, was the real cost of
  // checking often: GitHub Pages sends an ETag, so the network side of a
  // revalidation is a 304 with an empty body (measured).
  const URL_ = 'https://example.invalid/data/schedule.json';

  function drive(ctx, cachedHeaders, networkHeaders) {
    const { makeResponse, seedCache, dispatchFetch } = ctx.__sw;
    seedCache(URL_, makeResponse({ headers: cachedHeaders }));
    ctx.fetch = () => Promise.resolve(makeResponse({ headers: networkHeaders }));
    return dispatchFetch(URL_);
  }

  test('identical etag -> no put, no notify', async () => {
    const ctx = loadSw();
    await drive(ctx, { etag: '"abc"' }, { etag: '"abc"' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ctx.__sw.putCalls, [], 're-stored a cache entry that had not changed');
    assert.deepEqual(ctx.__sw.posted, []);
  });

  test('changed etag -> still puts and still notifies', async () => {
    const ctx = loadSw();
    await drive(ctx, { etag: '"abc"' }, { etag: '"def"' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ctx.__sw.putCalls, [URL_]);
    assert.deepEqual(plain(ctx.__sw.posted), [{ type: 'content-updated', url: URL_ }]);
  });

  test('nothing cached yet -> puts, so offline still works on a first visit', async () => {
    const ctx = loadSw();
    ctx.fetch = () => Promise.resolve(ctx.__sw.makeResponse({ headers: { etag: '"abc"' } }));
    await ctx.__sw.dispatchFetch(URL_);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ctx.__sw.putCalls, [URL_]);
    assert.deepEqual(ctx.__sw.posted, [], 'a first fetch is not an "update" to tell anyone about');
  });

  test('no usable validator -> assumed changed, so a real update is never missed', async () => {
    const ctx = loadSw();
    await drive(ctx, {}, {});
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ctx.__sw.putCalls, [URL_]);
  });
});
