
"use strict";

/* ==========================================================
   External library URLs (pinned)
   ========================================================== */
const CHART_JS_URL         = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
const CHART_DATALABELS_URL = 'https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0';

/* ==============
   Configuration
   ============== */
const LAT = 30.54879530015167;
const LON = -97.62424544848307;
const API = 'https://api.weather.gov';
const REQUEST_TIMEOUT_MS = 10000; // 10s per call

/* ====================
   Fetch helper
   ==================== */
async function getJSON(url, timeoutMs = REQUEST_TIMEOUT_MS){
  const hasAbort = typeof AbortController !== 'undefined';
  const controller = hasAbort ? new AbortController() : null;
  const timer = hasAbort ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      mode: 'cors',
      headers: { 'Accept': 'application/geo+json, application/json' },
      cache: 'no-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller ? controller.signal : undefined
    });
    if(!res.ok){
      const text = await res.text().catch(() => '');
      throw new Error(`Request failed (${res.status} ${res.statusText}): ${text.slice(0,160)}`);
    }
    return res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Request timed out. Please retry.');
    console.error('Fetch error:', e);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ====================
   Formatting helpers
   ==================== */
function fmtHour(s){
  try { const dt = new Date(s); return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(dt); }
  catch { return s ?? ''; }
}
function fmtDateTime(s){
  try { const dt = new Date(s); return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(dt); }
  catch { return ''; }
}
function toF(valueC){
  if(valueC == null || !Number.isFinite(valueC)) return null;
  const f = (valueC * 9/5) + 32;
  return Number.isFinite(f) ? f : null;
}
function windToMph(value, unitCode){
  if(value == null || !Number.isFinite(value)) return null;
  switch(unitCode){
    case 'wmoUnit:km_h-1': return value * 0.621371;
    case 'wmoUnit:m_s-1':  return value * 2.23694;
    case 'wmoUnit:mi_h-1': return value;
    default: return value; // fallback if unit missing
  }
}
function degToCompass(deg){
  if (deg == null || !Number.isFinite(deg)) return null;
  const d = (deg % 360 + 360) % 360;
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const idx = Math.round(d / 22.5) % 16;
  return dirs[idx];
}

/* ============
   UI helpers
   ============ */
function setText(id, text, suffix=''){
  const el = document.getElementById(id);
  if(!el) return;
  const safe = (text == null || text === '' ? '—' : text);
  el.textContent = `${safe}${suffix ?? ''}`;
  el.classList.remove('loading');
}
function showError(id, msg){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = msg ?? 'An error occurred.';
  el.classList.remove('is-hidden');
}
function hideError(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.add('is-hidden');
  el.textContent = '';
}

/* ==============
   Alerts helpers
   ============== */
const SEVERITY_ORDER = { Extreme: 5, Severe: 4, Moderate: 3, Minor: 2, Unknown: 1 };
function severityColor(sev){
  const rootStyles = getComputedStyle(document.documentElement);
  switch ((sev || 'Unknown')) {
    case 'Extreme':
    case 'Severe':   return rootStyles.getPropertyValue('--warn').trim()     || '#ef4444';
    case 'Moderate': return rootStyles.getPropertyValue('--moderate').trim() || '#f59e0b';
    case 'Minor':    return rootStyles.getPropertyValue('--ok').trim()       || '#22c55e';
    default:         return rootStyles.getPropertyValue('--unknown').trim()  || '#6b7280';
  }
}

function alertsQueryParamsBase(){
  return new URLSearchParams({ status: 'actual', message_type: 'alert', active: '1' });
}
function alertsUrlFromPoint(lat, lon){
  const params = alertsQueryParamsBase();
  params.set('point', `${lat},${lon}`);
  return `${API}/alerts?${params.toString()}`;
}
function alertsUrlFromZone(z){
  const params = alertsQueryParamsBase();
  params.set('zone', z);
  return `${API}/alerts?${params.toString()}`;
}
function mapClickUrlFromPoint(lat, lon){
  // IMPORTANT: use literal '&' in JS strings
  return `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`;
}

