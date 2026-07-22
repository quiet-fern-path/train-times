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

// ── Staging (pure) ────────────────────────────────────────────────────────────

function baseStage(ctx, routes, stations, parked) {
  return ctx.rebaseStage(routes, stations || {}, parked || []);
}

test('rebaseStage anchors base === working copy with an empty log', () => {
  const ctx = loadAddRoute();
  const routes = [{ id: 'a' }];
  const stage = ctx.rebaseStage(routes, { A: 'Alpha' }, []);
  assert.deepEqual(plain(stage.base), { routes: [{ id: 'a' }], stations: { A: 'Alpha' }, parked: [] });
  assert.deepEqual(plain(stage.routes), routes.map(plain));
  assert.deepEqual(plain(stage.log), []);
});

test('stageAdd queues a route without touching the base, and logs it', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [{ id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null }],
    { RDG: 'Reading', PAD: 'London Paddington' });
  const stage1 = ctx.stageAdd(stage0, 'RDG', 'BRI', { RDG: 'Reading', BRI: 'Bristol Temple Meads' });
  assert.ok(ctx.routeExists(stage1.routes, 'rdg-bri'));
  assert.equal(stage1.stations.BRI, 'Bristol Temple Meads');
  assert.deepEqual(plain(stage1.log), ['Add rdg-bri (Reading ↔ Bristol Temple Meads)']);
  // Base is untouched — only the working copy changed.
  assert.equal(ctx.routeExists(stage0.base.routes, 'rdg-bri'), false);
});

test('stageAdd rejects a duplicate id against the CURRENT working copy (not just base)', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [{ id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null }],
    { RDG: 'Reading', PAD: 'London Paddington' });
  const stage1 = ctx.stageAdd(stage0, 'RDG', 'BRI', { RDG: 'Reading', BRI: 'Bristol' });
  assert.throws(() => ctx.stageAdd(stage1, 'RDG', 'BRI', { RDG: 'Reading', BRI: 'Bristol' }), /already exists/);
});

test('stageAdd queues a connection route, merging the change station name too', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [], { RDG: 'Reading' });
  const stage1 = ctx.stageAdd(stage0, 'RDG', 'HOT',
    { RDG: 'Reading', HOT: 'Henley-On-Thames', TWY: 'Twyford' }, { change: 'TWY', minConnectionMins: 4 });
  const added = stage1.routes.find((r) => r.id === 'rdg-hot');
  assert.deepEqual(plain(added), {
    id: 'rdg-hot', name: 'Reading ↔ Henley-On-Thames', from: 'RDG', to: 'HOT',
    change: 'TWY', minConnectionMins: 4,
  });
  assert.equal(stage1.stations.TWY, 'Twyford');
});

test('stageRemove moves a route to the parked working copy and logs it', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [{ id: 'rdg-bri', from: 'RDG', to: 'BRI' }]);
  const stage1 = ctx.stageRemove(stage0, 'rdg-bri');
  assert.equal(ctx.routeExists(stage1.routes, 'rdg-bri'), false);
  assert.ok(ctx.routeExists(stage1.parked, 'rdg-bri'));
  assert.deepEqual(plain(stage1.log), ['Remove rdg-bri']);
});

test('stageReadd moves a parked route back and logs it', () => {
  const ctx = loadAddRoute();
  const henley = { id: 'rdg-hoh', from: 'RDG', to: 'HOT', change: 'TWY', minConnectionMins: 3 };
  const stage0 = baseStage(ctx, [], {}, [henley]);
  const stage1 = ctx.stageReadd(stage0, 'rdg-hoh');
  assert.deepEqual(plain(stage1.routes.find((r) => r.id === 'rdg-hoh')), henley);
  assert.equal(ctx.routeExists(stage1.parked, 'rdg-hoh'), false);
  assert.deepEqual(plain(stage1.log), ['Re-add rdg-hoh']);
});

// ── purgeParked / stageDelete (permanent delete, unlike remove/re-add) ──────

test('purgeParked drops the entry entirely (not moved anywhere)', () => {
  const ctx = loadAddRoute();
  const henley = { id: 'rdg-hoh', from: 'RDG', to: 'HOT', change: 'TWY', minConnectionMins: 3 };
  const out = ctx.purgeParked([{ id: 'a' }, henley], 'rdg-hoh');
  assert.deepEqual(plain(out).map((r) => r.id), ['a']);
});

test('purgeParked is a no-op for an id that is not parked', () => {
  const ctx = loadAddRoute();
  const parked = [{ id: 'a' }];
  assert.deepEqual(plain(ctx.purgeParked(parked, 'nope')).map((r) => r.id), ['a']);
});

