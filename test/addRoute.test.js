'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAddRoute } = require('./loadAddRoute');

// Round-trip through JSON so objects a vm-context function returns compare
// under node:assert/strict (which checks prototype identity) — see CLAUDE.md.
const plain = (x) => JSON.parse(JSON.stringify(x));

// A minimal Response-shaped stub for the mocked GitHub API.
function resp(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

// ── Pure helpers ────────────────────────────────────────────────────────────

test('buildRouteId lowercases and joins the CRS pair', () => {
  const ctx = loadAddRoute();
  assert.equal(ctx.buildRouteId('RDG', 'BRI'), 'rdg-bri');
});

test('buildRouteName uses display names with a CRS fallback', () => {
  const ctx = loadAddRoute();
  const names = { RDG: 'Reading', BRI: 'Bristol Temple Meads' };
  assert.equal(ctx.buildRouteName('RDG', 'BRI', names), 'Reading ↔ Bristol Temple Meads');
  assert.equal(ctx.buildRouteName('RDG', 'ZZZ', names), 'Reading ↔ ZZZ');
});

test('parseCrs handles bare codes and the "Name (CRS)" datalist form', () => {
  const ctx = loadAddRoute();
  assert.equal(ctx.parseCrs('RDG'), 'RDG');
  assert.equal(ctx.parseCrs('Reading (RDG)'), 'RDG');
  assert.equal(ctx.parseCrs('reading (rdg)'), 'RDG');
  assert.equal(ctx.parseCrs('not a station'), '');
  assert.equal(ctx.parseCrs(''), '');
});

test('routeExists and reversePairExists', () => {
  const ctx = loadAddRoute();
  const routes = [{ id: 'rdg-bri', from: 'RDG', to: 'BRI' }];
  assert.equal(ctx.routeExists(routes, 'rdg-bri'), true);
  assert.equal(ctx.routeExists(routes, 'nope'), false);
  assert.equal(ctx.reversePairExists(routes, 'BRI', 'RDG'), true);
  assert.equal(ctx.reversePairExists(routes, 'RDG', 'BRI'), false);
});

test('mergeRoute appends without mutating the input', () => {
  const ctx = loadAddRoute();
  const routes = [{ id: 'a' }];
  const out = ctx.mergeRoute(routes, { id: 'b' });
  assert.deepEqual(plain(out), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(routes.length, 1);
});

test('buildRoute builds a direct route (no minConnectionMins key)', () => {
  const ctx = loadAddRoute();
  const names = { RDG: 'Reading', BRI: 'Bristol Temple Meads' };
  const route = ctx.buildRoute('RDG', 'BRI', names);
  assert.deepEqual(plain(route), {
    id: 'rdg-bri', name: 'Reading ↔ Bristol Temple Meads', from: 'RDG', to: 'BRI', change: null,
  });
  assert.ok(!('minConnectionMins' in route));
});

test('buildRoute builds a connection route with the given minConnectionMins', () => {
  const ctx = loadAddRoute();
  const names = { RDG: 'Reading', HOT: 'Henley-On-Thames', TWY: 'Twyford' };
  const route = ctx.buildRoute('RDG', 'HOT', names, { change: 'TWY', minConnectionMins: 4 });
  assert.deepEqual(plain(route), {
    id: 'rdg-hot', name: 'Reading ↔ Henley-On-Thames', from: 'RDG', to: 'HOT',
    change: 'TWY', minConnectionMins: 4,
  });
});

test('buildRoute defaults minConnectionMins to 5 when a connection omits it', () => {
  const ctx = loadAddRoute();
  const route = ctx.buildRoute('RDG', 'HOT', {}, { change: 'TWY' });
  assert.equal(route.minConnectionMins, 5);
});

// ── moveRoute (reordering) ────────────────────────────────────────────────

test('moveRoute swaps a route with its next-lower neighbour (delta -1)', () => {
  const ctx = loadAddRoute();
  const routes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = ctx.moveRoute(routes, 'b', -1);
  assert.deepEqual(plain(out).map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(routes.map((r) => r.id), ['a', 'b', 'c']); // unmutated
});

test('moveRoute swaps a route with its next-higher neighbour (delta +1)', () => {
  const ctx = loadAddRoute();
  const routes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = ctx.moveRoute(routes, 'b', 1);
  assert.deepEqual(plain(out).map((r) => r.id), ['a', 'c', 'b']);
});

test('moveRoute is a no-op past either boundary', () => {
  const ctx = loadAddRoute();
  const routes = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(plain(ctx.moveRoute(routes, 'a', -1)).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(plain(ctx.moveRoute(routes, 'b', 1)).map((r) => r.id), ['a', 'b']);
});

test('moveRoute is a no-op for an unknown id', () => {
  const ctx = loadAddRoute();
  const routes = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(plain(ctx.moveRoute(routes, 'nope', 1)).map((r) => r.id), ['a', 'b']);
});

test('mergeStations adds only missing names, never overwriting', () => {
  const ctx = loadAddRoute();
  const st = { RDG: 'Reading' };
  const out = ctx.mergeStations(st, { RDG: 'WRONG', BRI: 'Bristol Temple Meads' });
  assert.deepEqual(plain(out), { RDG: 'Reading', BRI: 'Bristol Temple Meads' });
  assert.deepEqual(plain(st), { RDG: 'Reading' }); // unmutated
});

// ── Remove / re-add (must round-trip connection config — the Henley case) ────

test('removeRoute moves a route from active to parked', () => {
  const ctx = loadAddRoute();
  const henley = { id: 'rdg-hoh', from: 'RDG', to: 'HOT', change: 'TWY', minConnectionMins: 3 };
  const routes = [{ id: 'rdg-bri', from: 'RDG', to: 'BRI', change: null }, henley];
  const res = ctx.removeRoute(routes, [], 'rdg-hoh');
  assert.deepEqual(plain(res.routes), [{ id: 'rdg-bri', from: 'RDG', to: 'BRI', change: null }]);
  assert.deepEqual(plain(res.parked), [henley]);
});

test('readdRoute restores a parked connection route byte-for-byte', () => {
  const ctx = loadAddRoute();
  const henley = { id: 'rdg-hoh', from: 'RDG', to: 'HOT', change: 'TWY', minConnectionMins: 3 };
  const res = ctx.readdRoute([{ id: 'rdg-bri' }], [henley], 'rdg-hoh');
  assert.deepEqual(plain(res.parked), []);
  assert.deepEqual(plain(res.routes.find((r) => r.id === 'rdg-hoh')), henley);
});

test('remove then re-add restores the Henley config exactly', () => {
  const ctx = loadAddRoute();
  const henley = { id: 'rdg-hoh', from: 'RDG', to: 'HOT', change: 'TWY', minConnectionMins: 3 };
  const removed = ctx.removeRoute([henley], [], 'rdg-hoh');
  const readded = ctx.readdRoute(removed.routes, removed.parked, 'rdg-hoh');
  assert.deepEqual(plain(readded.routes), [henley]);
  assert.deepEqual(plain(readded.parked), []);
});

test('readdRoute is a no-op-safe when the id is already active', () => {
  const ctx = loadAddRoute();
  const henley = { id: 'rdg-hoh', change: 'TWY' };
  const res = ctx.readdRoute([henley], [henley], 'rdg-hoh');
  assert.equal(res.routes.filter((r) => r.id === 'rdg-hoh').length, 1);
});

// ── GitHub commit builders ───────────────────────────────────────────────────

test('ghApiUrl targets the configured repo', () => {
  const ctx = loadAddRoute();
  assert.equal(
    ctx.ghApiUrl('/git/ref/heads/main'),
    'https://api.github.com/repos/quiet-fern-path/train-times/git/ref/heads/main'
  );
});

test('buildTreeItems builds inline-content blob entries', () => {
  const ctx = loadAddRoute();
  const items = ctx.buildTreeItems([{ path: 'routes.json', content: '[]\n' }]);
  assert.deepEqual(plain(items), [
    { path: 'routes.json', mode: '100644', type: 'blob', content: '[]\n' },
  ]);
});

test('toJsonFile pretty-prints with a trailing newline', () => {
  const ctx = loadAddRoute();
  assert.equal(ctx.toJsonFile([{ id: 'a' }]), '[\n  {\n    "id": "a"\n  }\n]\n');
});

test('decodeBase64Utf8 decodes UTF-8 JSON', () => {
  const ctx = loadAddRoute();
  assert.equal(ctx.decodeBase64Utf8(b64({ RDG: 'Reading' })), '{"RDG":"Reading"}');
});

// ── ghCommitFiles: correct Git Data API sequence + payloads ──────────────────

test('ghCommitFiles issues the ref→tree→commit→update sequence with a single commit', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');

  const calls = [];
  ctx.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body, headers: opts.headers });
    if (url.endsWith('/git/ref/heads/main') && method === 'GET') return resp({ object: { sha: 'PARENT' } });
    if (url.endsWith('/git/commits/PARENT') && method === 'GET') return resp({ tree: { sha: 'BASETREE' } });
    if (url.endsWith('/git/trees') && method === 'POST') return resp({ sha: 'NEWTREE' });
    if (url.endsWith('/git/commits') && method === 'POST') return resp({ sha: 'NEWCOMMIT' });
    if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') return resp({});
    throw new Error('unexpected ' + method + ' ' + url);
  };

  const sha = await ctx.ghCommitFiles('a message', [{ path: 'routes.json', content: '[]\n' }]);
  assert.equal(sha, 'NEWCOMMIT');

  // Auth header carried the stored token.
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');

  const treeCall = calls.find((c) => c.url.endsWith('/git/trees'));
  const treeBody = JSON.parse(treeCall.body);
  assert.equal(treeBody.base_tree, 'BASETREE');
  assert.deepEqual(plain(treeBody.tree), [
    { path: 'routes.json', mode: '100644', type: 'blob', content: '[]\n' },
  ]);

  const commitCall = calls.find((c) => c.url.endsWith('/git/commits') && c.method === 'POST');
  const commitBody = JSON.parse(commitCall.body);
  assert.equal(commitBody.message, 'a message');
  assert.equal(commitBody.tree, 'NEWTREE');
  assert.deepEqual(plain(commitBody.parents), ['PARENT']);

  const patchCall = calls.find((c) => c.method === 'PATCH');
  assert.equal(JSON.parse(patchCall.body).sha, 'NEWCOMMIT');
});