function zoneCodesFromPoints(points){
  const zForecast = points?.properties?.forecastZone;
  const zCounty   = points?.properties?.county;
  const zFire     = points?.properties?.fireWeatherZone;
  const zoneCode = (zUrl) => {
    if (!zUrl || typeof zUrl !== 'string') return null;
    try {
      const u = new URL(zUrl);
      const segs = u.pathname.split('/').filter(Boolean);
      return segs[segs.length - 1] || null;
    } catch {
      return zUrl.split('/').pop();
    }
  };
  return Array.from(new Set([zoneCode(zForecast), zoneCode(zCounty), zoneCode(zFire)].filter(Boolean)));
}

function alertKey(f) {
  if (f?.id) return f.id;
  const p = f?.properties || {};
  if (p.id) return p.id;
  if (p['@id']) return p['@id'];
  const sent = p.sent || p.effective || p.onset || '';
  return `${p.event || 'Unknown'}|${sent}`;
}
function zonesFromAlert(f) {
  const ugc = f?.properties?.geocode?.UGC;
  return Array.isArray(ugc) ? ugc : [];
}

async function fetchAlertsCombined(lat, lon) {
  const points = await getJSON(`${API}/points/${lat},${lon}`);
  const zoneCodes = zoneCodesFromPoints(points);

  const zoneReqs = zoneCodes.map(z => ({ label: `zone:${z}`, url: alertsUrlFromZone(z) }));
  const pointReq = { label: `point:${lat},${lon}`, url: alertsUrlFromPoint(lat, lon) };
  const reqs = [...zoneReqs, pointReq];

  const results = await Promise.all(reqs.map(async r => {
    try {
      const resp = await getJSON(r.url);
      const features = resp?.features ?? [];
      return { ...r, ok: true, features };
    } catch (e) {
      console.warn('Alerts request failed:', r.label, r.url, e?.message || e);
      return { ...r, ok: false, features: [] };
    }
  }));

  const pointFeatures    = results.find(r => r.label.startsWith('point:'))?.features ?? [];
  const zoneFeaturesAll  = results.filter(r => r.label.startsWith('zone:')).flatMap(r => r.features);

  const zoneFiltered = zoneFeaturesAll.filter(f => {
    const fZones = zonesFromAlert(f);
    return fZones.some(z => zoneCodes.includes(z));
  });

  const all = [...pointFeatures, ...zoneFiltered];

  const seen = new Set();
  const unique = [];
  for (const f of all) {
    const key = alertKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  return unique;
}

async function renderAlertsForPrimary(lat = LAT, lon = LON) {
  const panel = document.getElementById('alerts-panel');
  const list  = document.getElementById('alerts-list');
  const stamp = document.getElementById('alerts-stamp');
  const errEl = document.getElementById('alerts-error');

  try {
    const active = await fetchAlertsCombined(lat, lon);

    if (panel) panel.classList.remove('is-hidden');
    if (list) list.innerHTML = '';

    if (!active.length) {
      const empty = document.createElement('div');
      empty.className = 'alert-card';
      empty.style.borderLeft = '4px solid ' + severityColor('Unknown');

      const h3 = document.createElement('h3');
      h3.className = 'alert-title';
      h3.textContent = 'No active alerts';
      empty.appendChild(h3);

      const more = document.createElement('div');
      const a = document.createElement('a');
      a.href = mapClickUrlFromPoint(lat, lon);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'View location page';
      more.appendChild(a);
      empty.appendChild(more);

      list.appendChild(empty);

      if (stamp) {
        stamp.textContent = `As of ${new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(new Date())} • 0 active alerts`;
      }
      hideError('alerts-error');
      return { activeCount: 0, hadError: false };
    }

    // Sort by severity desc, then onset/effective asc
    active.sort((a, b) => {
      const sa = SEVERITY_ORDER[a?.properties?.severity] || 0;
      const sb = SEVERITY_ORDER[b?.properties?.severity] || 0;
      if (sb !== sa) return sb - sa;
      const ta = new Date(a?.properties?.onset || a?.properties?.effective || Date.now()).getTime();
      const tb = new Date(b?.properties?.onset || b?.properties?.effective || Date.now()).getTime();
      return ta - tb;
    });

    const frag = document.createDocumentFragment();
    for (const item of active) {
      const p = item?.properties || {};
      const headline  = (p.headline || '').trim();
      const title     = headline || (p.event || 'Weather Alert');
      const severity  = p.severity || 'Unknown';
      const urgency   = p.urgency || 'Unknown';
      const certainty = p.certainty || 'Unknown';
      const effective = p.effective ? fmtDateTime(p.effective) : null;
      const onset     = p.onset ? fmtDateTime(p.onset) : null;
      const ends      = p.ends ? fmtDateTime(p.ends) : null;
      const expires   = p.expires ? fmtDateTime(p.expires) : null;
      const windowTxt = [
        effective ? `Effective: ${effective}` : (onset ? `Onset: ${onset}` : ''),
        (ends || expires) ? `Ends: ${ends || expires}` : ''
      ].filter(Boolean).join(' • ');
      const areaDesc  = (p.areaDesc || '').trim();

      const card = document.createElement('article');
      card.className = 'alert-card';
      card.style.borderLeft = `4px solid ${severityColor(severity)}`;

      const h3 = document.createElement('h3');
      h3.className = 'alert-title';
      h3.textContent = title;

      const meta = document.createElement('div');
      meta.className = 'alert-meta';
      const sevBadge  = document.createElement('span');
      const urgBadge  = document.createElement('span');
      const certBadge = document.createElement('span');
      sevBadge.className  = 'badge'; sevBadge.textContent  = `Severity: ${severity}`;
      urgBadge.className  = 'badge'; urgBadge.textContent  = `Urgency: ${urgency}`;
      certBadge.className = 'badge'; certBadge.textContent = `Certainty: ${certainty}`;
      meta.append(sevBadge, urgBadge, certBadge);
      if (windowTxt) { const winBadge = document.createElement('span'); winBadge.className = 'badge'; winBadge.textContent = windowTxt; meta.append(winBadge); }

      const area = document.createElement('div');
      area.className = 'alert-area';
      area.textContent = areaDesc ? `Areas: ${areaDesc}` : '';

      const desc = document.createElement('div');
      desc.className = 'alert-body';
      desc.textContent = (p.description || '').trim();

      const instr = document.createElement('div');
      instr.className = 'alert-instructions';
      instr.textContent = (p.instruction || '').trim();

      card.append(h3, meta);
      if (areaDesc) card.appendChild(area);
      if (desc.textContent) card.appendChild(desc);
      if (instr.textContent) card.appendChild(instr);

      const more = document.createElement('div');
      const a = document.createElement('a');
      a.href = mapClickUrlFromPoint(lat, lon);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'View location page';
      more.appendChild(a);
      card.appendChild(more);

      frag.appendChild(card);
    }

    if (list) list.appendChild(frag);

    if (stamp) {
      stamp.textContent = `As of ${new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(new Date())} • ${active.length} active alert${active.length > 1 ? 's' : ''}`;
    }
    hideError('alerts-error');
    return { activeCount: active.length, hadError: false };
  } catch (e) {
    console.error('Alerts fetch/render error:', e);
    showError('alerts-error', 'Active alerts unavailable: ' + (e?.message ?? e));
    if (panel) panel.classList.remove('is-hidden');
    return { activeCount: 0, hadError: true };
  }
}

function startAlertsAutoRefresh(lat = LAT, lon = LON, opts = {}) {
  const intervalMs   = opts.intervalMs   ?? 5 * 60 * 1000;
  const maxBackoffMs = opts.maxBackoffMs ?? 30 * 60 * 1000;
  let nextDelay = intervalMs;
  let timerId = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await renderAlertsForPrimary(lat, lon);
      nextDelay = result.hadError ? Math.min(nextDelay * 2, maxBackoffMs) : intervalMs;
    } catch (e) {
      nextDelay = Math.min(nextDelay * 2, maxBackoffMs);
      console.warn(`Alerts auto-refresh exception. Next attempt in ~${Math.round(nextDelay/1000)}s`, e);
    } finally {
      running = false;
      timerId = setTimeout(tick, nextDelay);
    }
  };

  timerId = setTimeout(tick, intervalMs);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (timerId) clearTimeout(timerId); timerId = null; }
    else { if (!timerId) timerId = setTimeout(tick, 1000); }
  });

  return () => { if (timerId) clearTimeout(timerId); timerId = null; };
}

