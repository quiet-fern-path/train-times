'use strict';

// ── State ───────────────────────────────────────────────────────────
let ROUTES = [];
let STATIONS = {};
let SCHEDULE = { routes: {} };
let activeRouteId = null;
let activeDir = 'out';
let secTimer = null;
// routeId -> {out, ret} of legs synthesized directly from a live departure
// board (see synthesizeLiveLegs/overlayLiveOnlyRoute) for "quick" routes —
// session-only routes added via the "+" chip that have no schedule.json
// entry at all. Plays the same role SCHEDULE.routes[id] plays for curated
// routes, but is never persisted to localStorage/the repo.
let LIVE_ONLY_BOARDS = {};
// routeId -> has a live fetch ever succeeded for this route (today)? Drives
// whether a failed refresh reports "still showing last known live data" vs
// "no live data yet" — see refreshLiveOverlay().
const liveEverSucceeded = {};
// routeId -> Date.now() of the last successful live fetch, used to show
// "X min ago" alongside the stale/offline status.
const lastLiveSuccessAt = {};
// Set by fetchBoard() when Darwin rejects the key itself (401/403), reset at
// the start of each refreshLiveOverlay() round — lets that round's status
// message say "invalid key" instead of the generic "update failed", since
// the two need different user action (fix the key vs. just wait/retry).
let liveAuthError = false;
// Strings describing each board fetch that failed this refreshLiveOverlay()
// round (network error, unexpected HTTP status, etc.) — reset at the start
// of each round, read at the end to build lastLiveErrorReport.
let liveErrorDetails = [];
// Full copyable text for the error-details panel, or null when the last
// round had nothing to report (hides the header's alert button).
let lastLiveErrorReport = null;
let scrollSaveTimer = null;

// ── Time helpers ────────────────────────────────────────────────────
// Timetable day starts at 03:00. Before 03:00 we're still on yesterday's day.
// depM/arrM values for 00:00–02:59 are stored as 1440+ in schedule.json,
// so nowM() must return 1440+ during those hours to compare correctly.
const DAY_START_HOUR = 3;

function todayStr() {
  const d = new Date();
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function nowM() {
  const n = new Date();
  const raw = n.getHours() * 60 + n.getMinutes();
  return n.getHours() < DAY_START_HOUR ? raw + 1440 : raw;
}
function secsUntil(depM) {
  const n = new Date();
  const raw = n.getHours() * 60 + n.getMinutes();
  const curM = n.getHours() < DAY_START_HOUR ? raw + 1440 : raw;
  return (depM - curM) * 60 - n.getSeconds();
}
// Converts a live "HH:MM" ETD string into a depM-comparable minute value,
// applying the same 3am day-boundary shift used for stored depM/arrM —
// without this, a delayed post-midnight service would compare its live time
// against the wrong day and produce a nonsense delay/countdown.
function liveMinute(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m + (h < DAY_START_HOUR ? 1440 : 0);
}
// The depM to use for now/next/past classification and the countdown: the
// live-adjusted departure minute when we have one, otherwise the scheduled
// one. Deliberately NOT used by overtakers() — overtaking compares scheduled
// timetables, not live running.
function effDepM(leg) {
  return leg._liveDepM != null ? leg._liveDepM : leg.depM;
}
function countdownText(secs) {
  if (secs <= 0) return 'Departing now';
  if (secs < 180) {
    const m = Math.floor(secs / 60), s = secs % 60;
    return m > 0 ? `in ${m}m ${s}s` : `in ${s}s`;
  }
  const m = Math.floor(secs / 60);
  return m === 1 ? 'in 1 min' : `in ${m} min`;
}
function durFmt(mins) {
  if (mins == null || mins <= 0) return '';
  if (mins >= 60) {
    const h = Math.floor(mins / 60), r = mins % 60;
    return r ? `${h}h ${r}m` : `${h} hr`;
  }
  return `${mins} min`;
}
function formatAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? '1 hr ago' : `${hrs} hr ago`;
}

// ── Data loading ────────────────────────────────────────────────────
async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Failed to load ' + url);
  return r.json();
}

// ── Quick (session-only) routes ────────────────────────────────────
// Added via the "+" chip in the route picker: no schedule.json entry, no
// commit, nothing written to the repo — just an instant live-board view.
// Stored in sessionStorage (not localStorage) so the platform itself enforces
// "gone when the tab/browser session ends" rather than needing cleanup code.
const USER_ROUTES_KEY = 'userRoutes';

function loadUserRoutes() {
  let raw;
  try { raw = sessionStorage.getItem(USER_ROUTES_KEY); } catch (e) { return []; }
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(r => r && typeof r.id === 'string' && typeof r.from === 'string' && typeof r.to === 'string');
}

function saveUserRoutes(routes) {
  try { sessionStorage.setItem(USER_ROUTES_KEY, JSON.stringify(routes)); } catch (e) { /* full/unavailable — nothing to surface */ }
}

// Curated routes first, so ROUTES[0] (the default active route — see loadAll)
// is never displaced by a quick route added this session.
function mergeUserRoutes(baseRoutes) {
  return (baseRoutes || []).concat(loadUserRoutes());
}

async function loadAll() {
  let routes;
  [routes, STATIONS, SCHEDULE] = await Promise.all([
    loadJSON('./routes.json'),
    loadJSON('./stations.json'),
    loadJSON('./data/schedule.json'),
  ]);
  ROUTES = mergeUserRoutes(routes);
  activeRouteId = ROUTES[0].id;
}

// ── Live data hot-reload ────────────────────────────────────────────
// sw.js's background stale-while-revalidate refresh (see its fetch handler)
// posts a message here when it discovers the network copy of a data file
// actually differs from what was cached (compared by header, not body — see
// responseChanged() there, since schedule.json can be tens of MB). Without
// this, a schedule update was invisible until the *next* full page load
// after the one that triggered the background refetch. Reloading just the
// changed file and re-rendering in place means it shows up on this load,
// with no manual refresh needed.
const DATA_RELOAD_HANDLERS = {
  [new URL('./data/schedule.json', location.href).href]: async () => {
    SCHEDULE = await loadJSON('./data/schedule.json');
  },
  [new URL('./routes.json', location.href).href]: async () => {
    ROUTES = mergeUserRoutes(await loadJSON('./routes.json'));
    if (!ROUTES.some(r => r.id === activeRouteId)) activeRouteId = ROUTES[0].id;
  },
  [new URL('./stations.json', location.href).href]: async () => {
    STATIONS = await loadJSON('./stations.json');
  },
};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const handler = event.data && event.data.type === 'content-updated' && DATA_RELOAD_HANDLERS[event.data.url];
    if (!handler) return;
    try {
      await handler();
      render();
    } catch (e) {
      // Reload attempt failed (e.g. went offline mid-fetch) — harmless, the
      // next background revalidation will notify again if it's still stale.
    }
  });
}

function currentRoute() {
  return ROUTES.find(r => r.id === activeRouteId);
}