test('ghFetch throws with status + body on a non-ok response', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');
  ctx.fetch = async () => resp({ message: 'Bad credentials' }, 401);
  await assert.rejects(
    ctx.ghCommitFiles('m', [{ path: 'routes.json', content: '[]\n' }]),
    /GitHub API 401/
  );
});

// ── commitAddRoute end-to-end (mocked GitHub) ────────────────────────────────

test('commitAddRoute commits routes.json + stations.json with the new route', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');

  const routesJson = [{ id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null }];
  const stationsJson = { RDG: 'Reading', PAD: 'London Paddington' };
  let treeBody = null;

  ctx.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.includes('/contents/routes.json')) return resp({ content: b64(routesJson) });
    if (url.includes('/contents/stations.json')) return resp({ content: b64(stationsJson) });
    if (url.endsWith('/git/ref/heads/main')) return resp({ object: { sha: 'P' } });
    if (url.endsWith('/git/commits/P') && method === 'GET') return resp({ tree: { sha: 'BT' } });
    if (url.endsWith('/git/trees')) { treeBody = JSON.parse(opts.body); return resp({ sha: 'NT' }); }
    if (url.endsWith('/git/commits') && method === 'POST') return resp({ sha: 'NC' });
    if (url.endsWith('/git/refs/heads/main')) return resp({});
    throw new Error('unexpected ' + method + ' ' + url);
  };

  const res = await ctx.commitAddRoute('RDG', 'BRI', { RDG: 'Reading', BRI: 'Bristol Temple Meads' });
  assert.equal(res.id, 'rdg-bri');
  assert.equal(res.commitSha, 'NC');

  const files = Object.fromEntries(treeBody.tree.map((t) => [t.path, t.content]));
  const committedRoutes = JSON.parse(files['routes.json']);
  assert.ok(committedRoutes.some((r) => r.id === 'rdg-bri' && r.to === 'BRI' && r.change === null));
  // Existing route preserved.
  assert.ok(committedRoutes.some((r) => r.id === 'rdg-pad'));
  // New station name added; existing one preserved.
  assert.equal(JSON.parse(files['stations.json']).BRI, 'Bristol Temple Meads');
  assert.equal(JSON.parse(files['stations.json']).RDG, 'Reading');
});