/* ==========================================
   Parallel observation fetch + endpoint cache
   ========================================== */
const endpointCache = new Map();
function keyFromLatLon(lat, lon){ return `${lat},${lon}`; }

async function resolveEndpointsForPoint(lat, lon){
  const key = keyFromLatLon(lat, lon);
  if (endpointCache.has(key)) return endpointCache.get(key);
  const points = await getJSON(`${API}/points/${lat},${lon}`);
  const hourlyUrl   = points?.properties?.forecastHourly;
  const dailyUrl    = points?.properties?.forecast;
  const stationsUrl = points?.properties?.observationStations;
  if(!hourlyUrl || !dailyUrl || !stationsUrl) throw new Error('Could not resolve NWS endpoints from /points.');
  const value = { hourlyUrl, dailyUrl, stationsUrl };
  endpointCache.set(key, value);
  return value;
}

async function getNearestObservationParallel(stations){
  const feats = stations?.features ?? [];
  const subset = feats.slice(0, 10).filter(f => f?.id);
  const results = await Promise.allSettled(
    subset.map(f => getJSON(`${f.id}/observations/latest`).then(latest => ({ p: latest?.properties, id: f.id })))
  );
  const score = (p) => {
    const hasTemp     = p?.temperature?.value != null;
    const hasHumidity = p?.relativeHumidity?.value != null;
    const hasWindSpd  = p?.windSpeed?.value != null;
    const hasWindDir  = p?.windDirection?.value != null;
    const hasDesc     = !!p?.textDescription;
    return (hasTemp && hasHumidity && hasWindSpd && hasWindDir) ? 3 :
           (hasTemp && hasDesc) ? 2 :
           (hasTemp || hasDesc) ? 1 : 0;
  };
  const usable = results
    .filter(r => r.status === 'fulfilled' && r.value?.p)
    .map(r => r.value)
    .sort((a, b) => {
      const sa = score(a.p), sb = score(b.p);
      if (sb !== sa) return sb - sa;
      const ta = new Date(a.p.timestamp || Date.now()).getTime();
      const tb = new Date(b.p.timestamp || Date.now()).getTime();
      return ta - tb;
    });
  if (usable.length) return usable[0].p;
  throw new Error('No recent observations available from nearby stations.');
}