test('stageDelete purges from the working copy, logs it, and leaves routes/stations untouched', () => {
  const ctx = loadAddRoute();
  const henley = { id: 'rdg-hoh', from: 'RDG', to: 'HOT', change: 'TWY', minConnectionMins: 3 };
  const stage0 = baseStage(ctx, [{ id: 'rdg-pad' }], { RDG: 'Reading' }, [henley]);
  const stage1 = ctx.stageDelete(stage0, 'rdg-hoh');
  assert.equal(ctx.routeExists(stage1.parked, 'rdg-hoh'), false);
  assert.deepEqual(plain(stage1.routes).map((r) => r.id), ['rdg-pad']); // untouched
  assert.deepEqual(plain(stage1.log), ['Permanently delete rdg-hoh']);
  // Base is untouched — the delete is still only queued.
  assert.ok(ctx.routeExists(stage0.base.parked, 'rdg-hoh'));
});

test('buildCommitPlan includes parked-routes.json for a queued permanent delete', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [], {}, [{ id: 'a' }, { id: 'b' }]);
  const stage1 = ctx.stageDelete(stage0, 'a');
  const plan = ctx.buildCommitPlan(stage1);
  const files = Object.fromEntries(plain(plan.files).map((f) => [f.path, f.content]));
  assert.deepEqual(Object.keys(files), ['parked-routes.json']);
  assert.deepEqual(JSON.parse(files['parked-routes.json']).map((r) => r.id), ['b']);
  assert.equal(plan.message, 'Permanently delete a');
});

test('stageMove reorders the working copy and logs the direction', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const stage1 = ctx.stageMove(stage0, 'b', -1);
  assert.deepEqual(plain(stage1.routes).map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(plain(stage1.log), ['Reorder b up']);
});

test('discardStage reverts the working copy to base and clears the log', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [{ id: 'a' }, { id: 'b' }]);
  const staged = ctx.stageMove(ctx.stageRemove(stage0, 'a'), 'b', -1); // a couple of queued edits
  const reverted = ctx.discardStage(staged);
  assert.deepEqual(plain(reverted.routes).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(plain(reverted.parked), []);
  assert.deepEqual(plain(reverted.log), []);
  // Same base *content* as before discarding — reverting never re-fetches.
  assert.deepEqual(plain(reverted.base), plain(staged.base));
});

test('buildCommitMessage summarises one change as itself, several as a count + bullets', () => {
  const ctx = loadAddRoute();
  assert.equal(ctx.buildCommitMessage(['Add rdg-bri (Reading ↔ Bristol)']), 'Add rdg-bri (Reading ↔ Bristol)');
  assert.equal(
    ctx.buildCommitMessage(['Add rdg-bri (Reading ↔ Bristol)', 'Remove rdg-oxf', 'Reorder rdg-mai up']),
    '3 route changes\n\n- Add rdg-bri (Reading ↔ Bristol)\n- Remove rdg-oxf\n- Reorder rdg-mai up'
  );
  assert.equal(ctx.buildCommitMessage([]), 'Route changes (no-op)');
});

// The core of what "combine several edits into one commit" means: add a route,
// remove a different one, and reorder the rest — buildCommitPlan must produce
// a single, complete set of files reflecting ALL of it together.
test('buildCommitPlan combines an add + a remove + a reorder into one file set', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(
    ctx,
    [{ id: 'rdg-oxf', from: 'RDG', to: 'OXF', change: null }, { id: 'rdg-mai', from: 'RDG', to: 'MAI', change: null }],
    { RDG: 'Reading', OXF: 'Oxford', MAI: 'Maidenhead' },
    []
  );
  let stage = ctx.stageAdd(stage0, 'RDG', 'BRI', { RDG: 'Reading', BRI: 'Bristol Temple Meads' });
  stage = ctx.stageRemove(stage, 'rdg-oxf');
  stage = ctx.stageMove(stage, 'rdg-mai', -1);

  assert.deepEqual(plain(stage.log), [
    'Add rdg-bri (Reading ↔ Bristol Temple Meads)',
    'Remove rdg-oxf',
    'Reorder rdg-mai up',
  ]);

  const plan = ctx.buildCommitPlan(stage);
  const files = Object.fromEntries(plain(plan.files).map((f) => [f.path, f.content]));

  // All three files that could change are present exactly once each.
  assert.deepEqual(Object.keys(files).sort(), ['parked-routes.json', 'routes.json', 'stations.json']);

  const routes = JSON.parse(files['routes.json']);
  assert.deepEqual(routes.map((r) => r.id), ['rdg-mai', 'rdg-bri']); // oxf removed, mai moved up, bri added
  assert.equal(JSON.parse(files['stations.json']).BRI, 'Bristol Temple Meads');
  assert.deepEqual(JSON.parse(files['parked-routes.json']).map((r) => r.id), ['rdg-oxf']);

  assert.equal(plan.message.split('\n')[0], '3 route changes');
});