// ── State persistence (route/direction/date) ───────────────────────
// Mirrored into both the URL hash and localStorage, so a refresh, a
// bookmark, or a shared link all reopen the same view. The hash (not a
// query string) is deliberate: a query string would change the exact
// request URL the service worker caches (see sw.js), fragmenting one
// cached page into one entry per route/date ever visited. A hash is never
// sent to the network or included in a same-document navigation's fetch,
// so it carries view state without touching caching at all (the bootstrap
// script in index.html also caches by location.pathname, not
// location.href, for the same reason). localStorage is only a fallback
// for the rare case of opening a bare URL with no hash at all (e.g. a
// home-screen icon someone saved before this existed).
function readURLState() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { route: params.get('route'), dir: params.get('dir'), date: params.get('date') };
}
function writeURLState(state) {
  const params = new URLSearchParams();
  params.set('route', state.route);
  params.set('dir', state.dir);
  params.set('date', state.date);
  const hash = '#' + params.toString();
  if (location.hash !== hash) history.replaceState(null, '', hash);
}
function persistState() {
  const state = { route: activeRouteId, dir: activeDir, date: inp.value || todayStr() };
  localStorage.setItem('lastRouteId', state.route);
  localStorage.setItem('lastDir', state.dir);
  localStorage.setItem('lastDate', state.date);
  writeURLState(state);
}
function restoreState() {
  const url = readURLState();
  const routeId = url.route || localStorage.getItem('lastRouteId');
  const dir = url.dir || localStorage.getItem('lastDir');
  const dateStr = url.date || localStorage.getItem('lastDate');
  if (routeId && ROUTES.some(r => r.id === routeId)) activeRouteId = routeId;
  if (dir === 'out' || dir === 'ret') activeDir = dir;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) inp.value = dateStr;
  persistState(); // normalize the hash to reflect what we actually settled on
}
function applyActiveDirUI() {
  document.querySelectorAll('.tab').forEach(b => {
    const active = b.dataset.dir === activeDir;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + activeDir));
}
// Auto-scrolling to the next train only makes sense when actually
// navigating (switching route/tab/date, or tapping Now) — not on every
// periodic re-render (see renderDirection), which would otherwise yank a
// reader's manual scroll position back every minute.
function scrollToNextIfToday() {
  if ((inp.value || todayStr()) === todayStr()) scrollToNext(document.querySelector('.panel.active'));
}

// ── Platform rendering ──────────────────────────────────────────────
// state: 'none' | 'planned' | 'confirmed' | 'changed'
function platformHtml(platform, confirmed, changed, bookedPlatform, hidden) {
  if (!platform) return '';
  if (changed) {
    const was = bookedPlatform ? ` <span style="font-weight:400">(was ${bookedPlatform})</span>` : '';
    return `<div class="platform changed">Plat ${platform}${was}</div>`;
  }
  // platformIsHidden means Darwin has a live platform but flags it advisory-
  // only, not for public display as confirmed — same "don't trust this yet"
  // cue as the scheduled-only case below, just worded to match its source.
  if (hidden) return `<div class="platform hidden">Plat ${platform} (unconfirmed)</div>`;
  if (confirmed) return `<div class="platform confirmed">Plat ${platform}</div>`;
  return `<div class="platform planned">Plat ${platform} (planned)</div>`;
}

// A delayed departure shows the original scheduled time struck through
// above the actual (live) time in red — mirrors the platform "(was X)"
// treatment above, but stacked rather than inline since tval's font is much
// larger. Skipped for a cancelled leg, whose tval is already fully struck
// through by the .cancelled class — stacking both would be redundant.
function depTimeHtml(scheduled, live, isCancelled) {
  const delayed = !isCancelled && !!live && live !== scheduled;
  const was = delayed ? `<span class="was-time">${scheduled}</span>` : '';
  return `<div class="tval${isCancelled ? ' cancelled' : ''}${delayed ? ' delayed' : ''}">${was}${live || scheduled}</div>`;
}

// Same struck-through-scheduled-time treatment as depTimeHtml, but inline
// (for the change-row's compact "arr X · dep Y" text, not the big tval block).
function inlineLiveTime(scheduled, live) {
  if (!live || live === scheduled) return scheduled;
  return `<span style="text-decoration:line-through;color:var(--muted);margin-right:3px">${scheduled}</span>${live}`;
}

// Darwin's real schema (confirmed against the published Darwin User Guide)
// only exposes `platform` and `platformIsHidden` on a service — there is no
// platformIsConfirmed/platformIsChanged boolean. A live-fetched platform IS
// the confirmation (Darwin only reports it once known); "changed" is
// derived by comparing it against the RTT-scheduled booked platform.
function derivePlatformState(livePlatform, bookedPlatform, hidden) {
  if (!livePlatform) return { confirmed: false, changed: false, hidden: false };
  const changed = !!bookedPlatform && livePlatform !== bookedPlatform;
  return { confirmed: !changed, changed, hidden: !!hidden };
}

// ── Route picker / tabs ─────────────────────────────────────────────
// The "+" add-quick-route control is deliberately its own class (not
// `.route-chip`) so it's never swept up by the `.route-chip` click wiring
// below, which assumes every match has a real `data-route` id.
function renderRoutePicker() {
  const el = document.getElementById('route-picker');
  el.innerHTML = ROUTES.map(r => {
    // A quick (session-only) route gets a small live-dot marker and its own
    // "×" to remove it instantly — curated routes have neither; removing one
    // of those stays exclusively the deliberate, git-committed flow in
    // add-route.html.
    const chip = `<button class="route-chip${r.id === activeRouteId ? ' active' : ''}${r.liveOnly ? ' route-chip-live' : ''}" data-route="${r.id}">${r.liveOnly ? '<span class="route-chip-dot"></span>' : ''}${r.name}</button>`;
    const removeBtn = r.liveOnly
      ? `<button class="chip-remove" data-remove="${r.id}" title="Remove this quick route">&times;</button>`
      : '';
    return chip + removeBtn;
  }).join('') + `<button class="chip-add-quick" id="chip-add-quick" title="Add a quick live route — this session only, no commit">+</button>`;

  el.querySelectorAll('.route-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeRouteId = btn.dataset.route;
      persistState();
      render();
      scrollToNextIfToday();
    });
  });
  el.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', () => removeQuickRoute(btn.dataset.remove));
  });
  const addBtn = document.getElementById('chip-add-quick');
  if (addBtn) addBtn.addEventListener('click', openQuickRouteSheet);
}

function updateRouteTitle() {
  const r = currentRoute();
  document.getElementById('route-title').textContent = r ? r.name : '';
}

// ── Card builders ───────────────────────────────────────────────────
// ── Overtaking. Works for both direct and connection legs: a connection
// leg's top-level depM/arrM is already the whole-journey origin-departure/
// final-arrival pair (fetch_connection() in fetch_schedule.py pairs leg-1s
// with leg-2s at fetch time), so comparing depM/arrM is comparing full
// journeys regardless of how many legs got them there. ───────────────
function overtakers(leg, pool) {
  return pool.filter(o => o !== leg && !o._cancelled && o.depM > leg.depM && o.arrM != null && leg.arrM != null && o.arrM <= leg.arrM);
}

function directCard(leg, route, dir, isToday, curM, faster) {
  const effM = effDepM(leg);
  const isPast = isToday && effM < curM;
  const isNext = !isPast && leg._next;
  const isCancelled = !!leg._cancelled;
  const minsAway = isNext ? effM - curM : 0;
  const label = countdownText(minsAway * 60 - new Date().getSeconds());
  const fromName = STATIONS[dir === 'out' ? route.from : route.to] || (dir === 'out' ? route.from : route.to);
  const toName = STATIONS[dir === 'out' ? route.to : route.from] || (dir === 'out' ? route.to : route.from);

  const nextHtml = `<div class="next-row"><span class="next-badge">Next</span><span class="next-mins">${isNext ? label : ''}</span></div>`;

  const delayTag = leg._delayMins > 0
    ? `<span class="delay-tag">${leg._delayMins} min late</span>`
    : (leg._delayMins === 0 && leg._liveChecked ? `<span class="delay-tag" style="background:#f0fdf4;color:#059669">On time</span>` : '');

  const rttDate = leg.serviceDate || leg.date;
  const rttLink = leg.uid
    ? `<a class="rtt-link" href="https://www.realtimetrains.co.uk/service/gb-nr:${leg.uid}/${rttDate}/detailed" target="_blank" rel="noopener">View on RTT &rarr;</a>`
    : '';

  const isSlower = !!faster;
  const slowerHtml = isSlower
    ? `<div class="change-row"><span class="sh-icon">&#10142;</span>Faster: <strong>${faster.dep}</strong> &rarr; <strong>${faster.arr || '?'}</strong> (${durFmt(faster.arrM != null ? faster.arrM - faster.depM : null)})</div>`
    : '';

  const cls = ['train-card', isPast ? 'is-past' : '', isNext ? 'is-next' : '',
    isNext && minsAway < 5 ? 'is-soon' : '', isCancelled ? 'is-cancelled' : '',
    isSlower ? 'is-slower' : ''].filter(Boolean).join(' ');

  return `<div class="${cls}" data-depm="${effM}" data-uid="${leg.uid || ''}">
    ${nextHtml}
    <div class="journey">
      <div class="tblock">
        ${depTimeHtml(leg.dep, leg._liveDep, isCancelled)}
        <div class="tlabel">${fromName}</div>
        ${platformHtml(leg._platform || leg.platform, leg._platformConfirmed ?? leg.platformConfirmed, leg._platformChanged, leg.platform, leg._platformHidden)}
      </div>
      <div class="track">
        <div class="rail"><div class="rdot"></div><div class="rline"></div><div class="rdot"></div></div>
        <div class="rdur">${durFmt(leg.arrM != null ? leg.arrM - leg.depM : null)}</div>
      </div>
      <div class="tblock">
        ${depTimeHtml(leg.arr || '?', leg._liveArr, isCancelled)}
        <div class="tlabel">${toName}</div>
      </div>
    </div>
    ${delayTag ? `<div class="change-row">${delayTag}</div>` : ''}
    ${slowerHtml}
    ${rttLink}
  </div>`;
}