/* ==========================================
   Compact current renderer for family cards
   ========================================== */
async function renderCompactCurrent(lat, lon, ids = {}) {
  const { tempId, condId, windId, errId } = ids;
  const setAllEmpty = () => {
    if (tempId) setText(tempId, '—');
    if (condId) setText(condId, '—');
    if (windId) setText(windId, '—');
  };
  try {
    const { hourlyUrl, stationsUrl } = await resolveEndpointsForPoint(lat, lon);
    const [hourly, stations] = await Promise.all([ getJSON(hourlyUrl), getJSON(stationsUrl) ]);

    // Prefer live observations (parallel)
    try {
      const p = await getNearestObservationParallel(stations);
      const f = toF(p?.temperature?.value);
      if (tempId) setText(tempId, f != null ? Math.round(f) : '—', f != null ? ' °F' : '');
      const mph      = windToMph(p?.windSpeed?.value, p?.windSpeed?.unitCode);
      const gustMph  = windToMph(p?.windGust?.value, p?.windGust?.unitCode);
      const dir      = degToCompass(p?.windDirection?.value);
      const speedStr = (mph != null) ? `${Math.round(mph)} mph` : '—';
      const dirStr   = dir ? ` ${dir}` : '';
      const gustStr  = (gustMph != null) ? ` (gusts ${Math.round(gustMph)} mph)` : '';
      if (windId) setText(windId, speedStr === '—' ? '—' : (speedStr + dirStr + gustStr));
      if (condId) setText(condId, (p?.textDescription || '').trim() || '—');
      if (errId) hideError(errId);
    } catch (obsErr) {
      // Fallback to first hourly period
      const first = hourly?.properties?.periods?.[0];
      if (!first) throw new Error('No hourly periods available for fallback.');
      const tempF = Number.isFinite(Number(first.temperature)) ? Math.round(Number(first.temperature)) : null;
      if (tempId) setText(tempId, tempF ?? '—', tempF != null ? ' °F' : '');
      const windSpeedStr = (first.windSpeed || '').trim();
      const windDirStr   = (first.windDirection || '').trim();
      const windDisplay  = windSpeedStr ? `${windSpeedStr}${windDirStr ? ` ${windDirStr}` : ''}` : '—';
      if (windId) setText(windId, windDisplay);
      if (condId) setText(condId, (first.shortForecast || '').trim() || '—');
      if (errId) showError(errId, 'Live observations unavailable; showing forecast values.');
    }
  } catch (e) {
    setAllEmpty();
    if (errId) showError(errId, 'Current conditions unavailable: ' + (e?.message ?? e));
  }
}

