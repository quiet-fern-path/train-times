// add-route.js — the in-app route builder / manager.
//
// Lets the (sole) owner add an arbitrary route — direct, or a connection with
// a change station and a minimum connection time (default 5 min) — remove /
// re-add any route, and reorder the active list, from the app itself.
//
// STAGING MODEL: every action above is a *local* edit against an in-memory
// working copy (STAGE) — nothing touches GitHub until "Submit N changes" is
// clicked, at which point every queued edit is combined into ONE commit
// (routes.json / stations.json / parked-routes.json, whichever actually
// changed). This lets the owner add a route, remove a different one, and
// reorder the rest, then push it all as a single commit — matching how a
// hand-edit session in GitHub's web editor would naturally look (one commit,
// several logical changes), rather than one noisy commit per click.
//
// A push to routes.json then triggers update-schedule.yml, which fetches
// just the new/re-added route(s) (fast 7-day phase, then a 90-day backfill)
// — so each route appears in the main app fully first-class with no app.js
// changes. Reordering/removing alone adds no missing route ids, so if a
// submitted batch is pure reorders/removals the push no-ops the fetch.
// See CLAUDE.md and the plan for the why.
//
// Written as a classic script with top-level `function` declarations (like
// app.js) so the pure helpers can be loaded and unit-tested in a Node vm
// (test/loadAddRoute.js) without a DOM. All DOM wiring lives in initAddRoute(),
// which only runs in a real browser (guarded at the bottom).

'use strict';

// ── Repo config (edit these if you fork this project) ───────────────────────
var GH_OWNER = 'quiet-fern-path';
var GH_REPO = 'train-times';
var GH_BRANCH = 'main';
var GH_API = 'https://api.github.com';

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

function githubToken() {
  return (typeof localStorage !== 'undefined' && localStorage.getItem('githubToken')) || '';
}

function buildRouteId(from, to) {
  return String(from).toLowerCase() + '-' + String(to).toLowerCase();
}

function buildRouteName(from, to, names) {
  names = names || {};
  return (names[from] || from) + ' ↔ ' + (names[to] || to);
}

// Build a full route object. Direct when opts.change is falsy (change: null,
// no minConnectionMins key — matches the direct entries already in
// routes.json); a connection route when opts.change is set (minConnectionMins
// defaults to 5, same fallback fetch_schedule.py already uses for a route
// missing the key). id/name are always keyed by origin/destination only (not
// the change station), matching the existing rdg-hoh/pad-hoh convention.
function buildRoute(from, to, names, opts) {
  opts = opts || {};
  var route = {
    id: buildRouteId(from, to),
    name: buildRouteName(from, to, names),
    from: from,
    to: to,
    change: opts.change || null
  };
  if (opts.change) route.minConnectionMins = opts.minConnectionMins || 5;
  return route;
}

// Extract a CRS from a picker value that may be a bare code ("RDG") or the
// "Name (RDG)" form used by the datalist options.
function parseCrs(input) {
  if (!input) return '';
  var s = String(input).trim().toUpperCase();
  var m = s.match(/\(([A-Z0-9]{3})\)\s*$/);
  if (m) return m[1];
  if (/^[A-Z0-9]{3}$/.test(s)) return s;
  return '';
}

function routeExists(routes, id) {
  return (routes || []).some(function (r) { return r.id === id; });
}

// A route and its reverse cover the same journey (out/ret handle both ways),
// so adding the mirror image is almost always a mistake worth warning about.
function reversePairExists(routes, from, to) {
  return (routes || []).some(function (r) { return r.from === to && r.to === from; });
}

function mergeRoute(routes, route) {
  return (routes || []).concat([route]);
}

// Add station display names without overwriting any the repo already has.
function mergeStations(stations, entries) {
  var out = Object.assign({}, stations || {});
  Object.keys(entries || {}).forEach(function (crs) {
    if (!(crs in out) && entries[crs]) out[crs] = entries[crs];
  });
  return out;
}