test('buildCommitPlan omits files that did not actually change (pure reorder)', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [{ id: 'a' }, { id: 'b' }], { X: 'Y' }, [{ id: 'p' }]);
  const stage = ctx.stageMove(stage0, 'b', -1);
  const plan = ctx.buildCommitPlan(stage);
  assert.deepEqual(plain(plan.files).map((f) => f.path), ['routes.json']);
});

test('buildCommitPlan produces no files when nothing actually changed', () => {
  const ctx = loadAddRoute();
  const stage0 = baseStage(ctx, [{ id: 'a' }]);
  assert.deepEqual(plain(ctx.buildCommitPlan(stage0).files), []);
});

// ── ghGetStageBase / commitStage (network, mocked GitHub) ────────────────────

function mockGh(routesJson, stationsJson, parkedJson, captureTree) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.includes('/contents/routes.json')) return resp({ content: b64(routesJson) });
    if (url.includes('/contents/stations.json')) return resp({ content: b64(stationsJson) });
    if (url.includes('/contents/parked-routes.json')) return resp({ content: b64(parkedJson) });
    if (url.endsWith('/git/ref/heads/main') && method === 'GET') return resp({ object: { sha: 'P' } });
    if (url.endsWith('/git/commits/P') && method === 'GET') return resp({ tree: { sha: 'BT' } });
    if (url.endsWith('/git/trees') && method === 'POST') {
      if (captureTree) captureTree(JSON.parse(opts.body));
      return resp({ sha: 'NT' });
    }
    if (url.endsWith('/git/commits') && method === 'POST') return resp({ sha: 'NC' });
    if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') return resp({});
    throw new Error('unexpected ' + method + ' ' + url);
  };
}

test('ghGetStageBase fetches all three files fresh from GitHub', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');
  const routesJson = [{ id: 'rdg-pad', from: 'RDG', to: 'PAD', change: null }];
  const stationsJson = { RDG: 'Reading', PAD: 'London Paddington' };
  const parkedJson = [{ id: 'rdg-hoh', change: 'TWY' }];
  ctx.fetch = mockGh(routesJson, stationsJson, parkedJson);

  const base = await ctx.ghGetStageBase();
  assert.deepEqual(plain(base.routes), routesJson);
  assert.deepEqual(plain(base.stations), stationsJson);
  assert.deepEqual(plain(base.parked), parkedJson);
});

test('commitStage combines a batch of queued changes into ONE commit', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');
  const routesJson = [
    { id: 'rdg-oxf', from: 'RDG', to: 'OXF', change: null },
    { id: 'rdg-mai', from: 'RDG', to: 'MAI', change: null },
  ];
  const stationsJson = { RDG: 'Reading', OXF: 'Oxford', MAI: 'Maidenhead' };
  const parkedJson = [];
  let treeBody = null;
  ctx.fetch = mockGh(routesJson, stationsJson, parkedJson, (t) => { treeBody = t; });

  let stage = ctx.rebaseStage(await ctx.ghGetJsonFile('routes.json'),
    await ctx.ghGetJsonFile('stations.json'), await ctx.ghGetJsonFile('parked-routes.json'));
  stage = ctx.stageAdd(stage, 'RDG', 'BRI', { RDG: 'Reading', BRI: 'Bristol Temple Meads' });
  stage = ctx.stageRemove(stage, 'rdg-oxf');
  stage = ctx.stageMove(stage, 'rdg-mai', -1);

  const sha = await ctx.commitStage(stage);
  assert.equal(sha, 'NC');

  // Exactly one tree write, containing all three changed files together.
  assert.equal(treeBody.tree.length, 3);
  const files = Object.fromEntries(treeBody.tree.map((t) => [t.path, t.content]));
  assert.deepEqual(JSON.parse(files['routes.json']).map((r) => r.id), ['rdg-mai', 'rdg-bri']);
  assert.deepEqual(JSON.parse(files['parked-routes.json']).map((r) => r.id), ['rdg-oxf']);
  assert.equal(JSON.parse(files['stations.json']).BRI, 'Bristol Temple Meads');
});

test('commitStage is a no-op (no network write) when nothing actually changed', async () => {
  const ctx = loadAddRoute();
  ctx.localStorage.setItem('githubToken', 'tok');
  ctx.fetch = async () => { throw new Error('should not call the network for a no-op stage'); };
  const stage = ctx.rebaseStage([{ id: 'a' }], {}, []);
  const result = await ctx.commitStage(stage);
  assert.equal(result, null);
});