function connectionCard(leg, route, dir, isToday, curM, faster) {
  const effM = effDepM(leg);
  const isPast = isToday && effM < curM;
  const isNext = !isPast && leg._next;
  const minsAway = isNext ? effM - curM : 0;
  const label = countdownText(minsAway * 60 - new Date().getSeconds());
  const fromName = STATIONS[dir === 'out' ? route.from : route.to] || (dir === 'out' ? route.from : route.to);
  const toName = STATIONS[dir === 'out' ? route.to : route.from] || (dir === 'out' ? route.to : route.from);
  const changeName = STATIONS[route.change] || route.change;

  const nextHtml = `<div class="next-row"><span class="next-badge">Next</span><span class="next-mins">${isNext ? label : ''}</span></div>`;
  const isCancelled = !!leg._cancelled;
  const isSlower = !!faster;
  const cls = ['train-card', isPast ? 'is-past' : '', isNext ? 'is-next' : '', isNext && minsAway < 5 ? 'is-soon' : '', isCancelled ? 'is-cancelled' : '',
    isSlower ? 'is-slower' : ''].filter(Boolean).join(' ');

  const cancelledTag = isCancelled
    ? `<div class="change-row"><span class="delay-tag">${leg._cancelledLeg === 2 ? toName + ' leg' : fromName + ' leg'} cancelled</span></div>`
    : '';

  const slowerHtml = isSlower
    ? `<div class="change-row"><span class="sh-icon">&#10142;</span>Faster: <strong>${faster.dep}</strong> &rarr; <strong>${faster.arr || '?'}</strong> (${durFmt(faster.arrM != null ? faster.arrM - faster.depM : null)})</div>`
    : '';

  const link1 = leg.uid1 ? `<a class="rtt-link" href="https://www.realtimetrains.co.uk/service/gb-nr:${leg.uid1}/${leg.serviceDate1 || leg.date}/detailed" target="_blank" rel="noopener">Leg 1 on RTT &rarr;</a>` : '';
  const link2 = leg.uid2 ? `<a class="rtt-link" href="https://www.realtimetrains.co.uk/service/gb-nr:${leg.uid2}/${leg.serviceDate2 || leg.date}/detailed" target="_blank" rel="noopener">Leg 2 on RTT &rarr;</a>` : '';

  const tightWarning = leg._liveChangeMins != null && leg._liveChangeMins < (route.minConnectionMins || 5)
    ? `<div class="change-row"><span class="delay-tag">Tight connection: ${leg._liveChangeMins} min</span></div>`
    : '';

  // Live arrival time at the change station comes from leg-1's own
  // subsequentCallingPoints entry for it (see applyConnectionOverlay) — no
  // platform, since calling points don't carry one. Live departure time
  // reuses the same departure-board fetch that already drives leg2's
  // platform badge above.
  const changeArrText = inlineLiveTime(leg.changeArr, leg._liveChangeArr);
  const changeDepText = inlineLiveTime(leg.changeDep, leg._liveChangeDep);

  return `<div class="${cls}" data-depm="${effM}">
    ${nextHtml}
    <div class="journey">
      <div class="tblock">
        ${depTimeHtml(leg.dep, leg._liveDep, false)}
        <div class="tlabel">${fromName}</div>
        ${platformHtml(leg._platform1 || leg.platform1, leg._platform1Confirmed ?? leg.platform1Confirmed, leg._platform1Changed, leg.platform1, leg._platform1Hidden)}
      </div>
      <div class="track">
        <div class="rail"><div class="rdot"></div><div class="rline"></div><div class="rdot"></div></div>
        <div class="rdur">${durFmt(leg.arrM != null ? leg.arrM - leg.depM : null)}</div>
      </div>
      <div class="tblock">
        ${depTimeHtml(leg.arr || '?', leg._liveArr, isCancelled)}
        <div class="tlabel">${toName}</div>
        ${platformHtml(leg._platform2 || leg.platform2, leg._platform2Confirmed ?? leg.platform2Confirmed, leg._platform2Changed, leg.platform2, leg._platform2Hidden)}
      </div>
    </div>
    <div class="change-row">Change at ${changeName}: arr ${changeArrText} &middot; dep ${changeDepText} &middot; ${leg.changeMins} min</div>
    ${cancelledTag}
    ${tightWarning}
    ${slowerHtml}
    ${link1} ${link2}
  </div>`;
}

// ── Rendering ───────────────────────────────────────────────────────
// Shared by both the schedule-backed path and the quick (live-only) path
// below — overtaking, next-train selection, the now-line, and card building
// don't care where the legs came from, only that they carry depM/arrM/
// _cancelled/_next-compatible fields (which both synthesizeLiveLegs and
// schedule.json legs do).
function renderLegList(listEl, legs, dir, isToday, curM, cardBuilder, emptyHtml) {
  if (!legs.length) {
    listEl.innerHTML = emptyHtml;
    return;
  }

  // A leg is "always beaten" if a later departure still arrives at the same
  // time or earlier. Hide legs beaten by 2+ distinct trains; dim (but keep)
  // ones beaten by exactly one. Applies to connection legs too: each paired
  // leg already carries whole-journey depM/arrM (origin dep, final dest arr —
  // see fetch_connection() in fetch_schedule.py), so overtakers() compares
  // full journeys the same way regardless of how many legs got them there.
  let visible = legs;
  const fasterMap = new Map();
  let slowerCount = 0;
  legs.forEach(leg => {
    const beaters = overtakers(leg, legs);
    if (beaters.length === 1) fasterMap.set(leg, beaters[0]);
    else if (beaters.length >= 2) fasterMap.set(leg, null);
  });
  visible = legs.filter(leg => !(fasterMap.has(leg) && fasterMap.get(leg) === null));
  slowerCount = visible.filter(leg => fasterMap.has(leg)).length;

  if (isToday) {
    const isSlowerLeg = l => fasterMap.has(l) && fasterMap.get(l) !== null;
    let next = visible.find(l => effDepM(l) >= curM && !l._cancelled && !isSlowerLeg(l));
    if (!next) next = visible.find(l => effDepM(l) >= curM && !l._cancelled); // fall back to a slower train if that's all there is
    if (next) next._next = true;
  }

  if (dir === activeDir) {
    document.getElementById('slower-count').textContent =
      slowerCount > 0 ? `· ${slowerCount} slower train${slowerCount === 1 ? '' : 's'} dimmed` : '';
  }

  const route = currentRoute();
  const parts = [];
  let nowDone = false;
  for (const leg of visible) {
    if (isToday && !nowDone && effDepM(leg) >= curM) {
      const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      parts.push(`<div class="now-line">Now ${hm}</div>`);
      nowDone = true;
    }
    parts.push(cardBuilder(leg, route, dir, isToday, curM, fasterMap.get(leg)));
  }
  if (isToday && !nowDone) {
    const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    parts.push(`<div class="now-line">Now ${hm} — no more trains today</div>`);
  }
  listEl.innerHTML = parts.join('');

  if (isToday && document.getElementById('panel-' + dir).classList.contains('active')) {
    // Scrolling happens only from explicit navigation (see scrollToNextIfToday),
    // not here — this runs on every periodic re-render (tickMinute, live
    // refresh) and must not disturb a reader's current scroll position.
    const nextLeg = legs.find(l => l._next);
    if (nextLeg) maybeStartSecTimer(effDepM(nextLeg)); else clearSecTimer();
  }
}