/* =====
   Main
   ===== */
(async function init(){
  try {
    const { hourlyUrl, dailyUrl, stationsUrl } = await resolveEndpointsForPoint(LAT, LON);
    const [hourly, daily, stations] = await Promise.all([
      getJSON(hourlyUrl), getJSON(dailyUrl), getJSON(stationsUrl)
    ]);

    /* Current conditions block */
    try {
      const p = await getNearestObservationParallel(stations);
      const f = toF(p?.temperature?.value);
      setText('current-temp', f != null ? Math.round(f) : '—', f != null ? ' °F' : '');
      const mph        = windToMph(p?.windSpeed?.value, p?.windSpeed?.unitCode);
      const gustMph    = windToMph(p?.windGust?.value, p?.windGust?.unitCode);
      const dirCompass = degToCompass(p?.windDirection?.value);
      const speedPart = (mph != null) ? `${Math.round(mph)} mph` : '—';
      const dirPart   = dirCompass ? ` ${dirCompass}` : '';
      const gustPart  = (gustMph != null) ? ` (gusts ${Math.round(gustMph)} mph)` : '';
      const windTxt   = speedPart === '—' ? '—' : (speedPart + dirPart + gustPart);
      setText('current-wind', windTxt);
      const rh = p?.relativeHumidity?.value;
      const rhRound = Number.isFinite(rh) ? Math.round(rh) : null;
      setText('current-humidity', rhRound ?? '—', rhRound != null ? ' %' : '');
      setText('current-desc', (p?.textDescription || '').trim() || '—');
      const when = p?.timestamp ? new Date(p.timestamp) : null;
      const stampEl = document.getElementById('current-stamp');
      if (stampEl) {
        stampEl.textContent =
          when ? `As of ${new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(when)}` : '';
      }
    } catch (obsErr) {
      console.warn('Current observations unavailable, falling back to hourly forecast:', obsErr?.message ?? obsErr);
      try {
        const first = hourly?.properties?.periods?.[0];
        if (!first) throw new Error('No hourly periods available for fallback.');

        const tempF = Number.isFinite(Number(first.temperature)) ? Math.round(Number(first.temperature)) : null;
        setText('current-temp', tempF ?? '—', tempF != null ? ' °F' : '');

        const windSpeedStr = (first.windSpeed || '').trim();
        const windDirStr   = (first.windDirection || '').trim();
        const windDisplay  = windSpeedStr ? `${windSpeedStr}${windDirStr ? ` ${windDirStr}` : ''}` : '—';
        setText('current-wind', windDisplay);

        setText('current-humidity', '—');
        setText('current-desc', (first.shortForecast || '').trim() || '—');

        const when = first?.startTime ? new Date(first.startTime) : null;
        const stampEl = document.getElementById('current-stamp');
        if (stampEl) {
          stampEl.textContent =
            when ? `As of ${new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(when)} (forecast)` : '';
        }
        showError('current-error', 'Live observations unavailable; showing forecast values instead.');
      } catch (fbErr) {
        showError('current-error', 'Current conditions unavailable: ' + (fbErr?.message ?? fbErr));
        setText('current-temp', '—'); setText('current-wind', '—'); setText('current-humidity', '—'); setText('current-desc', '—');
      }
    }

    /* Active Alerts (primary) + auto-refresh */
    await renderAlertsForPrimary(LAT, LON);
    startAlertsAutoRefresh(LAT, LON, { intervalMs: 5 * 60 * 1000, maxBackoffMs: 30 * 60 * 1000 });

    /* Family locations: compact current + alerts count */
    renderCompactCurrent(41.25227860353873, -110.94751111866145, {
      tempId: 'evan-temp', condId: 'evan-cond', windId: 'evan-wind', errId: 'evan-error'
    });
    renderAlertsCountForLocation(41.25227860353873, -110.94751111866145, 'loc-evanston');

    renderCompactCurrent(41.1352657005268, -112.07580689083038, {
      tempId: 'clint-temp', condId: 'clint-cond', windId: 'clint-wind', errId: 'clint-error'
    });
    renderAlertsCountForLocation(41.1352657005268, -112.07580689083038, 'loc-clinton');

    renderCompactCurrent(37.760143892197924, -113.0369843029422, {
      tempId: 'enoch-temp', condId: 'enoch-cond', windId: 'enoch-wind', errId: 'enoch-error'
    });
    renderAlertsCountForLocation(37.760143892197924, -113.0369843029422, 'loc-enoch');

    renderCompactCurrent(44.883256184819395, -108.46550775738044, {
      tempId: 'cowley-temp', condId: 'cowley-cond', windId: 'cowley-wind', errId: 'cowley-error'
    });
    renderAlertsCountForLocation(44.883256184819395, -108.46550775738044, 'loc-cowley');

    /* Hourly chart (next 12 hours) */
    try {
      const periods = hourly?.properties?.periods ?? [];
      const next12 = periods.slice(0, 12);
      const labels = next12.map(p => fmtHour(p.startTime));
      const temps  = next12.map(p => Number(p.temperature));
      const precs  = next12.map(p => {
        const v = p?.probabilityOfPrecipitation?.value;
        return Number.isFinite(v) ? Number(v) : null;
      });

      const combinedCanvas = document.getElementById('hourlyCombinedChart');
      if (combinedCanvas && labels.length && typeof window.Chart !== 'undefined') {
        const ctx = combinedCanvas.getContext('2d');
        const accent    = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()   || '#214cba';
        const accent2   = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#d0661f';
        const tickColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim()     || '#e5e7eb';
        const tempVals    = temps.filter(v => Number.isFinite(v));
        const hasTempData = tempVals.length > 0;
        const tMin = hasTempData ? Math.min(...tempVals) : 0;
        const tMax = hasTempData ? Math.max(...tempVals) : 100;
        const range  = tMax - tMin; const pad = Math.max(3, Math.round(range * 0.10));
        const niceMin = hasTempData ? Math.floor((tMin - pad) / 5) * 5 : 0;
        const niceMax = hasTempData ? Math.ceil((tMax + pad) / 5) * 5 : 100;
        const precipHasData = precs.some(v => Number.isFinite(v));

        new window.Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: 'Temperature (°F)', data: temps, borderColor: accent, backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 3, tension: 0.25, yAxisID: 'yTemp' },
              { label: 'Precipitation Probability (%)', data: precs, borderColor: accent2, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, tension: 0.25, yAxisID: 'yPrecip', hidden: !precipHasData }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            spanGaps: true,
            interaction: { mode:'index', intersect:false },
            scales: {
              x: { grid:  { color: 'rgba(255,255,255,.06)' }, ticks: { color: tickColor } },
              yTemp: { position: 'left', grid:  { color: 'rgba(255,255,255,.06)' }, ticks: { color: tickColor },
                       title: { display:true, text:'°F' }, min: niceMin, max: niceMax, grace: '5%', beginAtZero: false },
              yPrecip: { position: 'right', grid:  { drawOnChartArea: false }, ticks: { color: tickColor },
                         title: { display:true, text:'%' }, suggestedMin: 0, suggestedMax: 100 }
            },
            plugins: {
              legend:  { labels: { color: tickColor } },
              tooltip: { mode:'index', intersect:false },
              datalabels: {
                display: (ctx) => { const v = ctx.dataset.data[ctx.dataIndex]; return Number.isFinite(v); },
                formatter: (value, ctx) => { if (!Number.isFinite(value)) return ''; return ctx.dataset.yAxisID === 'yPrecip' ? Math.round(value) + '%' : Math.round(value) + '°F'; },
                color: tickColor, align: 'top', offset: 6, clamp: true, clip: false, font: { weight: '600', size: 11 }
              }
            }
          }
        });
      } else {
        throw new Error('Chart.js not available on window.');
      }
    } catch (err) {
      console.error('Hourly chart error:', err);
      showError('hourly-error', 'Hourly chart unavailable: ' + (err?.message ?? err));
    }

    /* Extended forecast table */
    try {
      const dailyData = daily?.properties?.periods ?? [];
      const tbody = document.getElementById('extendedRowsTbody');
      if (tbody) {
        tbody.innerHTML = '';
        for (let i = 0; i < dailyData.length; i++) {
          const day = dailyData[i];
          if (!day?.isDaytime) continue;

          const dayName = (day.name || '').replace(/\bDay$/i, '').trim();
          const dayTemp = (day.temperature != null && day.temperatureUnit)
            ? `${day.temperature}°${day.temperatureUnit}`
            : '—';
          const dayCond = (day.shortForecast || '').trim() || '—';

          const night = (i + 1 < dailyData.length && !dailyData[i + 1].isDaytime) ? dailyData[i + 1] : null;
          const nightTemp = (night && night.temperature != null && night.temperatureUnit)
            ? `${night.temperature}°${night.temperatureUnit}`
            : '—';
          const nightCond = night ? (night.shortForecast || '').trim() || '—' : '—';

          const tr = document.createElement('tr');

          const tdDay       = document.createElement('td'); tdDay.textContent       = dayName || '—';
          const tdDayHigh   = document.createElement('td'); tdDayHigh.textContent   = dayTemp;
          const tdDayCond   = document.createElement('td'); tdDayCond.textContent   = dayCond;
          const tdNightLow  = document.createElement('td'); tdNightLow.textContent  = nightTemp;
          const tdNightCond = document.createElement('td'); tdNightCond.textContent = nightCond;

          tr.append(tdDay, tdDayHigh, tdDayCond, tdNightLow, tdNightCond);
          tbody.appendChild(tr);
        }
      }
    } catch (err) {
      console.error('Extended forecast error:', err);
      showError('extended-error', 'Extended forecast unavailable: ' + (err?.message ?? err));
    }

  } catch (err) {
    console.error('Init error:', err);
    showError('hourly-error',   'Failed to resolve NWS endpoints: ' + (err?.message ?? err));
    showError('extended-error', 'Failed to resolve NWS endpoints: ' + (err?.message ?? err));
    showError('current-error',  'Failed to resolve NWS endpoints: ' + (err?.message ?? err));
    const panel = document.getElementById('alerts-panel');
    if (panel) panel.classList.remove('is-hidden');
  }
})();