// Move a route object out of the active list and into the parked list (keeping
// its FULL config, including change / minConnectionMins for connections, so a
// later re-add needs no research). Type-agnostic. Returns new arrays.
function removeRoute(routes, parked, id) {
  var moved = (routes || []).find(function (r) { return r.id === id; });
  var newRoutes = (routes || []).filter(function (r) { return r.id !== id; });
  var newParked = (parked || []).filter(function (r) { return r.id !== id; });
  if (moved) newParked = newParked.concat([moved]);
  return { routes: newRoutes, parked: newParked };
}

// Move a parked route back into the active list (one click, exact config).
function readdRoute(routes, parked, id) {
  var moved = (parked || []).find(function (r) { return r.id === id; });
  var newParked = (parked || []).filter(function (r) { return r.id !== id; });
  var newRoutes = (routes || []).slice();
  if (moved && !routeExists(newRoutes, id)) newRoutes = newRoutes.concat([moved]);
  return { routes: newRoutes, parked: newParked };
}

// Swap the route with `id` with its neighbour `delta` positions away
// (-1 = move up/earlier, +1 = move down/later). Order matters to the main
// app: ROUTES[0] is the initial active route and renderRoutePicker() shows
// chips in array order. Clamped at the boundaries (a no-op past either end);
// returns a new array, never mutates the input.
function moveRoute(routes, id, delta) {
  var arr = (routes || []).slice();
  var idx = arr.findIndex(function (r) { return r.id === id; });
  if (idx === -1) return arr;
  var next = idx + delta;
  if (next < 0 || next >= arr.length) return arr;
  var tmp = arr[idx];
  arr[idx] = arr[next];
  arr[next] = tmp;
  return arr;
}

// ── Staging (pure, unit-tested) ──────────────────────────────────────────────
//
// A "stage" is `{ base: {routes, stations, parked}, routes, stations, parked,
// log }` — `base` is the triple as last read from (or committed to) GitHub;
// `routes`/`stations`/`parked` are the working copy every stage* function
// mutates; `log` is a human-readable list of queued changes, newest last.
// None of these functions touch the network — see ghGetStageBase/commitStage
// below for the network glue, and ensureStage/onSubmit/onDiscard for the DOM
// wiring that ties them together.

// Anchor a stage on `routes`/`stations`/`parked` as the new base, with an
// empty log — used both to create a fresh stage (from a GitHub fetch) and to
// re-anchor one after a successful commit (from what was just committed),
// so the owner can keep queuing more changes without a full re-fetch.
function rebaseStage(routes, stations, parked) {
  return {
    base: { routes: routes, stations: stations, parked: parked },
    routes: routes, stations: stations, parked: parked,
    log: []
  };
}

// Revert the working copy to the stage's base, discarding every queued
// change (but keeping the same base — no network round trip needed).
function discardStage(stage) {
  return rebaseStage(stage.base.routes, stage.base.stations, stage.base.parked);
}

function stageAdd(stage, from, to, names, opts) {
  var route = buildRoute(from, to, names, opts);
  if (routeExists(stage.routes, route.id)) throw new Error('Route "' + route.id + '" already exists.');
  var entries = {};
  entries[from] = names[from];
  entries[to] = names[to];
  if (opts && opts.change) entries[opts.change] = names[opts.change];
  return {
    base: stage.base,
    routes: mergeRoute(stage.routes, route),
    stations: mergeStations(stage.stations, entries),
    parked: stage.parked,
    log: stage.log.concat(['Add ' + route.id + ' (' + route.name + ')'])
  };
}

function stageRemove(stage, id) {
  var next = removeRoute(stage.routes, stage.parked, id);
  return {
    base: stage.base, routes: next.routes, stations: stage.stations, parked: next.parked,
    log: stage.log.concat(['Remove ' + id])
  };
}

function stageReadd(stage, id) {
  var next = readdRoute(stage.routes, stage.parked, id);
  return {
    base: stage.base, routes: next.routes, stations: stage.stations, parked: next.parked,
    log: stage.log.concat(['Re-add ' + id])
  };
}

function stageMove(stage, id, delta) {
  return {
    base: stage.base, routes: moveRoute(stage.routes, id, delta),
    stations: stage.stations, parked: stage.parked,
    log: stage.log.concat(['Reorder ' + id + (delta < 0 ? ' up' : ' down')])
  };
}