function liveOnlyEmptyHtml() {
  return apiKey()
    ? `<div class="no-svc"><strong>Fetching live departures…</strong>This is a quick route — it has no timetable of its own, only Darwin's live board. If nothing shows up in a few seconds, check your connection.</div>`
    : `<div class="no-svc"><strong>This is a quick route</strong>It has no timetable of its own — it only shows live departures. Add your free Darwin key (tap ⚙) to see anything here.</div>`;
}

function renderDirection(dir) {
  const route = currentRoute();
  if (!route) return;
  const listEl = document.getElementById('list-' + dir);

  if (route.liveOnly) {
    const board = LIVE_ONLY_BOARDS[route.id] || {};
    const legs = (board[dir] || []).slice().sort((a, b) => a.depM - b.depM);
    renderLegList(listEl, legs, dir, true, nowM(), directCard, liveOnlyEmptyHtml());
    return;
  }

  const dateStr = document.getElementById('vdate').value || todayStr();
  const isToday = dateStr === todayStr();
  const curM = isToday ? nowM() : -1;

  const routeData = SCHEDULE.routes[route.id] || { out: [], ret: [] };
  const isConnection = !!route.change;
  const legs = (routeData[dir] || []).filter(l => l.date === dateStr).sort((a, b) => a.depM - b.depM);
  const dayLabel = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const emptyHtml = `<div class="no-svc"><strong>No service data</strong>No trains found for ${dayLabel}. If this looks wrong, the weekly schedule refresh may not have run yet, or this date is beyond the current lookahead window.</div>`;

  renderLegList(listEl, legs, dir, isToday, curM, isConnection ? connectionCard : directCard, emptyHtml);
}

function render() {
  Object.values(SCHEDULE.routes).forEach(rd => {
    (rd.out || []).forEach(l => { delete l._next; });
    (rd.ret || []).forEach(l => { delete l._next; });
  });
  Object.values(LIVE_ONLY_BOARDS).forEach(rd => {
    (rd.out || []).forEach(l => { delete l._next; });
    (rd.ret || []).forEach(l => { delete l._next; });
  });
  const route = currentRoute();
  const isLiveOnly = !!(route && route.liveOnly);
  // A quick route only ever shows "now" — force today so a date left over
  // from a previously-viewed curated route can't leak in, and hide the date
  // nav entirely since there's nothing else to navigate to.
  if (isLiveOnly) document.getElementById('vdate').value = todayStr();
  const dateNav = document.querySelector('.date-nav');
  if (dateNav) dateNav.style.display = isLiveOnly ? 'none' : 'flex';
  renderRoutePicker();
  updateRouteTitle();
  renderDirection('out');
  renderDirection('ret');
  // schedule.json's generation time is meaningless for a quick route (it has
  // no schedule.json entry at all).
  document.getElementById('schedule-age').textContent = isLiveOnly ? '' : scheduleAgeLabel();
  refreshLiveOverlay();
}

function scheduleAgeLabel() {
  if (!SCHEDULE.generated_at) return '';
  const gen = new Date(SCHEDULE.generated_at);
  const days = Math.floor((Date.now() - gen.getTime()) / 86400000);
  if (SCHEDULE.is_seed_placeholder) return ' · seed data, run the Action for real schedules';
  return ` · schedule updated ${days === 0 ? 'today' : days + 'd ago'}`;
}

// ── NOW button & live tick ──────────────────────────────────────────
function activeNextCard() {
  const p = document.querySelector('.panel.active');
  return p ? p.querySelector('.train-card.is-next') : null;
}
function clearSecTimer() { if (secTimer) { clearInterval(secTimer); secTimer = null; } }
function maybeStartSecTimer(depM) {
  const secs = secsUntil(depM);
  if (secs > 0 && secs < 180) { if (!secTimer) secTimer = setInterval(updateCountdown, 1000); }
  else clearSecTimer();
}
function updateCountdown() {
  const c = activeNextCard();
  if (!c) { clearSecTimer(); return; }
  const dm = parseInt(c.dataset.depm);
  const secs = secsUntil(dm);
  const minsEl = c.querySelector('.next-mins');
  if (minsEl) minsEl.textContent = countdownText(secs);
  c.classList.toggle('is-soon', secs < 300);
  if (secs <= 0) { clearSecTimer(); renderDirection(activeDir); }
  else if (secs >= 180) clearSecTimer();
}

function scheduleNextMinute() {
  const n = new Date();
  const ms = (60 - n.getSeconds()) * 1000 - n.getMilliseconds();
  setTimeout(() => { tickMinute(); scheduleNextMinute(); }, ms);
}
function tickMinute() {
  const dateStr = document.getElementById('vdate').value || todayStr();
  if (dateStr !== todayStr()) return;
  renderDirection('out');
  renderDirection('ret');
  // Also re-poll live data once a minute (refreshLiveOverlay no-ops itself
  // when there's no API key, so this is harmless without one configured).
  refreshLiveOverlay();
}

function scrollToNext(panelEl) {
  const target = panelEl.querySelector('.is-next') || panelEl.querySelector('.now-line');
  if (!target) return;
  setTimeout(() => {
    const hh = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 128;
    const th = document.querySelector('.tab-bar').offsetHeight || 48;
    const y = target.getBoundingClientRect().top + window.scrollY - hh - th - 12;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }, 150);
}

// ── Live overlay (Darwin / LDBWS via Rail Data Marketplace) ─────────
function apiKey() { return localStorage.getItem('darwinApiKey') || ''; }