test('commitAddRoute commits a connection route with the change station name added', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');

  const routesJson = [{ id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null }];
  const stationsJson = { RDG: 'Reading', PAD: 'London Paddington' };
  let treeBody = null;

  ctx.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.includes('/contents/routes.json')) return resp({ content: b64(routesJson) });
    if (url.includes('/contents/stations.json')) return resp({ content: b64(stationsJson) });
    if (url.endsWith('/git/ref/heads/main')) return resp({ object: { sha: 'P' } });
    if (url.endsWith('/git/commits/P') && method === 'GET') return resp({ tree: { sha: 'BT' } });
    if (url.endsWith('/git/trees')) { treeBody = JSON.parse(opts.body); return resp({ sha: 'NT' }); }
    if (url.endsWith('/git/commits') && method === 'POST') return resp({ sha: 'NC' });
    if (url.endsWith('/git/refs/heads/main')) return resp({});
    throw new Error('unexpected ' + method + ' ' + url);
  };

  const names = { RDG: 'Reading', HOT: 'Henley-On-Thames', TWY: 'Twyford' };
  const res = await ctx.commitAddRoute('RDG', 'HOT', names, { change: 'TWY', minConnectionMins: 4 });
  assert.equal(res.id, 'rdg-hot');

  const files = Object.fromEntries(treeBody.tree.map((t) => [t.path, t.content]));
  const committedRoutes = JSON.parse(files['routes.json']);
  const added = committedRoutes.find((r) => r.id === 'rdg-hot');
  assert.deepEqual(added, {
    id: 'rdg-hot', name: 'Reading ↔ Henley-On-Thames', from: 'RDG', to: 'HOT',
    change: 'TWY', minConnectionMins: 4,
  });
  // Change station's display name was added alongside from/to.
  assert.equal(JSON.parse(files['stations.json']).TWY, 'Twyford');
});