// Multi-line commit message: short subject (readable in a log/notification),
// then one bullet per queued change so the full batch is visible in the body.
function buildCommitMessage(log) {
  if (!log || !log.length) return 'Route changes (no-op)';
  if (log.length === 1) return log[0];
  return log.length + ' route changes\n\n' + log.map(function (l) { return '- ' + l; }).join('\n');
}

// Diff the working copy against the stage's base to decide which files
// actually need committing (e.g. a pure reorder never touches stations.json
// or parked-routes.json), and build the combined commit message.
function buildCommitPlan(stage) {
  var files = [];
  if (JSON.stringify(stage.routes) !== JSON.stringify(stage.base.routes)) {
    files.push({ path: 'routes.json', content: toJsonFile(stage.routes) });
  }
  if (JSON.stringify(stage.stations) !== JSON.stringify(stage.base.stations)) {
    files.push({ path: 'stations.json', content: toJsonFile(stage.stations) });
  }
  if (JSON.stringify(stage.parked) !== JSON.stringify(stage.base.parked)) {
    files.push({ path: 'parked-routes.json', content: toJsonFile(stage.parked) });
  }
  return { files: files, message: buildCommitMessage(stage.log) };
}

// ── GitHub commit layer ─────────────────────────────────────────────────────

function ghApiUrl(path) {
  return GH_API + '/repos/' + GH_OWNER + '/' + GH_REPO + path;
}

// Tree entries for a single commit that writes several files at once. GitHub's
// create-tree accepts raw file `content` inline, so no separate blob step.
function buildTreeItems(files) {
  return files.map(function (f) {
    return { path: f.path, mode: '100644', type: 'blob', content: f.content };
  });
}

function decodeBase64Utf8(b64) {
  var clean = String(b64 || '').replace(/\s/g, '');
  if (typeof atob === 'function') {
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  return Buffer.from(clean, 'base64').toString('utf-8'); // Node (tests)
}

// Pretty JSON matching the repo's hand-edited files (2-space, trailing NL).
function toJsonFile(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

async function ghFetch(url, opts) {
  opts = opts || {};
  var headers = Object.assign({
    'Authorization': 'Bearer ' + githubToken(),
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }, opts.headers || {});
  var resp = await fetch(url, Object.assign({}, opts, { headers: headers }));
  if (!resp.ok) {
    var body = '';
    try { body = await resp.text(); } catch (e) { /* ignore */ }
    throw new Error('GitHub API ' + resp.status + ' for ' + url + ': ' + String(body).slice(0, 300));
  }
  return resp.status === 204 ? null : resp.json();
}

// Read a JSON file from the repo's current branch HEAD (fresh, not the possibly
// lagging deployed copy) so a commit is built on top of the real latest state.
async function ghGetJsonFile(path) {
  var data = await ghFetch(ghApiUrl('/contents/' + path + '?ref=' + GH_BRANCH));
  return JSON.parse(decodeBase64Utf8(data.content || ''));
}

// Commit `files` ([{path, content}]) as ONE commit on GH_BRANCH via the Git
// Data API (ref -> base tree -> tree -> commit -> update ref). One commit means
// the workflow's push trigger fires once. Returns the new commit sha.
async function ghCommitFiles(message, files) {
  var ref = await ghFetch(ghApiUrl('/git/ref/heads/' + GH_BRANCH));
  var parentSha = ref.object.sha;
  var parentCommit = await ghFetch(ghApiUrl('/git/commits/' + parentSha));
  var baseTreeSha = parentCommit.tree.sha;
  var tree = await ghFetch(ghApiUrl('/git/trees'), {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: buildTreeItems(files) })
  });
  var commit = await ghFetch(ghApiUrl('/git/commits'), {
    method: 'POST',
    body: JSON.stringify({ message: message, tree: tree.sha, parents: [parentSha] })
  });
  await ghFetch(ghApiUrl('/git/refs/heads/' + GH_BRANCH), {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha })
  });
  return commit.sha;
}

// ── High-level repo operations (browser only) ───────────────────────────────