/* ==========================================
   Alerts count for location cards (point-based)
   ========================================== */
async function renderAlertsCountForLocation(lat, lon, containerId) {
  const card = document.getElementById(containerId);
  if (!card) return;

  const url = alertsUrlFromPoint(lat, lon);
  try {
    const resp = await getJSON(url);
    const features = resp?.features ?? [];
    const count = features.length;

    const footer = document.createElement('div');
    footer.className = 'loc-alerts';
    footer.setAttribute('aria-live', 'polite'); // accessibility: announce changes
    footer.textContent = count > 0 ? `Active Alerts: ${count}` : 'Active Alerts: None';

    // Toggle visual states:
    footer.classList.toggle('warn-text', count > 0);
    footer.classList.toggle('warn', count > 0);
    footer.classList.toggle('none', count === 0);

    const linkWrap = document.createElement('div');
    linkWrap.className = 'loc-link';
    const link = document.createElement('a');
    link.href = mapClickUrlFromPoint(lat, lon);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View location page';
    linkWrap.appendChild(link);

    card.appendChild(footer);
    card.appendChild(linkWrap);
  } catch (e) {
    console.warn('Failed to fetch alerts for location:', containerId, e);
    const footer = document.createElement('div');
    footer.className = 'loc-alerts';
    footer.setAttribute('aria-live', 'polite');
    footer.textContent = 'Active Alerts: Unavailable';
    footer.classList.add('none');

    const linkWrap = document.createElement('div');
    linkWrap.className = 'loc-link';
    const link = document.createElement('a');
    link.href = mapClickUrlFromPoint(lat, lon);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View location page';
    linkWrap.appendChild(link);

    card.appendChild(footer);
    card.appendChild(linkWrap);
  }
}