test('commitAddRoute rejects a duplicate route id', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');
  const routesJson = [{ id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null }];
  ctx.fetch = async (url) => {
    if (url.includes('/contents/routes.json')) return resp({ content: b64(routesJson) });
    throw new Error('should not reach commit for a duplicate');
  };
  await assert.rejects(
    ctx.commitAddRoute('RDG', 'PAD', { RDG: 'Reading', PAD: 'London Paddington' }),
    /already exists/
  );
});

// ── commitMoveRoute (reorder) ────────────────────────────────────────────────

test('commitMoveRoute reads fresh routes.json, applies the swap, commits only routes.json', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');

  const routesJson = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let treeBody = null;
  ctx.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.includes('/contents/routes.json')) return resp({ content: b64(routesJson) });
    if (url.endsWith('/git/ref/heads/main')) return resp({ object: { sha: 'P' } });
    if (url.endsWith('/git/commits/P') && method === 'GET') return resp({ tree: { sha: 'BT' } });
    if (url.endsWith('/git/trees')) { treeBody = JSON.parse(opts.body); return resp({ sha: 'NT' }); }
    if (url.endsWith('/git/commits') && method === 'POST') return resp({ sha: 'NC' });
    if (url.endsWith('/git/refs/heads/main')) return resp({});
    throw new Error('unexpected ' + method + ' ' + url);
  };

  await ctx.commitMoveRoute('b', -1);

  assert.equal(treeBody.tree.length, 1);
  assert.equal(treeBody.tree[0].path, 'routes.json');
  const committed = JSON.parse(treeBody.tree[0].content);
  assert.deepEqual(committed.map((r) => r.id), ['b', 'a', 'c']);
});