async function fetchBoard(crs, filterCrs, filterType) {
  const key = apiKey();
  if (!key) return null;
  let url = `https://api1.raildata.org.uk/1010-live-departure-board-dep/LDBWS/api/20220120/GetDepBoardWithDetails/${crs}`;
  const params = new URLSearchParams();
  if (filterCrs) { params.set('filterCrs', filterCrs); params.set('filterType', filterType || 'to'); }
  params.set('numRows', '20');
  url += '?' + params.toString();
  try {
    const r = await fetch(url, { headers: { 'x-apikey': key } });
    if (r.status === 401 || r.status === 403) {
      liveAuthError = true;
      liveErrorDetails.push(`GET ${crs} board -> HTTP ${r.status} ${r.statusText || ''}`.trim());
      return null;
    }
    if (!r.ok) {
      let bodySnippet = '';
      try { bodySnippet = (await r.text()).slice(0, 300); } catch (e2) { /* body already consumed or unreadable */ }
      liveErrorDetails.push(`GET ${crs} board -> HTTP ${r.status} ${r.statusText || ''}${bodySnippet ? '\n  ' + bodySnippet : ''}`.trim());
      return null;
    }
    return await r.json();
  } catch (e) {
    // offline, or CORS/network failure — fall back to scheduled silently,
    // but keep the detail for the error panel in case it's not obvious.
    liveErrorDetails.push(`GET ${crs} board -> ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
    return null;
  }
}

// Two services can share an exact scheduled departure minute (e.g. a GWR and
// an Elizabeth line train both booked at 18:48 Paddington-Reading) — std
// alone doesn't disambiguate them. When `toc` (the RTT-sourced ATOC operator
// code, e.g. "GW"/"XR") is given and more than one candidate shares hhmm,
// prefer the one whose Darwin operatorCode matches it. Falls back to
// first-match-wins (the pre-existing behaviour) when there's no toc to
// compare against or none of the candidates' operatorCode matches it, so a
// missing/differently-cased operator code degrades no worse than before.
function matchByTime(board, hhmm, toc) {
  if (!board || !board.trainServices) return null;
  const candidates = board.trainServices.filter(s => s.std === hhmm);
  if (candidates.length === 0) return null;
  if (candidates.length > 1 && toc) {
    const byToc = candidates.find(s => s.operatorCode === toc);
    if (byToc) return byToc;
  }
  return candidates[0];
}

// A departure board's matched service carries subsequentCallingPoints — the
// full list of stops the service makes after the queried station, each with
// its own st (scheduled)/et (estimated, "On time"/"Delayed"/"Cancelled"/
// HH:MM — same convention as std/etd) — but no platform field (confirmed
// live: platform is only ever present on the queried station's own board
// entry, never on a calling point). Used to read a real live arrival
// estimate at the change station straight off leg-1's own departure-board
// match, without a second API call. subsequentCallingPoints is an array of
// call-point *lists* (plural portions, e.g. a service that divides) rather
// than one flat list, so every list needs searching.
function findCallingPoint(svc, crs) {
  for (const group of svc.subsequentCallingPoints || []) {
    const found = (group.callingPoint || []).find(p => p.crs === crs);
    if (found) return found;
  }
  return null;
}

// Build leg-shaped objects directly from a live departure board's own
// trainServices — used for quick (session-only) routes, which have no
// schedule.json entry to overlay live data onto. Unlike applyDirectOverlay
// (which projects a live delay onto a pre-existing RTT-scheduled leg), a
// quick route has nothing to compare "live" against except this same fetch,
// so the scheduled and _live* fields both come from it. derivePlatformState
// is passed a null booked platform (there isn't one), so a live platform
// always reads as confirmed, never "changed" — there's nothing to compare it
// against. uid is always null: Darwin's serviceID isn't the RTT identity RTT
// deep links need, so directCard's existing `leg.uid ? ... : ''` guard
// already hides the link, no card changes required.
function synthesizeLiveLegs(board, destCrs) {
  if (!board || !board.trainServices) return [];
  const legs = [];
  for (const svc of board.trainServices) {
    if (!svc.std) continue;
    const destPoint = findCallingPoint(svc, destCrs);
    if (!destPoint) continue; // board is already filtered `to` destCrs — shouldn't normally miss
    const depM = liveMinute(svc.std);
    const etdIsTime = svc.etd && /^\d{2}:\d{2}$/.test(svc.etd);
    const isCancelled = svc.isCancelled || svc.etd === 'Cancelled' || !!destPoint.isCancelled || false;
    const delayMins = etdIsTime ? Math.max(0, liveMinute(svc.etd) - depM) : 0;
    const platformState = derivePlatformState(svc.platform, null, svc.platformIsHidden);
    let liveArr = null;
    if (destPoint.et && /^\d{2}:\d{2}$/.test(destPoint.et)) liveArr = destPoint.et;
    else if (destPoint.et === 'On time') liveArr = destPoint.st || null;

    legs.push({
      date: todayStr(),
      serviceDate: todayStr(),
      uid: null,
      toc: svc.operatorCode,
      dep: svc.std,
      depM,
      arr: destPoint.st || null,
      arrM: destPoint.st ? liveMinute(destPoint.st) : null,
      platform: null, // no "booked" platform for a quick route
      platformConfirmed: false,
      _liveChecked: true,
      _cancelled: isCancelled,
      _liveDep: etdIsTime ? svc.etd : svc.std,
      _platform: svc.platform || null,
      _platformConfirmed: platformState.confirmed,
      _platformChanged: platformState.changed,
      _platformHidden: platformState.hidden,
      _delayMins: delayMins,
      _liveDepM: depM + delayMins,
      _liveArr: liveArr,
    });
  }
  return legs;
}

// ── Live data persistence (survive reload / tab switch, up to 1hr) ──
// In-memory live state (leg._liveDepM etc., liveEverSucceeded,
// lastLiveSuccessAt) is lost on every page load, so a refresh used to show
// plain scheduled times until the next fetch completed even if a fetch had
// just succeeded seconds earlier. This snapshots the live fields onto
// localStorage after every successful fetch and replays them at init,
// seeding liveEverSucceeded/lastLiveSuccessAt exactly as if that fetch had
// happened in this page load — so refreshLiveOverlay()'s existing
// stale-data fallback (see staleLiveLabel) takes over unchanged if the
// following live fetch then fails. Expired after 1hr, same as the
// underlying Darwin data would be useless by then anyway.
const LIVE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
function liveCacheKey(routeId) { return `liveCache:${routeId}`; }
// Listed explicitly (not a full leg spread) so schedule-only fields (dep,
// platform, etc., which come fresh from schedule.json on every load) never
// get frozen into the cache and overwrite newer schedule data on restore.
const DIRECT_LIVE_FIELDS = ['_liveChecked', '_cancelled', '_liveDep', '_platform', '_platformConfirmed', '_platformChanged', '_delayMins', '_liveDepM', '_liveArr'];
const CONNECTION_LIVE_FIELDS = ['_cancelled', '_cancelledLeg', '_liveDep', '_liveDepM', '_liveChangeMins', '_platform1', '_platform1Confirmed', '_platform1Changed', '_platform2', '_platform2Confirmed', '_platform2Changed', '_liveChangeArr', '_liveChangeDep', '_liveArr'];
// Direct legs are keyed by their RTT uid; connection legs have no single
// uid (two services), so both are combined — matches how fetch_schedule.py
// pairs them, and is stable across reloads since schedule.json is only
// regenerated weekly.
function legCacheKey(leg, isConnection) { return isConnection ? `${leg.uid1}|${leg.uid2}` : leg.uid; }

function snapshotLegs(legs, isConnection) {
  const fields = isConnection ? CONNECTION_LIVE_FIELDS : DIRECT_LIVE_FIELDS;
  const out = {};
  for (const leg of legs) {
    if (leg._liveDepM == null) continue; // never actually matched against a live board
    const key = legCacheKey(leg, isConnection);
    if (!key) continue;
    const snap = {};
    for (const f of fields) if (leg[f] !== undefined) snap[f] = leg[f];
    out[key] = snap;
  }
  return out;
}
function restoreLegs(legs, isConnection, cached) {
  if (!cached) return;
  for (const leg of legs) {
    const snap = cached[legCacheKey(leg, isConnection)];
    if (snap) Object.assign(leg, snap);
  }
}
// A quick route's cache lives in sessionStorage (gone with the session, like
// the route itself) and holds the FULL synthesized leg arrays rather than a
// sparse _field diff — there's no separate schedule leg to merge onto, the
// cached leg *is* the whole thing. Curated routes keep the existing
// localStorage + sparse-diff-onto-schedule-legs behaviour unchanged.
function liveCacheStorage(route) { return route.liveOnly ? sessionStorage : localStorage; }

function saveLiveCache(route, dateStr) {
  if (route.liveOnly) {
    const board = LIVE_ONLY_BOARDS[route.id];
    if (!board) return;
    const payload = { date: dateStr, savedAt: Date.now(), out: board.out, ret: board.ret };
    try {
      sessionStorage.setItem(liveCacheKey(route.id), JSON.stringify(payload));
    } catch (e) {
      // sessionStorage full/unavailable — nothing to surface to the user.
    }
    return;
  }
  const data = SCHEDULE.routes[route.id];
  if (!data) return;
  const isConnection = !!route.change;
  const payload = {
    date: dateStr,
    savedAt: Date.now(),
    out: snapshotLegs(data.out || [], isConnection),
    ret: snapshotLegs(data.ret || [], isConnection),
  };
  try {
    localStorage.setItem(liveCacheKey(route.id), JSON.stringify(payload));
  } catch (e) {
    // localStorage full or unavailable (e.g. private browsing) — live data
    // just won't survive a reload this time, nothing to surface to the user.
  }
}
function restoreLiveCacheForRoute(route) {
  let raw;
  try { raw = liveCacheStorage(route).getItem(liveCacheKey(route.id)); } catch (e) { return; }
  if (!raw) return;
  let cached;
  try { cached = JSON.parse(raw); } catch (e) { return; }
  const age = Date.now() - (cached.savedAt || 0);
  if (!(age >= 0) || age > LIVE_CACHE_MAX_AGE_MS || cached.date !== todayStr()) return;

  if (route.liveOnly) {
    LIVE_ONLY_BOARDS[route.id] = { out: cached.out || [], ret: cached.ret || [] };
    liveEverSucceeded[route.id] = true;
    lastLiveSuccessAt[route.id] = cached.savedAt;
    return;
  }

  const data = SCHEDULE.routes[route.id];
  if (!data) return;
  const isConnection = !!route.change;
  restoreLegs(data.out || [], isConnection, cached.out);
  restoreLegs(data.ret || [], isConnection, cached.ret);
  liveEverSucceeded[route.id] = true;
  lastLiveSuccessAt[route.id] = cached.savedAt;
}

function staleLiveLabel(routeId) {
  const at = lastLiveSuccessAt[routeId];
  const age = at != null ? formatAge(Date.now() - at) : '';
  return `Showing last known live data (offline${age ? ', ' + age : ''})`;
}

// Drives both the detailed status-bar dot/label and the quiet header strip
// (see .site-header.live-* in styles.css) from one place, so they can never
// disagree about the current state. state: 'off' | 'on' | 'stale' | 'error'.
function setLiveStatus(state, text) {
  const dot = document.getElementById('live-dot');
  const label = document.getElementById('live-label');
  dot.className = 'live-dot' + (state !== 'off' ? ' ' + state : '');
  label.textContent = text;
  hdr.classList.remove('live-on', 'live-stale', 'live-error');
  if (state !== 'off') hdr.classList.add('live-' + state);
  // No key saved: the whole status bar doubles as a shortcut to Settings
  // (see the status-bar click handler below) — flag it as such visually.
  document.getElementById('status-bar').classList.toggle('clickable', state === 'off');
}

function updateLiveErrorIndicator() {
  document.getElementById('btn-live-error').style.display = lastLiveErrorReport ? '' : 'none';
}

async function refreshLiveOverlay() {
  const route = currentRoute();
  if (!route) return;

  // Cleared unconditionally up front so a stale alert from a previous route/
  // date never lingers into a state where live data isn't even being checked.
  liveErrorDetails = [];
  lastLiveErrorReport = null;
  updateLiveErrorIndicator();

  if (!apiKey()) {
    // A quick route has no scheduled-time fallback at all (unlike curated
    // routes), so it needs a distinct message rather than "scheduled times
    // only", which would wrongly imply it has scheduled times to fall back to.
    setLiveStatus('off', route.liveOnly
      ? 'This route needs your Darwin key to show anything — tap ⚙'
      : 'Scheduled times only — tap ⚙ for live platforms & delays');
    return;
  }

  const dateStr = document.getElementById('vdate').value || todayStr();
  if (!route.liveOnly && dateStr !== todayStr()) {
    setLiveStatus('off', 'Scheduled times (live only available for today)');
    return;
  }

  setLiveStatus('stale', liveEverSucceeded[route.id] ? 'Updating live data…' : 'Checking live data…');

  // A fetch failure (offline, CORS, rate limit) must NOT wipe out delay/
  // cancellation/platform info from the last successful fetch — the caller
  // (e.g. someone on a train losing signal in a tunnel) still wants to see
  // the last known state, just clearly marked as not current.
  liveAuthError = false;
  let ok = false;
  try {
    ok = route.liveOnly
      ? await overlayLiveOnlyRoute(route)
      : route.change
        ? await overlayConnectionLive(route, dateStr)
        : await overlayDirectLive(route, dateStr);
  } catch (e) {
    ok = false;
    liveErrorDetails.push(`Unexpected error in refreshLiveOverlay: ${e && e.stack ? e.stack : e}`);
  }

  if (ok) {
    liveEverSucceeded[route.id] = true;
    lastLiveSuccessAt[route.id] = Date.now();
    setLiveStatus('on', route.liveOnly ? 'Live departures' : 'Live platforms & delays');
    saveLiveCache(route, dateStr);
  } else if (liveAuthError) {
    // Distinct from a generic/transient failure: Darwin rejected the key
    // itself, so retrying on its own won't help — the visitor needs to fix
    // the key in Settings.
    setLiveStatus('error', 'Invalid API key — check Settings ⚙');
  } else if (liveEverSucceeded[route.id]) {
    setLiveStatus('stale', staleLiveLabel(route.id));
  } else {
    // A quick route has no scheduled-time fallback to mention — unlike a
    // curated route, there was never anything else to show.
    setLiveStatus('error', route.liveOnly ? 'No live data yet — check your connection' : 'Scheduled times (live update failed)');
  }

  if (!ok && liveErrorDetails.length) {
    lastLiveErrorReport = [
      `Train Times — live data error report`,
      `Time: ${new Date().toString()}`,
      `Route: ${route.id} (${route.name})`,
      `Date viewed: ${dateStr}`,
      `Status shown: ${document.getElementById('live-label').textContent}`,
      `Online: ${navigator.onLine}`,
      'Details:',
      ...liveErrorDetails.map(d => '- ' + d),
    ].join('\n');
  }
  updateLiveErrorIndicator();

  renderDirection('out');
  renderDirection('ret');
}

// Pure merge step, factored out so the "never wipe on a failed fetch"
// guarantee is directly unit-testable without touching module-private state:
// only replaces out/ret for whichever board actually succeeded this round
// (mirrors applyDirectOverlay's own "if (!board) return" no-wipe behaviour),
// so a dropped connection (e.g. a Tube tunnel) never blanks the last-known
// board for the direction that failed.
function mergeLiveOnlyBoard(existing, outBoard, retBoard, route) {
  existing = existing || { out: [], ret: [] };
  return {
    out: outBoard ? synthesizeLiveLegs(outBoard, route.to) : (existing.out || []),
    ret: retBoard ? synthesizeLiveLegs(retBoard, route.from) : (existing.ret || []),
  };
}

// Fetches both direction boards for a quick route and merges them in via
// mergeLiveOnlyBoard — there's no schedule leg to overlay onto, this fully
// replaces LIVE_ONLY_BOARDS[route.id] each round (except where a board fetch
// failed, see above).
async function overlayLiveOnlyRoute(route) {
  const outBoard = await fetchBoard(route.from, route.to, 'to');
  const retBoard = await fetchBoard(route.to, route.from, 'to');
  LIVE_ONLY_BOARDS[route.id] = mergeLiveOnlyBoard(LIVE_ONLY_BOARDS[route.id], outBoard, retBoard, route);
  return !!(outBoard || retBoard);
}

async function overlayDirectLive(route, dateStr) {
  const data = SCHEDULE.routes[route.id];
  if (!data) return false;
  const outBoard = await fetchBoard(route.from, route.to, 'to');
  const retBoard = await fetchBoard(route.to, route.from, 'to');
  applyDirectOverlay(data.out, dateStr, outBoard, route.to);
  applyDirectOverlay(data.ret, dateStr, retBoard, route.from);
  return !!(outBoard || retBoard);
}

function applyDirectOverlay(legs, dateStr, board, destCrs) {
  if (!board) return; // fetch failed this round — leave legs' existing live state untouched
  for (const leg of legs) {
    if (leg.date !== dateStr) continue;
    const svc = matchByTime(board, leg.dep, leg.toc);
    if (!svc) continue;
    leg._liveChecked = true;
    leg._cancelled = svc.isCancelled || svc.etd === 'Cancelled' || false;
    leg._liveDep = svc.etd && svc.etd !== 'On time' && svc.etd !== 'Cancelled' ? svc.etd : leg.dep;
    leg._platform = svc.platform || leg.platform;
    const platformState = derivePlatformState(svc.platform, leg.platform, svc.platformIsHidden);
    leg._platformConfirmed = platformState.confirmed;
    leg._platformChanged = platformState.changed;
    leg._platformHidden = platformState.hidden;
    if (svc.etd && /^\d{2}:\d{2}$/.test(svc.etd)) {
      leg._delayMins = Math.max(0, liveMinute(svc.etd) - leg.depM);
    } else {
      leg._delayMins = 0;
    }
    leg._liveDepM = leg.depM + leg._delayMins;

    // Live arrival estimate at the destination, read straight off this same
    // service's subsequentCallingPoints — the board was already fetched
    // filtered `to` destCrs, so the matched service is guaranteed to call
    // there. Same technique as the change-station arrival (see
    // findCallingPoint/CLAUDE.md): no extra API call, no platform (calling
    // points don't carry one).
    const destPoint = findCallingPoint(svc, destCrs);
    if (destPoint) {
      if (destPoint.isCancelled) leg._cancelled = true;
      if (destPoint.et && /^\d{2}:\d{2}$/.test(destPoint.et)) {
        leg._liveArr = destPoint.et;
      } else if (destPoint.et === 'On time') {
        leg._liveArr = leg.arr;
      }
    }
  }
}

async function overlayConnectionLive(route, dateStr) {
  const data = SCHEDULE.routes[route.id];
  if (!data) return false;
  const outA = await fetchBoard(route.from, route.change, 'to');
  const outB = await fetchBoard(route.change, route.to, 'to');
  const retA = await fetchBoard(route.to, route.change, 'to');
  const retB = await fetchBoard(route.change, route.from, 'to');
  applyConnectionOverlay(data.out, dateStr, outA, outB, route.change, route.to);
  applyConnectionOverlay(data.ret, dateStr, retA, retB, route.change, route.from);
  return !!(outA || outB || retA || retB);
}

function applyConnectionOverlay(legs, dateStr, boardA, boardB, changeCrs, destCrs) {
  if (!boardA && !boardB) return; // both fetches failed — leave legs' existing live state untouched
  for (const leg of legs) {
    if (leg.date !== dateStr) continue;

    // Default each sub-leg's state to whatever we already knew, so that a
    // fetch failure on just one of the two boards this round doesn't erase
    // known state for the other leg.
    let leg1Cancelled = leg._cancelledLeg === 1;
    let leg2Cancelled = leg._cancelledLeg === 2;
    let liveDelay1 = leg._liveDepM != null ? leg._liveDepM - leg.depM : 0;
    let liveDep2M = null;
    let liveArr1M = null; // real live arrival estimate at the change station, when boardA's match carries it

    if (boardA) {
      const s1 = matchByTime(boardA, leg.dep, leg.toc1);
      if (s1) {
        leg1Cancelled = s1.isCancelled || s1.etd === 'Cancelled' || false;
        leg._platform1 = s1.platform || leg.platform1;
        const platform1State = derivePlatformState(s1.platform, leg.platform1, s1.platformIsHidden);
        leg._platform1Confirmed = platform1State.confirmed;
        leg._platform1Changed = platform1State.changed;
        leg._platform1Hidden = platform1State.hidden;
        if (s1.etd && /^\d{2}:\d{2}$/.test(s1.etd)) {
          leg._liveDep = s1.etd;
          liveDelay1 = Math.max(0, liveMinute(s1.etd) - leg.depM);
        } else {
          liveDelay1 = 0;
        }
        // Real live arrival estimate at the change station, read straight off
        // this same service's subsequentCallingPoints — more accurate than
        // projecting leg-1's origin delay forward (see the fallback below).
        // No separate arrival-board query: GetArrBoardWithDetails at the
        // change station returned HTTP 500 in live testing (see CLAUDE.md),
        // and calling points carry no platform field anyway, so there's
        // never a live arrival platform to show here, only a time.
        const changePoint = findCallingPoint(s1, changeCrs);
        if (changePoint) {
          if (changePoint.isCancelled) leg1Cancelled = true;
          if (changePoint.et && /^\d{2}:\d{2}$/.test(changePoint.et)) {
            leg._liveChangeArr = changePoint.et;
            liveArr1M = liveMinute(changePoint.et);
          } else if (changePoint.et === 'On time') {
            leg._liveChangeArr = leg.changeArr;
            liveArr1M = leg.changeArrM;
          }
        }
      }
    }
    if (boardB) {
      const s2 = matchByTime(boardB, leg.changeDep, leg.toc2);
      if (s2) {
        leg2Cancelled = s2.isCancelled || s2.etd === 'Cancelled' || false;
        leg._platform2 = s2.platform || leg.platform2;
        const platform2State = derivePlatformState(s2.platform, leg.platform2, s2.platformIsHidden);
        leg._platform2Confirmed = platform2State.confirmed;
        leg._platform2Changed = platform2State.changed;
        leg._platform2Hidden = platform2State.hidden;
        if (s2.etd && /^\d{2}:\d{2}$/.test(s2.etd)) {
          leg._liveChangeDep = s2.etd;
          liveDep2M = liveMinute(s2.etd);
        } else if (s2.etd === 'On time') {
          leg._liveChangeDep = leg.changeDep;
        }
        // Live arrival estimate at the final destination, read straight off
        // this same service's subsequentCallingPoints — same technique as
        // the change-station arrival above, no extra API call.
        const destPoint = findCallingPoint(s2, destCrs);
        if (destPoint) {
          if (destPoint.isCancelled) leg2Cancelled = true;
          if (destPoint.et && /^\d{2}:\d{2}$/.test(destPoint.et)) {
            leg._liveArr = destPoint.et;
          } else if (destPoint.et === 'On time') {
            leg._liveArr = leg.arr;
          }
        }
      }
    }
    leg._cancelled = leg1Cancelled || leg2Cancelled;
    leg._cancelledLeg = leg1Cancelled ? 1 : (leg2Cancelled ? 2 : 0);
    leg._liveDepM = leg.depM + liveDelay1;
    // Prefer the change-station calling point's real live arrival estimate;
    // only fall back to projecting leg-1's origin delay forward (a
    // reasonable approximation — delay typically carries through to the
    // next stop) when that calling point wasn't found (e.g. boardA's fetch
    // failed, or didn't match this leg at all).
    if (leg.changeArrM != null) {
      const estimatedArr = liveArr1M != null ? liveArr1M : leg.changeArrM + liveDelay1;
      const dep2M = liveDep2M != null ? liveDep2M : leg.changeArrM + leg.changeMins;
      leg._liveChangeMins = dep2M - estimatedArr;
    }
  }
}

// ── Tabs ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
    activeDir = btn.dataset.dir;
    document.getElementById('panel-' + activeDir).classList.add('active');
    persistState();
    renderDirection(activeDir); // refreshes the slower-train count text for this direction
    const dateStr = document.getElementById('vdate').value || todayStr();
    if (dateStr === todayStr()) {
      scrollToNext(document.getElementById('panel-' + activeDir));
      const nc = document.getElementById('panel-' + activeDir).querySelector('.train-card.is-next');
      if (nc) maybeStartSecTimer(parseInt(nc.dataset.depm)); else clearSecTimer();
    }
  });
});

// ── Quick (session-only) route sheet ────────────────────────────────
// stations_all.json (~2,500 entries) is lazily fetched here on first open and
// cached in this module-level var for the rest of the session — kept out of
// the main app's precache/bootstrap list (same reasoning as add-route.html
// lazy-loading it) so it never bloats a normal first visit.
let QUICK_STATIONS = null;

async function ensureQuickStations() {
  if (QUICK_STATIONS) return QUICK_STATIONS;
  QUICK_STATIONS = await loadJSON('./stations_all.json');
  const dl = document.getElementById('quick-station-options');
  if (dl) {
    dl.innerHTML = Object.keys(QUICK_STATIONS)
      .map(crs => `<option value="${QUICK_STATIONS[crs]} (${crs})"></option>`).join('');
  }
  return QUICK_STATIONS;
}

// Extract a CRS from a picker value that may be a bare code ("RDG") or the
// "Name (RDG)" form used by the datalist options above — same convention as
// add-route.js's parseCrs.
function parseQuickCrs(input) {
  if (!input) return '';
  const s = String(input).trim().toUpperCase();
  const m = s.match(/\(([A-Z0-9]{3})\)\s*$/);
  if (m) return m[1];
  return /^[A-Z0-9]{3}$/.test(s) ? s : '';
}

// Prefixed distinctly from curated ids (which are never "q-...") so a quick
// route can never collide with — or be confused in the URL hash/persisted
// state with — a real, git-committed route id.
function buildQuickRouteId(from, to) { return 'q-' + from.toLowerCase() + '-' + to.toLowerCase(); }

async function openQuickRouteSheet() {
  document.getElementById('quick-route-error').textContent = '';
  document.getElementById('quick-from-input').value = '';
  document.getElementById('quick-to-input').value = '';
  document.getElementById('quick-route-overlay').classList.add('open');
  try {
    await ensureQuickStations();
  } catch (e) {
    document.getElementById('quick-route-error').textContent = 'Could not load the station list: ' + e.message;
  }
}
function closeQuickRouteSheet() {
  document.getElementById('quick-route-overlay').classList.remove('open');
}

function addQuickRoute() {
  const errEl = document.getElementById('quick-route-error');
  const from = parseQuickCrs(document.getElementById('quick-from-input').value);
  const to = parseQuickCrs(document.getElementById('quick-to-input').value);
  const stations = QUICK_STATIONS || {};
  if (!from || !stations[from]) { errEl.textContent = 'Pick a valid origin station.'; return; }
  if (!to || !stations[to]) { errEl.textContent = 'Pick a valid destination station.'; return; }
  if (from === to) { errEl.textContent = 'Origin and destination must differ.'; return; }

  const id = buildQuickRouteId(from, to);
  if (ROUTES.some(r => r.id === id)) { errEl.textContent = 'That route is already added.'; return; }

  const route = { id, name: `${stations[from]} ↔ ${stations[to]}`, from, to, change: null, liveOnly: true };
  ROUTES = ROUTES.concat([route]);
  saveUserRoutes(ROUTES.filter(r => r.liveOnly));
  activeRouteId = id;
  closeQuickRouteSheet();
  persistState();
  render();
  scrollToNextIfToday();
}

// No confirmation dialog: this is local-only and instantly reversible by
// re-adding, unlike the git-committed remove flow in add-route.html.
function removeQuickRoute(id) {
  ROUTES = ROUTES.filter(r => r.id !== id);
  saveUserRoutes(ROUTES.filter(r => r.liveOnly));
  delete LIVE_ONLY_BOARDS[id];
  try { sessionStorage.removeItem(liveCacheKey(id)); } catch (e) { /* ignore */ }
  delete liveEverSucceeded[id];
  delete lastLiveSuccessAt[id];
  if (activeRouteId === id) activeRouteId = ROUTES[0].id;
  persistState();
  render();
}

document.getElementById('btn-quick-route-close').addEventListener('click', closeQuickRouteSheet);
document.getElementById('btn-quick-route-add').addEventListener('click', addQuickRoute);

// ── Settings panel ──────────────────────────────────────────────────
function openSettings() {
  document.getElementById('api-key-input').value = apiKey();
  document.getElementById('settings-overlay').classList.add('open');
}
document.getElementById('btn-settings').addEventListener('click', openSettings);
// Lets visitors act on the "tap ⚙ for live updates" status-bar hint (shown
// when no key is saved, e.g. after clearing site data) without hunting for
// the small gear icon.
document.getElementById('status-bar').addEventListener('click', () => {
  if (!apiKey()) openSettings();
});
document.getElementById('btn-settings-close').addEventListener('click', () => {
  document.getElementById('settings-overlay').classList.remove('open');
});
document.getElementById('btn-settings-save').addEventListener('click', () => {
  const val = document.getElementById('api-key-input').value.trim();
  if (val) localStorage.setItem('darwinApiKey', val);
  else localStorage.removeItem('darwinApiKey');
  document.getElementById('settings-overlay').classList.remove('open');
  refreshLiveOverlay();
});

// ── Live data error panel ────────────────────────────────────────────
document.getElementById('btn-live-error').addEventListener('click', () => {
  document.getElementById('error-details-text').value = lastLiveErrorReport || '(no details captured)';
  document.getElementById('error-overlay').classList.add('open');
});
document.getElementById('btn-error-close').addEventListener('click', () => {
  document.getElementById('error-overlay').classList.remove('open');
});
document.getElementById('btn-error-copy').addEventListener('click', async () => {
  const textEl = document.getElementById('error-details-text');
  try {
    await navigator.clipboard.writeText(textEl.value);
  } catch (e) {
    // Clipboard API unavailable/denied (e.g. insecure context) — select the
    // text so it's still copyable manually via the keyboard/context menu.
    textEl.select();
  }
});

// ── Header height tracking ──────────────────────────────────────────
const hdr = document.getElementById('hdr');
function setHH() { document.documentElement.style.setProperty('--header-h', hdr.offsetHeight + 'px'); }

// ── Date nav ────────────────────────────────────────────────────────
const inp = document.getElementById('vdate');
function onDateNavChange() {
  clearSecTimer();
  persistState();
  render();
  scrollToNextIfToday();
}
inp.addEventListener('change', onDateNavChange);
document.getElementById('btn-prev-day').addEventListener('click', () => { inp.value = addDays(inp.value || todayStr(), -1); onDateNavChange(); });
document.getElementById('btn-next-day').addEventListener('click', () => { inp.value = addDays(inp.value || todayStr(), 1); onDateNavChange(); });
// "Now" always means now, regardless of which date is currently being
// browsed — jump back to today first if we're not there, then scroll.
document.getElementById('btn-now').addEventListener('click', () => {
  if ((inp.value || todayStr()) !== todayStr()) {
    inp.value = todayStr();
    onDateNavChange();
  } else {
    scrollToNext(document.querySelector('.panel.active'));
  }
});

// Getting a signal back (e.g. surfacing from the Tube) should refresh live
// data immediately rather than waiting for the next route/date switch.
window.addEventListener('online', () => refreshLiveOverlay());

// ── Init ────────────────────────────────────────────────────────────
(async function init() {
  inp.value = todayStr();
  try {
    await loadAll();
    if (!SCHEDULE.routes) throw new Error('schedule.json is missing its "routes" key');
  } catch (e) {
    document.getElementById('route-title').textContent = 'Couldn\'t load data';
    document.getElementById('list-out').innerHTML =
      `<div class="no-svc"><strong>Something went wrong loading the timetable</strong>${e.message}. If you're offline and this is your first visit to this page, you'll need a connection at least once before it works offline.</div>`;
    return;
  }
  restoreState(); // route/dir/date from the URL hash or localStorage, if any
  applyActiveDirUI();
  // Replay any not-yet-expired live data cached from a previous page load
  // (see saveLiveCache/restoreLiveCacheForRoute above) so a refresh shows
  // last-known delays/platforms instantly instead of reverting to plain
  // scheduled times until refreshLiveOverlay()'s fetch (triggered by the
  // render() call below) completes.
  ROUTES.forEach(restoreLiveCacheForRoute);

  new ResizeObserver(setHH).observe(hdr);
  setHH();
  render();
  scheduleNextMinute();

  // A saved scroll position means this is a reload of the same tab/session —
  // restore exactly where the reader was instead of jumping to "next", which
  // only makes sense for a genuinely fresh visit (a bookmark opened in a new
  // tab has no sessionStorage, so it still gets the normal jump-to-next).
  const savedScrollY = sessionStorage.getItem('scrollY');
  if (savedScrollY != null) {
    setTimeout(() => window.scrollTo(0, parseInt(savedScrollY, 10) || 0), 150);
  } else {
    scrollToNextIfToday();
  }
  window.addEventListener('scroll', () => {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => sessionStorage.setItem('scrollY', String(window.scrollY)), 200);
  }, { passive: true });

  const ic = activeNextCard();
  if (ic) maybeStartSecTimer(parseInt(ic.dataset.depm));
})();
