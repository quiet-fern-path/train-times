'use strict';

// ── State ───────────────────────────────────────────────────────────
let ROUTES = [];
let STATIONS = {};
let SCHEDULE = { routes: {} };
let activeRouteId = null;
let activeDir = 'out';
let secTimer = null;
// routeId -> has a live fetch ever succeeded for this route (today)? Drives
// whether a failed refresh reports "still showing last known live data" vs
// "no live data yet" — see refreshLiveOverlay().
const liveEverSucceeded = {};
// routeId -> Date.now() of the last successful live fetch, used to show
// "X min ago" alongside the stale/offline status.
const lastLiveSuccessAt = {};

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

async function loadAll() {
  [ROUTES, STATIONS, SCHEDULE] = await Promise.all([
    loadJSON('./routes.json'),
    loadJSON('./stations.json'),
    loadJSON('./data/schedule.json'),
  ]);
  activeRouteId = ROUTES[0].id;
}

function currentRoute() {
  return ROUTES.find(r => r.id === activeRouteId);
}

// ── Platform rendering ──────────────────────────────────────────────
// state: 'none' | 'planned' | 'confirmed' | 'changed'
function platformHtml(platform, confirmed, changed, bookedPlatform) {
  if (!platform) return '';
  if (changed) {
    const was = bookedPlatform ? ` <span style="font-weight:400">(was ${bookedPlatform})</span>` : '';
    return `<div class="platform changed">Plat ${platform}${was}</div>`;
  }
  if (confirmed) return `<div class="platform confirmed">Plat ${platform}</div>`;
  return `<div class="platform planned">Plat ${platform} (planned)</div>`;
}

// ── Route picker / tabs ─────────────────────────────────────────────
function renderRoutePicker() {
  const el = document.getElementById('route-picker');
  el.innerHTML = ROUTES.map(r =>
    `<button class="route-chip${r.id === activeRouteId ? ' active' : ''}" data-route="${r.id}">${r.name}</button>`
  ).join('');
  el.querySelectorAll('.route-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeRouteId = btn.dataset.route;
      render();
    });
  });
}

function updateRouteTitle() {
  const r = currentRoute();
  document.getElementById('route-title').textContent = r ? r.name : '';
}