// Fetch the current routes.json / stations.json / parked-routes.json triple
// from GitHub HEAD — the starting point for a new staging session.
async function ghGetStageBase() {
  var routes = await ghGetJsonFile('routes.json');
  var stations = await ghGetJsonFile('stations.json');
  var parked = await ghGetJsonFile('parked-routes.json');
  return { routes: routes, stations: stations, parked: parked };
}

// Commit everything queued in `stage` as ONE commit. Returns the commit sha,
// or null if nothing in the working copy actually differs from the base
// (e.g. every queued change cancelled itself out).
async function commitStage(stage) {
  var plan = buildCommitPlan(stage);
  if (!plan.files.length) return null;
  return ghCommitFiles(plan.message, plan.files);
}

// ── DOM wiring (browser only) ───────────────────────────────────────────────

var STATIONS_ALL = {};
var STAGE = null;

function el(id) { return document.getElementById(id); }

function setStatus(msg, kind) {
  var s = el('status');
  if (!s) return;
  s.textContent = msg || '';
  s.className = 'manage-status' + (kind ? ' ' + kind : '');
}

function actionsLink() {
  return 'https://github.com/' + GH_OWNER + '/' + GH_REPO + '/actions';
}

function hasToken() { return !!githubToken(); }

async function loadJson(url) {
  var r = await fetch(url);
  if (!r.ok) throw new Error('Failed to load ' + url);
  return r.json();
}

function renderStationOptions() {
  var dl = el('station-options');
  if (!dl) return;
  var frag = document.createDocumentFragment();
  Object.keys(STATIONS_ALL).forEach(function (crs) {
    var o = document.createElement('option');
    o.value = STATIONS_ALL[crs] + ' (' + crs + ')';
    frag.appendChild(o);
  });
  dl.appendChild(frag);
}

function routeLabel(r) {
  var name = r.name || (r.from + ' ↔ ' + r.to);
  var kind = r.change ? ' · via ' + (STATIONS_ALL[r.change] || r.change) : '';
  return name + kind;
}

// Lazily start (or return the existing) staging session. A no-op once STAGE
// is set — after a successful submit it's re-anchored (not nulled), so the
// owner can keep queuing more changes without a network round trip, and
// clearing the GitHub token doesn't lose an in-progress queue either.
async function ensureStage() {
  if (STAGE) return STAGE;
  var base = await ghGetStageBase();
  STAGE = rebaseStage(base.routes, base.stations, base.parked);
  return STAGE;
}

async function refreshLists() {
  if (hasToken() && !STAGE) {
    try { await ensureStage(); } catch (e) {
      setStatus('Could not load current routes from GitHub: ' + e.message, 'err');
    }
  }

  var routes, parked;
  if (STAGE) {
    routes = STAGE.routes;
    parked = STAGE.parked;
  } else {
    routes = [];
    parked = [];
    try { routes = await loadJson('./routes.json'); } catch (e) { /* leave empty */ }
    try { parked = await loadJson('./parked-routes.json'); } catch (e) { /* file may not exist yet */ }
  }

  var active = el('active-routes');
  if (active) {
    active.innerHTML = '';
    routes.forEach(function (r, i) {
      var row = document.createElement('div');
      row.className = 'manage-row';
      var span = document.createElement('span');
      var pending = STAGE && !routeExists(STAGE.base.routes, r.id);
      span.textContent = routeLabel(r) + (pending ? ' (pending)' : '');

      var upBtn = document.createElement('button');
      upBtn.className = 'manage-btn manage-btn-move';
      upBtn.textContent = '▲';
      upBtn.title = 'Move up';
      upBtn.disabled = !hasToken() || i === 0;
      upBtn.addEventListener('click', function () { onMove(r.id, -1); });

      var downBtn = document.createElement('button');
      downBtn.className = 'manage-btn manage-btn-move';
      downBtn.textContent = '▼';
      downBtn.title = 'Move down';
      downBtn.disabled = !hasToken() || i === routes.length - 1;
      downBtn.addEventListener('click', function () { onMove(r.id, 1); });

      var btn = document.createElement('button');
      btn.className = 'btn-close manage-btn';
      btn.textContent = 'Remove';
      btn.disabled = !hasToken();
      btn.addEventListener('click', function () { onRemove(r.id); });

      row.appendChild(span);
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      row.appendChild(btn);
      active.appendChild(row);
    });
  }

  var parkedEl = el('parked-routes');
  var parkedSection = el('parked-section');
  if (parkedEl) {
    parkedEl.innerHTML = '';
    parked.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'manage-row';
      var span = document.createElement('span');
      var pending = STAGE && !routeExists(STAGE.base.parked, r.id);
      span.textContent = routeLabel(r) + (pending ? ' (pending)' : '');
      var btn = document.createElement('button');
      btn.className = 'btn-save manage-btn';
      btn.textContent = 'Re-add';
      btn.disabled = !hasToken();
      btn.addEventListener('click', function () { onReadd(r.id); });
      row.appendChild(span);
      row.appendChild(btn);
      parkedEl.appendChild(row);
    });
    if (parkedSection) parkedSection.style.display = parked.length ? 'block' : 'none';
  }

  var pendingSection = el('pending-section');
  var pendingLog = el('pending-log');
  var log = STAGE ? STAGE.log : [];
  if (pendingLog) {
    pendingLog.innerHTML = '';
    log.forEach(function (entry) {
      var li = document.createElement('li');
      li.textContent = entry;
      pendingLog.appendChild(li);
    });
  }
  if (pendingSection) pendingSection.style.display = log.length ? 'block' : 'none';
  var submitBtn = el('btn-submit');
  if (submitBtn) {
    submitBtn.disabled = !hasToken() || !log.length;
    submitBtn.textContent = 'Submit ' + log.length + ' change' + (log.length === 1 ? '' : 's') + ' to GitHub';
  }
  var discardBtn = el('btn-discard');
  if (discardBtn) discardBtn.disabled = !log.length;
}