// ── Card builders ───────────────────────────────────────────────────
// ── Overtaking (direct routes only — connection routes compare pairs of
// legs, a different problem not covered here) ───────────────────────
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

  const depTime = leg._liveDep || leg.dep;
  const arrTime = leg._liveArr || leg.arr;

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
        <div class="tval${isCancelled ? ' cancelled' : ''}">${depTime}</div>
        <div class="tlabel">${fromName}</div>
        ${platformHtml(leg._platform || leg.platform, leg._platformConfirmed ?? leg.platformConfirmed, leg._platformChanged, leg.platform)}
      </div>
      <div class="track">
        <div class="rail"><div class="rdot"></div><div class="rline"></div><div class="rdot"></div></div>
        <div class="rdur">${durFmt(leg.arrM != null ? leg.arrM - leg.depM : null)}</div>
      </div>
      <div class="tblock">
        <div class="tval${isCancelled ? ' cancelled' : ''}">${arrTime || '?'}</div>
        <div class="tlabel">${toName}</div>
      </div>
    </div>
    ${delayTag ? `<div class="change-row">${delayTag}</div>` : ''}
    ${slowerHtml}
    ${rttLink}
  </div>`;
}

function connectionCard(leg, route, dir, isToday, curM) {
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
  const cls = ['train-card', isPast ? 'is-past' : '', isNext ? 'is-next' : '', isNext && minsAway < 5 ? 'is-soon' : '', isCancelled ? 'is-cancelled' : ''].filter(Boolean).join(' ');

  const cancelledTag = isCancelled
    ? `<div class="change-row"><span class="delay-tag">${leg._cancelledLeg === 2 ? toName + ' leg' : fromName + ' leg'} cancelled</span></div>`
    : '';

  const link1 = leg.uid1 ? `<a class="rtt-link" href="https://www.realtimetrains.co.uk/service/gb-nr:${leg.uid1}/${leg.serviceDate1 || leg.date}/detailed" target="_blank" rel="noopener">Leg 1 on RTT &rarr;</a>` : '';
  const link2 = leg.uid2 ? `<a class="rtt-link" href="https://www.realtimetrains.co.uk/service/gb-nr:${leg.uid2}/${leg.serviceDate2 || leg.date}/detailed" target="_blank" rel="noopener">Leg 2 on RTT &rarr;</a>` : '';

  const tightWarning = leg._liveChangeMins != null && leg._liveChangeMins < (route.minConnectionMins || 5)
    ? `<div class="change-row"><span class="delay-tag">Tight connection: ${leg._liveChangeMins} min</span></div>`
    : '';

  return `<div class="${cls}" data-depm="${effM}">
    ${nextHtml}
    <div class="journey">
      <div class="tblock">
        <div class="tval">${leg._liveDep || leg.dep}</div>
        <div class="tlabel">${fromName}</div>
        ${platformHtml(leg._platform1 || leg.platform1, leg._platform1Confirmed ?? leg.platform1Confirmed, leg._platform1Changed, leg.platform1)}
      </div>
      <div class="track">
        <div class="rail"><div class="rdot"></div><div class="rline"></div><div class="rdot"></div></div>
        <div class="rdur">${durFmt(leg.arrM != null ? leg.arrM - leg.depM : null)}</div>
      </div>
      <div class="tblock">
        <div class="tval">${leg._liveArr || leg.arr}</div>
        <div class="tlabel">${toName}</div>
        ${platformHtml(leg._platform2 || leg.platform2, leg._platform2Confirmed ?? leg.platform2Confirmed, leg._platform2Changed, leg.platform2)}
      </div>
    </div>
    <div class="change-row">Change at ${changeName}: arr ${leg.changeArr} &middot; dep ${leg.changeDep} &middot; ${leg.changeMins} min</div>
    ${cancelledTag}
    ${tightWarning}
    ${link1} ${link2}
  </div>`;
}

// ── Rendering ───────────────────────────────────────────────────────
function renderDirection(dir) {
  const route = currentRoute();
  if (!route) return;
  const listEl = document.getElementById('list-' + dir);
  const dateStr = document.getElementById('vdate').value || todayStr();
  const isToday = dateStr === todayStr();
  const curM = isToday ? nowM() : -1;

  const routeData = SCHEDULE.routes[route.id] || { out: [], ret: [] };
  const isConnection = !!route.change;
  const legs = (routeData[dir] || []).filter(l => l.date === dateStr).sort((a, b) => a.depM - b.depM);

  if (!legs.length) {
    const dayLabel = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    listEl.innerHTML = `<div class="no-svc"><strong>No service data</strong>No trains found for ${dayLabel}. If this looks wrong, the weekly schedule refresh may not have run yet, or this date is beyond the current lookahead window.</div>`;
    return;
  }

  // Overtaking only applies to direct routes — a leg is "always beaten" if
  // a later departure still arrives at the same time or earlier. Hide legs
  // beaten by 2+ distinct trains; dim (but keep) ones beaten by exactly one.
  let visible = legs;
  const fasterMap = new Map();
  let slowerCount = 0;
  if (!isConnection) {
    legs.forEach(leg => {
      const beaters = overtakers(leg, legs);
      if (beaters.length === 1) fasterMap.set(leg, beaters[0]);
      else if (beaters.length >= 2) fasterMap.set(leg, null);
    });
    visible = legs.filter(leg => !(fasterMap.has(leg) && fasterMap.get(leg) === null));
    slowerCount = visible.filter(leg => fasterMap.has(leg)).length;
  }

  if (isToday) {
    const isSlowerLeg = l => fasterMap.has(l) && fasterMap.get(l) !== null;
    let next = visible.find(l => effDepM(l) >= curM && !l._cancelled && !isSlowerLeg(l));
    if (!next) next = visible.find(l => effDepM(l) >= curM && !l._cancelled); // fall back to a slower train if that's all there is
    if (next) next._next = true;
  }

  if (dir === activeDir) {
    document.getElementById('slower-count').textContent =
      slowerCount > 0 ? `&middot; ${slowerCount} slower train${slowerCount === 1 ? '' : 's'} dimmed`.replace('&middot;', '·') : '';
  }

  const parts = [];
  let nowDone = false;
  for (const leg of visible) {
    if (isToday && !nowDone && effDepM(leg) >= curM) {
      const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      parts.push(`<div class="now-line">Now ${hm}</div>`);
      nowDone = true;
    }
    parts.push(isConnection ? connectionCard(leg, route, dir, isToday, curM) : directCard(leg, route, dir, isToday, curM, fasterMap.get(leg)));
  }
  if (isToday && !nowDone) {
    const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    parts.push(`<div class="now-line">Now ${hm} — no more trains today</div>`);
  }
  listEl.innerHTML = parts.join('');

  if (isToday && document.getElementById('panel-' + dir).classList.contains('active')) {
    scrollToNext(document.getElementById('panel-' + dir));
    const nextLeg = legs.find(l => l._next);
    if (nextLeg) maybeStartSecTimer(effDepM(nextLeg)); else clearSecTimer();
  }
}

function render() {
  ROUTES.forEach(() => {}); // no-op, kept for symmetry with future per-route flags
  Object.values(SCHEDULE.routes).forEach(rd => {
    (rd.out || []).forEach(l => { delete l._next; });
    (rd.ret || []).forEach(l => { delete l._next; });
  });
  renderRoutePicker();
  updateRouteTitle();
  renderDirection('out');
  renderDirection('ret');
  updateNowBtn();
  document.getElementById('schedule-age').textContent = scheduleAgeLabel();
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
function updateNowBtn() {
  const dateStr = document.getElementById('vdate').value || todayStr();
  document.getElementById('btn-now').disabled = dateStr !== todayStr();
}

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
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null; // offline, or CORS/network failure — fall back to scheduled silently
  }
}

function matchByTime(board, hhmm) {
  if (!board || !board.trainServices) return null;
  return board.trainServices.find(s => s.std === hhmm) || null;
}

function staleLiveLabel(routeId) {
  const at = lastLiveSuccessAt[routeId];
  const age = at != null ? formatAge(Date.now() - at) : '';
  return `Showing last known live data (offline${age ? ', ' + age : ''})`;
}

async function refreshLiveOverlay() {
  const route = currentRoute();
  const dot = document.getElementById('live-dot');
  const label = document.getElementById('live-label');
  if (!route) return;

  if (!apiKey()) {
    dot.className = 'live-dot';
    label.textContent = 'Scheduled times';
    return;
  }

  const dateStr = document.getElementById('vdate').value || todayStr();
  if (dateStr !== todayStr()) {
    dot.className = 'live-dot';
    label.textContent = 'Scheduled times (live only available for today)';
    return;
  }

  dot.className = 'live-dot stale';
  label.textContent = liveEverSucceeded[route.id] ? 'Updating live data…' : 'Checking live data…';

  // A fetch failure (offline, CORS, rate limit) must NOT wipe out delay/
  // cancellation/platform info from the last successful fetch — the caller
  // (e.g. someone on a train losing signal in a tunnel) still wants to see
  // the last known state, just clearly marked as not current.
  let ok = false;
  try {
    ok = route.change
      ? await overlayConnectionLive(route, dateStr)
      : await overlayDirectLive(route, dateStr);
  } catch (e) {
    ok = false;
  }

  if (ok) {
    liveEverSucceeded[route.id] = true;
    lastLiveSuccessAt[route.id] = Date.now();
    dot.className = 'live-dot on';
    label.textContent = 'Live platforms & delays';
  } else if (liveEverSucceeded[route.id]) {
    dot.className = 'live-dot stale';
    label.textContent = staleLiveLabel(route.id);
  } else {
    dot.className = 'live-dot';
    label.textContent = 'Scheduled times (live update failed)';
  }

  renderDirection('out');
  renderDirection('ret');
}

async function overlayDirectLive(route, dateStr) {
  const data = SCHEDULE.routes[route.id];
  if (!data) return false;
  const outBoard = await fetchBoard(route.from, route.to, 'to');
  const retBoard = await fetchBoard(route.to, route.from, 'to');
  applyDirectOverlay(data.out, dateStr, outBoard);
  applyDirectOverlay(data.ret, dateStr, retBoard);
  return !!(outBoard || retBoard);
}

function applyDirectOverlay(legs, dateStr, board) {
  if (!board) return; // fetch failed this round — leave legs' existing live state untouched
  for (const leg of legs) {
    if (leg.date !== dateStr) continue;
    const svc = matchByTime(board, leg.dep);
    if (!svc) continue;
    leg._liveChecked = true;
    leg._cancelled = svc.isCancelled || svc.etd === 'Cancelled' || false;
    leg._liveDep = svc.etd && svc.etd !== 'On time' && svc.etd !== 'Cancelled' ? svc.etd : leg.dep;
    leg._platform = svc.platform || leg.platform;
    leg._platformConfirmed = !!svc.platformIsConfirmed;
    leg._platformChanged = !!svc.platformIsChanged;
    if (svc.etd && /^\d{2}:\d{2}$/.test(svc.etd)) {
      leg._delayMins = Math.max(0, liveMinute(svc.etd) - leg.depM);
    } else {
      leg._delayMins = 0;
    }
    leg._liveDepM = leg.depM + leg._delayMins;
  }
}

async function overlayConnectionLive(route, dateStr) {
  const data = SCHEDULE.routes[route.id];
  if (!data) return false;
  const outA = await fetchBoard(route.from, route.change, 'to');
  const outB = await fetchBoard(route.change, route.to, 'to');
  const retA = await fetchBoard(route.to, route.change, 'to');
  const retB = await fetchBoard(route.change, route.from, 'to');
  applyConnectionOverlay(data.out, dateStr, outA, outB);
  applyConnectionOverlay(data.ret, dateStr, retA, retB);
  return !!(outA || outB || retA || retB);
}

function applyConnectionOverlay(legs, dateStr, boardA, boardB) {
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

    if (boardA) {
      const s1 = matchByTime(boardA, leg.dep);
      if (s1) {
        leg1Cancelled = s1.isCancelled || s1.etd === 'Cancelled' || false;
        leg._platform1 = s1.platform || leg.platform1;
        leg._platform1Confirmed = !!s1.platformIsConfirmed;
        leg._platform1Changed = !!s1.platformIsChanged;
        if (s1.etd && /^\d{2}:\d{2}$/.test(s1.etd)) {
          leg._liveDep = s1.etd;
          liveDelay1 = Math.max(0, liveMinute(s1.etd) - leg.depM);
        } else {
          liveDelay1 = 0;
        }
      }
    }
    if (boardB) {
      const s2 = matchByTime(boardB, leg.changeDep);
      if (s2) {
        leg2Cancelled = s2.isCancelled || s2.etd === 'Cancelled' || false;
        leg._platform2 = s2.platform || leg.platform2;
        leg._platform2Confirmed = !!s2.platformIsConfirmed;
        leg._platform2Changed = !!s2.platformIsChanged;
        if (s2.etd && /^\d{2}:\d{2}$/.test(s2.etd)) {
          liveDep2M = liveMinute(s2.etd);
        }
      }
    }
    leg._cancelled = leg1Cancelled || leg2Cancelled;
    leg._cancelledLeg = leg1Cancelled ? 1 : (leg2Cancelled ? 2 : 0);
    leg._liveDepM = leg.depM + liveDelay1;
    // Project leg-1's live delay onto its scheduled arrival at the change
    // station (a reasonable approximation — delay typically carries through
    // to the next stop), then compare against leg-2's live or scheduled
    // departure to see whether the connection is actually still comfortable.
    if (leg.changeArrM != null) {
      const estimatedArr = leg.changeArrM + liveDelay1;
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
    renderDirection(activeDir); // refreshes the slower-train count text for this direction
    const dateStr = document.getElementById('vdate').value || todayStr();
    if (dateStr === todayStr()) {
      scrollToNext(document.getElementById('panel-' + activeDir));
      const nc = document.getElementById('panel-' + activeDir).querySelector('.train-card.is-next');
      if (nc) maybeStartSecTimer(parseInt(nc.dataset.depm)); else clearSecTimer();
    }
  });
});

// ── Settings panel ──────────────────────────────────────────────────
document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('api-key-input').value = apiKey();
  document.getElementById('settings-overlay').classList.add('open');
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

// ── Header height tracking ──────────────────────────────────────────
const hdr = document.getElementById('hdr');
function setHH() { document.documentElement.style.setProperty('--header-h', hdr.offsetHeight + 'px'); }

// ── Date nav ────────────────────────────────────────────────────────
const inp = document.getElementById('vdate');
inp.addEventListener('change', () => { clearSecTimer(); render(); });
document.getElementById('btn-prev-day').addEventListener('click', () => { inp.value = addDays(inp.value || todayStr(), -1); clearSecTimer(); render(); });
document.getElementById('btn-next-day').addEventListener('click', () => { inp.value = addDays(inp.value || todayStr(), 1); clearSecTimer(); render(); });
document.getElementById('btn-now').addEventListener('click', () => { scrollToNext(document.querySelector('.panel.active')); });

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
  new ResizeObserver(setHH).observe(hdr);
  setHH();
  render();
  scheduleNextMinute();
  const ic = activeNextCard();
  if (ic) maybeStartSecTimer(parseInt(ic.dataset.depm));
})();