function updateTokenUi() {
  var have = hasToken();
  var gate = el('token-gate');
  if (gate) gate.style.display = have ? 'none' : 'block';
  var badge = el('token-badge');
  if (badge) badge.style.display = have ? 'inline' : 'none';
  var addBtn = el('btn-add');
  if (addBtn) addBtn.disabled = !have;
}

function connectionOpts() {
  var toggle = el('connection-toggle');
  if (!toggle || !toggle.checked) return { opts: null };

  var change = parseCrs(el('change-input').value);
  if (!change || !STATIONS_ALL[change]) return { error: 'Pick a valid change station.' };

  var minConn = parseInt(el('min-conn-input').value, 10);
  if (!Number.isFinite(minConn) || minConn < 1) {
    return { error: 'Minimum connection minutes must be a positive number.' };
  }
  return { opts: { change: change, minConnectionMins: minConn } };
}

async function onAdd() {
  var from = parseCrs(el('from-input').value);
  var to = parseCrs(el('to-input').value);
  if (!from || !STATIONS_ALL[from]) { setStatus('Pick a valid origin station.', 'err'); return; }
  if (!to || !STATIONS_ALL[to]) { setStatus('Pick a valid destination station.', 'err'); return; }
  if (from === to) { setStatus('Origin and destination must differ.', 'err'); return; }

  var conn = connectionOpts();
  if (conn.error) { setStatus(conn.error, 'err'); return; }
  var opts = conn.opts;
  if (opts && (opts.change === from || opts.change === to)) {
    setStatus('Change station must differ from both origin and destination.', 'err');
    return;
  }

  try {
    await ensureStage();
  } catch (e) {
    setStatus('Could not load current routes from GitHub: ' + e.message, 'err');
    return;
  }

  if (reversePairExists(STAGE.routes, from, to) &&
      !confirm('A route for the reverse journey already exists (it covers both directions). Queue this one anyway?')) {
    return;
  }

  try {
    STAGE = stageAdd(STAGE, from, to, STATIONS_ALL, opts);
    setStatus('Queued: add ' + buildRouteId(from, to) + '. Review the pending changes below, then submit.', 'ok');
    el('from-input').value = '';
    el('to-input').value = '';
    if (el('change-input')) el('change-input').value = '';
    if (el('connection-toggle')) { el('connection-toggle').checked = false; toggleConnectionFields(); }
    await refreshLists();
  } catch (e) {
    setStatus(e.message, 'err');
  }
}

async function onMove(id, delta) {
  try {
    await ensureStage();
  } catch (e) {
    setStatus('Could not load current routes from GitHub: ' + e.message, 'err');
    return;
  }
  STAGE = stageMove(STAGE, id, delta);
  setStatus('Queued: reorder.', 'ok');
  await refreshLists();
}

async function onRemove(id) {
  if (!confirm('Queue removal of "' + id + '"? It will be parked (and can be re-added any time) once you submit.')) return;
  try {
    await ensureStage();
  } catch (e) {
    setStatus('Could not load current routes from GitHub: ' + e.message, 'err');
    return;
  }
  STAGE = stageRemove(STAGE, id);
  setStatus('Queued: remove ' + id + '.', 'ok');
  await refreshLists();
}

async function onReadd(id) {
  try {
    await ensureStage();
  } catch (e) {
    setStatus('Could not load current routes from GitHub: ' + e.message, 'err');
    return;
  }
  STAGE = stageReadd(STAGE, id);
  setStatus('Queued: re-add ' + id + '.', 'ok');
  await refreshLists();
}

async function onSubmit() {
  if (!STAGE || !STAGE.log.length) return;
  var btn = el('btn-submit');
  if (btn) btn.disabled = true;
  setStatus('Submitting ' + STAGE.log.length + ' change(s)…', 'busy');
  try {
    var plan = buildCommitPlan(STAGE);
    if (!plan.files.length) {
      STAGE = rebaseStage(STAGE.routes, STAGE.stations, STAGE.parked);
      setStatus('Nothing actually changed — cleared the pending list.', '');
    } else {
      await commitStage(STAGE);
      STAGE = rebaseStage(STAGE.routes, STAGE.stations, STAGE.parked);
      setStatus('Committed. The schedule will fetch automatically for any new/re-added routes (usable in ~2–3 min, full 90 days a few minutes later).', 'ok');
    }
    await refreshLists();
  } catch (e) {
    setStatus(e.message, 'err');
  } finally {
    if (btn) btn.disabled = !(STAGE && STAGE.log.length) || !hasToken();
  }
}

function onDiscard() {
  if (!STAGE || !STAGE.log.length) return;
  if (!confirm('Discard all ' + STAGE.log.length + ' pending change(s)? Nothing has been committed yet.')) return;
  STAGE = discardStage(STAGE);
  setStatus('Discarded pending changes.', '');
  refreshLists();
}

function onSaveToken() {
  var val = el('token-input').value.trim();
  if (val) localStorage.setItem('githubToken', val);
  else localStorage.removeItem('githubToken');
  el('token-input').value = '';
  updateTokenUi();
  refreshLists();
  setStatus(val ? 'Token saved on this device.' : 'Token cleared.', val ? 'ok' : '');
}

function onClearToken() {
  localStorage.removeItem('githubToken');
  updateTokenUi();
  refreshLists();
  setStatus('Token cleared. Any pending changes are kept — paste a token again to submit them.', '');
}

function toggleConnectionFields() {
  var toggle = el('connection-toggle');
  var fields = el('connection-fields');
  if (fields) fields.style.display = (toggle && toggle.checked) ? 'block' : 'none';
}

async function initAddRoute() {
  var link = el('actions-link');
  if (link) link.href = actionsLink();

  el('btn-add').addEventListener('click', onAdd);
  el('btn-save-token').addEventListener('click', onSaveToken);
  var clearBtn = el('btn-clear-token');
  if (clearBtn) clearBtn.addEventListener('click', onClearToken);
  var connToggle = el('connection-toggle');
  if (connToggle) connToggle.addEventListener('change', toggleConnectionFields);
  var submitBtn = el('btn-submit');
  if (submitBtn) submitBtn.addEventListener('click', onSubmit);
  var discardBtn = el('btn-discard');
  if (discardBtn) discardBtn.addEventListener('click', onDiscard);

  updateTokenUi();

  try {
    STATIONS_ALL = await loadJson('./stations_all.json');
    renderStationOptions();
  } catch (e) {
    setStatus('Could not load the station list: ' + e.message, 'err');
  }
  await refreshLists();
}

// Only bootstrap in a real browser. The test harness loads this file without a
// document, so the pure helpers above are defined but initAddRoute never runs.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', initAddRoute);
}
