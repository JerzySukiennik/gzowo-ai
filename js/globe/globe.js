// js/globe/globe.js — GLOBE ("Spatial") mode. Cesium takeover: the avatar becomes
// an interactive globe, driven by voice + mouse. 3D precedence: Google Photorealistic
// (key+card) > Cesium ion (terrain + OSM buildings + Bing, free) > free Esri flat.
// Earth sits in a BLACK void (no stars/sun/moon). Cesium is lazy-loaded on first
// show_globe so it never touches boot. Everything degrades honestly.
//
// HUD is exactly two sections (Jurek's spec): SATELITY (bottom-left: toggle +
// per-type filter legend) and SAMOLOTY (bottom-right: toggle + commercial/military +
// live count). The HUD auto-shows only when the whole Earth is in view and smoothly
// hides when zoomed into a place. All of it is also assistant-controllable/readable.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { toolRouter } from '../core/tool-router.js';
import { geocode, describeSatellite, CATEGORIES, famousHint, HISTORIC } from './globe-data.js';
import { loadCatalog, propagate, historicCatalog, propagateHistoric, searchByName, findISS } from './satellites.js';
import { mountSatModel } from './satmodel.js';

const CONFIG = window.GZOWO_CONFIG || {};
const CESIUM_VER = '1.123.0';
const CESIUM_BASE = 'https://cdn.jsdelivr.net/npm/cesium@' + CESIUM_VER + '/Build/Cesium/';
const ESRI_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const NASA_ISS_VIDEO = 'https://www.youtube.com/embed/H999s0P1Er0?autoplay=1&mute=1';

let Cesium = null;
let viewer = null;
let layer = null;
let active = false;
let cesiumLoading = null;

// Satellite layer
let satCatalog = [];
let histCatalog = [];
let satEntities = [];
let satsOn = false;
const visibleCats = new Set(Object.keys(CATEGORIES));   // all types shown by default
let issEntity = null;
const satCache = new Map();

// Planes layer
let planesOn = false;
let planeTimer = 0;
let planeEntities = new Map();
const planeFilter = { commercial: true, military: true };
let planeCount = 0, planeMil = 0;

// ---------------------------------------------------------------------------
// Lazy Cesium loader
// ---------------------------------------------------------------------------
function loadCesium() {
  if (Cesium) return Promise.resolve(Cesium);
  if (cesiumLoading) return cesiumLoading;
  cesiumLoading = new Promise((resolve, reject) => {
    window.CESIUM_BASE_URL = CESIUM_BASE;
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = CESIUM_BASE + 'Widgets/widgets.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = CESIUM_BASE + 'Cesium.js';
    s.onload = () => { Cesium = window.Cesium; Cesium ? resolve(Cesium) : reject(new Error('Cesium global missing')); };
    s.onerror = () => reject(new Error('Cesium script failed to load'));
    document.head.appendChild(s);
  });
  return cesiumLoading;
}

async function ionToken() {
  const cfgTok = (CONFIG.cesium && CONFIG.cesium.ionToken) || '';
  if (cfgTok) return cfgTok;
  const base = ((CONFIG.bridge && CONFIG.bridge.url) || '').replace(/\/$/, '');
  if (!base) return '';
  try { const r = await fetch(base + '/cesium-token'); if (r.ok) { const d = await r.json(); return d.token || ''; } }
  catch (_e) { /* no bridge */ }
  return '';
}

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// HUD (exactly two sections + triggered panel/video)
// ---------------------------------------------------------------------------
function buildLayer() {
  layer = document.getElementById('globe-layer');
  if (!layer) { layer = document.createElement('div'); layer.id = 'globe-layer'; document.body.appendChild(layer); }
  layer.innerHTML =
    '<div id="globe-canvas"></div>' +
    '<div id="globe-sats" class="gl-hud"></div>' +
    '<div id="globe-planes" class="gl-hud"></div>' +
    '<div id="globe-panel" hidden></div>' +
    '<div id="globe-video" hidden></div>';
  renderSatsSection();
  renderPlanesSection();
  return layer;
}

// SATELITY (bottom-left): master toggle + per-type filter checkboxes.
function renderSatsSection() {
  const el = layer.querySelector('#globe-sats');
  const rows = Object.entries(CATEGORIES).map(([key, c]) =>
    `<label class="gl-flt"><input type="checkbox" data-cat="${key}" ${visibleCats.has(key) ? 'checked' : ''}>` +
    `<span class="gl-dot" style="background:${c.color}"></span>${escapeHTML(c.label)}</label>`
  ).join('');
  el.innerHTML =
    `<div class="gl-sec-head"><span>SATELITY</span>` +
    `<button class="gl-switch ${satsOn ? 'on' : ''}" data-role="sat-toggle">${satsOn ? 'ON' : 'OFF'}</button></div>` +
    `<div class="gl-filters" ${satsOn ? '' : 'hidden'}>${rows}</div>`;
  el.querySelector('[data-role="sat-toggle"]').addEventListener('click', () => setSatellites(!satsOn));
  el.querySelectorAll('input[data-cat]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) visibleCats.add(cb.dataset.cat); else visibleCats.delete(cb.dataset.cat);
    applySatFilter();
  }));
}

// SAMOLOTY (bottom-right): master toggle + commercial/military + live count.
function renderPlanesSection() {
  const el = layer.querySelector('#globe-planes');
  el.innerHTML =
    `<div class="gl-sec-head"><span>SAMOLOTY</span>` +
    `<button class="gl-switch ${planesOn ? 'on' : ''}" data-role="pl-toggle">${planesOn ? 'ON' : 'OFF'}</button></div>` +
    `<div class="gl-pl-body" ${planesOn ? '' : 'hidden'}>` +
      `<label class="gl-flt"><input type="checkbox" data-pl="commercial" ${planeFilter.commercial ? 'checked' : ''}><span class="gl-dot" style="background:#fff"></span>Komercyjne</label>` +
      `<label class="gl-flt"><input type="checkbox" data-pl="military" ${planeFilter.military ? 'checked' : ''}><span class="gl-dot" style="background:#ff6a3d"></span>Wojskowe <span class="gl-approx">(przybliżone)</span></label>` +
      `<div class="gl-count" data-role="pl-count">${planesOn ? planeCount + ' w powietrzu' : '—'}</div>` +
    `</div>`;
  el.querySelector('[data-role="pl-toggle"]').addEventListener('click', () => setPlanes(!planesOn));
  el.querySelectorAll('input[data-pl]').forEach((cb) => cb.addEventListener('change', () => {
    planeFilter[cb.dataset.pl] = cb.checked; applyPlaneFilter();
  }));
}

function updatePlanesCountUI() {
  const el = layer && layer.querySelector('[data-role="pl-count"]');
  if (el) el.textContent = planesOn ? (planeCount + ' w powietrzu' + (planeFilter.military && planeMil ? ' · ~' + planeMil + ' wojsk.' : '')) : '—';
}

// Auto-hide: HUD shows only when the whole Earth is in view; smooth-hides when
// zoomed into a place. computeViewRectangle() returns undefined when the full
// globe is visible — that's our "whole earth" signal (plus a height guard).
function updateHudVisibility() {
  if (!viewer) return;
  let whole;
  try { whole = !viewer.camera.computeViewRectangle() || cameraHeight() > 7_000_000; }
  catch (_e) { whole = true; }
  layer.classList.toggle('gl-far', !!whole);
}

// ---------------------------------------------------------------------------
// Show / hide (takeover)
// ---------------------------------------------------------------------------
async function showGlobe() {
  if (active) return { ok: true, already: true };
  try { await loadCesium(); }
  catch (e) { return { ok: false, error: 'Nie udało się załadować silnika globu (Cesium): ' + (e.message || e) }; }

  buildLayer();
  document.body.dataset.globe = 'on';
  active = true;

  const gkey = (CONFIG.google3d && CONFIG.google3d.key) || '';
  const ionTok = gkey ? '' : await ionToken();
  if (ionTok) { try { Cesium.Ion.defaultAccessToken = ionTok; } catch (_e) { /* ignore */ } }

  const canvasEl = layer.querySelector('#globe-canvas');
  viewer = new Cesium.Viewer(canvasEl, {
    baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
    infoBox: false, selectionIndicator: false, requestRenderMode: false, baseLayer: false,
    contextOptions: { webgl: { powerPreference: 'high-performance' } }
  });
  viewer.cesiumWidget.creditContainer.style.display = 'none';
  viewer.scene.globe.maximumScreenSpaceError = 2.2;
  viewer.resolutionScale = (window.devicePixelRatio || 1) >= 2 ? 0.85 : 1;

  // Earth in a black void — no stars, sun or moon (Jurek #4). Keep the thin
  // atmosphere glow (that's Earth, not the sky).
  try {
    viewer.scene.skyBox.show = false;
    viewer.scene.sun.show = false;
    viewer.scene.moon.show = false;
    viewer.scene.backgroundColor = Cesium.Color.BLACK;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.fog.enabled = true;
  } catch (_e) { /* older Cesium — non-fatal */ }

  // Imagery: Bing via ion when available, else free Esri.
  let usedEsri = true;
  if (ionTok) {
    try { viewer.imageryLayers.addImageryProvider(await Cesium.IonImageryProvider.fromAssetId(2)); usedEsri = false; }
    catch (e) { console.warn('[globe] ion imagery failed — Esri fallback', e); }
  }
  if (usedEsri) {
    try { viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: ESRI_URL, maximumLevel: 19, credit: 'Esri World Imagery' })); }
    catch (e) { console.warn('[globe] Esri imagery failed', e); }
  }

  // 3D layer.
  if (gkey) {
    try { viewer.scene.primitives.add(await Cesium.createGooglePhotorealistic3DTileset({ key: gkey })); bus.emit('toast', { text: '🌍 Google 3D (fototekstury).', kind: 'info' }); }
    catch (e) { console.warn('[globe] Google 3D failed', e); bus.emit('toast', { text: 'Google 3D niedostępne — płaskie zdjęcia.', kind: 'warn' }); }
  } else if (ionTok) {
    try { viewer.terrainProvider = await Cesium.createWorldTerrainAsync(); } catch (e) { console.warn('[globe] terrain failed', e); }
    try { viewer.scene.primitives.add(await Cesium.createOsmBuildingsAsync()); bus.emit('toast', { text: '🌍 Cesium ion: teren + budynki 3D.', kind: 'info' }); }
    catch (e) { console.warn('[globe] OSM buildings failed', e); }
  }

  viewer.screenSpaceEventHandler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (picked && picked.id && picked.id._satData) openSatPanel(picked.id._satData);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // HUD auto-hide follows the camera.
  viewer.camera.percentageChanged = 0.15;
  viewer.camera.changed.addEventListener(updateHudVisibility);
  viewer.camera.moveEnd.addEventListener(updateHudVisibility);

  viewer.camera.flyHome(0);
  updateHudVisibility();

  // Let the text chat live over the globe (Jurek #3).
  allowChatOnGlobe(true);

  bus.emit('globe:shown', {});
  return { ok: true };
}

function hideGlobe() {
  if (!active) return { ok: false, error: 'glob nie jest otwarty' };
  stopPlanes();
  allowChatOnGlobe(false);
  try { viewer && viewer.destroy(); } catch (_e) { /* ignore */ }
  viewer = null;
  satEntities = []; satsOn = false; issEntity = null;
  planeEntities = new Map(); satCache.clear();
  delete document.body.dataset.globe;
  if (layer) { try { layer.remove(); } catch (_e) { /* ignore */ } layer = null; }
  active = false;
  bus.emit('globe:hidden', {});
  return { ok: true };
}

// Keep the chat bubble usable over the globe: unhidden + on top; re-evaluate so
// it shows if Jurek is in a text mode.
function allowChatOnGlobe(on) {
  const cb = document.getElementById('chat-bubble');
  if (cb) cb.classList.toggle('over-globe', !!on);
  try { bus.emit('state:change', {}); } catch (_e) { /* chat re-evaluates visibility */ }
}

window.addEventListener('keydown', (e) => { if (active && e.key === 'Escape') hideGlobe(); });

// ---------------------------------------------------------------------------
// Camera helpers
// ---------------------------------------------------------------------------
function cameraHeight() { try { return viewer.camera.positionCartographic.height; } catch (_e) { return Infinity; } }
function isWholeGlobe() { return cameraHeight() > 3_000_000; }

function flyOblique(lat, lon, viewH) {
  const dLat = viewH / 111320;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat - dLat, viewH),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 }, duration: 2.5
  });
}
function flyTopDown(lat, lon, viewH, duration = 2.5) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, viewH),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 }, duration
  });
}
function heightForType(type) {
  if (/city|town|administrative|state|country/.test(String(type || ''))) return 9000;
  if (/suburb|neighbourhood|quarter|village/.test(String(type || ''))) return 3500;
  return 700;
}

// ---------------------------------------------------------------------------
// Satellites
// ---------------------------------------------------------------------------
async function ensureCatalog() {
  if (satCatalog.length) return;
  histCatalog = historicCatalog();
  try { satCatalog = await loadCatalog(); } catch (e) { console.warn('[globe] catalog load failed', e); satCatalog = []; }
}

function satCartesian(entry, jsDate) {
  const now = Date.now();
  const cached = satCache.get(entry.id);
  if (cached && now - cached.t < 1500) return cached.cart;
  const geo = entry.reconstruction ? propagateHistoric(entry, jsDate) : propagate(entry, jsDate);
  if (!geo) return cached ? cached.cart : Cesium.Cartesian3.fromDegrees(0, 0, 0);
  const cart = Cesium.Cartesian3.fromDegrees(geo.lon, geo.lat, geo.altKm * 1000);
  satCache.set(entry.id, { t: now, cart });
  return cart;
}

function applySatFilter() {
  for (const e of satEntities) {
    const cat = e._satData ? e._satData.category : 'other';
    e.show = satsOn && visibleCats.has(cat);
  }
  if (layer) { const f = layer.querySelector('#globe-sats .gl-filters'); if (f) f.hidden = !satsOn; }
}

async function setSatellites(on) {
  if (on) {
    if (!isWholeGlobe()) viewer.camera.flyHome(1.2);   // sats only make sense from orbit-out
    await ensureCatalog();
    if (!satEntities.length) {
      const all = [...satCatalog, ...histCatalog];
      for (const entry of all) {
        const ent = viewer.entities.add({
          position: new Cesium.CallbackProperty(() => satCartesian(entry, Cesium.JulianDate.toDate(viewer.clock.currentTime)), false),
          point: {
            pixelSize: entry.reconstruction ? 11 : 9,              // bigger dots (Jurek #2)
            color: Cesium.Color.fromCssColorString(entry.color),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.5), outlineWidth: 1,
            scaleByDistance: new Cesium.NearFarScalar(8.0e5, 1.7, 6.0e7, 0.9),   // stay visible from far
            disableDepthTestDistance: 0
          }
        });
        ent._satData = entry;
        satEntities.push(ent);
      }
    }
    satsOn = true;
  } else {
    satsOn = false;
  }
  applySatFilter();
  renderSatsSection();
  return { ok: true, on: satsOn, count: satEntities.length, visible_types: [...visibleCats] };
}

// ---------------------------------------------------------------------------
// Satellite detail panel
// ---------------------------------------------------------------------------
let disposeModel = null;
async function openSatPanel(entry) {
  const panel = layer.querySelector('#globe-panel');
  panel.hidden = false;
  const meta = entry.meta || {};
  const wikiTitle = meta.wiki || (famousHint(entry.name) || {}).wiki || entry.name;
  panel.innerHTML =
    '<button class="gl-panel-close">✕</button>' +
    `<div class="gl-panel-name">${escapeHTML(entry.name)}</div>` +
    `<div class="gl-panel-cat">${escapeHTML((CATEGORIES[entry.category] || CATEGORIES.other).label)}</div>` +
    '<div class="gl-panel-model" id="gl-model"></div>' +
    `<div class="gl-panel-desc" id="gl-desc">${entry.reconstruction && meta.note ? escapeHTML(meta.note) : 'Ładuję opis…'}</div>` +
    '<div class="gl-panel-data" id="gl-data"></div>';
  panel.querySelector('.gl-panel-close').addEventListener('click', closeSatPanel);

  const dataEl = panel.querySelector('#gl-data');
  if (!entry.reconstruction) {
    const geo = propagate(entry, new Date());
    if (geo) dataEl.innerHTML = `<div><b>NORAD</b> ${escapeHTML(entry.id)}</div><div><b>Wysokość</b> ${Math.round(geo.altKm)} km</div><div><b>Pozycja</b> ${geo.lat.toFixed(1)}°, ${geo.lon.toFixed(1)}°</div>`;
  } else { dataEl.innerHTML = '<div><i>Orbita rekonstrukcyjna (przybliżona)</i></div>'; }

  if (disposeModel) { try { disposeModel(); } catch (_e) {} disposeModel = null; }
  try { disposeModel = await mountSatModel(panel.querySelector('#gl-model'), { variant: entry.category }); }
  catch (_e) { panel.querySelector('#gl-model').textContent = '(model 3D niedostępny)'; }

  if (!(entry.reconstruction && meta.note)) {
    const sum = await describeSatellite(wikiTitle);
    const descEl = panel.querySelector('#gl-desc');
    if (descEl) descEl.textContent = sum ? sum.extract : 'Brak opisu w Wikipedii.';
  }
}
function closeSatPanel() {
  const panel = layer && layer.querySelector('#globe-panel');
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
  if (disposeModel) { try { disposeModel(); } catch (_e) {} disposeModel = null; }
}

// ---------------------------------------------------------------------------
// ISS
// ---------------------------------------------------------------------------
async function showISS(withVideo) {
  await ensureCatalog();
  const iss = findISS(satCatalog);
  if (!iss) return { ok: false, error: 'Nie znalazłem ISS w katalogu (CelesTrak offline?).' };
  if (!issEntity && !satsOn) {
    issEntity = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => satCartesian(iss, Cesium.JulianDate.toDate(viewer.clock.currentTime)), false),
      point: { pixelSize: 12, color: Cesium.Color.fromCssColorString(CATEGORIES.stations.color), outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
      label: { text: 'ISS', font: '12px monospace', pixelOffset: new Cesium.Cartesian2(0, -18), fillColor: Cesium.Color.WHITE }
    });
    issEntity._satData = iss;
  }
  const geo = propagate(iss, new Date());
  if (geo) flyTopDown(geo.lat, geo.lon, 6_000_000, 2.5);
  if (withVideo) openVideo(NASA_ISS_VIDEO, 'ISS — LIVE (NASA)');
  return { ok: true, position: geo ? { lat: +geo.lat.toFixed(2), lon: +geo.lon.toFixed(2), altKm: Math.round(geo.altKm) } : null, video: !!withVideo };
}
function openVideo(src, title) {
  const v = layer.querySelector('#globe-video');
  v.hidden = false;
  v.innerHTML = `<button class="gl-video-close">✕</button><div class="gl-video-title">${escapeHTML(title)}</div><iframe src="${src}" allow="autoplay; encrypted-media" allowfullscreen frameborder="0"></iframe>`;
  v.querySelector('.gl-video-close').addEventListener('click', () => { v.hidden = true; v.innerHTML = ''; });
}

// ---------------------------------------------------------------------------
// Gzowo plot (static top-down)
// ---------------------------------------------------------------------------
function showDzialka() {
  const g = CONFIG.gzowo || { lat: 52.612778, lon: 21.116028 };
  flyTopDown(g.lat, g.lon, 900, 3);
  bus.emit('toast', { text: '📍 Działka Gzowo — zdjęcie (nie live).', kind: 'info' });
  return { ok: true, note: 'Statyczne zdjęcie lotnicze (nie live).', lat: g.lat, lon: g.lon };
}

// ---------------------------------------------------------------------------
// Planes (OpenSky via bridge /proxy). Commercial vs military (approx heuristic).
// ---------------------------------------------------------------------------
const MIL_CALLSIGN = /^(RCH|REACH|RRR|ASCOT|CFC|IAM|CTM|GAF|NAF|BAF|FAF|HAF|PLF|POLICE|RESCUE|NATO|MMF|DUKE|SLAM|VV|VM|LOBO|GRZLY|HOBO)/i;
function isMilitary(icao24, callsign) {
  const cs = String(callsign || '').trim().toUpperCase();
  if (cs && MIL_CALLSIGN.test(cs)) return true;
  const hex = parseInt(String(icao24 || ''), 16);
  if (Number.isFinite(hex) && hex >= 0xADF7C8 && hex <= 0xAFFFFF) return true; // US mil block
  return false;
}
function applyPlaneFilter() {
  let shown = 0;
  for (const [, ent] of planeEntities) {
    const show = ent._mil ? planeFilter.military : planeFilter.commercial;
    ent.show = show;
    if (show) shown++;
  }
  planeCount = shown;
  updatePlanesCountUI();
}
async function pollPlanes() {
  if (!active || !planesOn) return;
  let rect; try { rect = viewer.camera.computeViewRectangle(); } catch (_e) { rect = null; }
  if (!rect) return;
  const q = 'lamin=' + Cesium.Math.toDegrees(rect.south).toFixed(3) + '&lomin=' + Cesium.Math.toDegrees(rect.west).toFixed(3) +
    '&lamax=' + Cesium.Math.toDegrees(rect.north).toFixed(3) + '&lomax=' + Cesium.Math.toDegrees(rect.east).toFixed(3);
  const target = 'https://opensky-network.org/api/states/all?' + q;
  const base = ((CONFIG.bridge && CONFIG.bridge.url) || '').replace(/\/$/, '');
  const url = base ? base + '/proxy?url=' + encodeURIComponent(target) : target;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const text = await res.text();
    if (text.includes('gz-proxy-error')) return;
    let data; try { data = JSON.parse(text); } catch (_e) { return; }
    const states = Array.isArray(data.states) ? data.states.slice(0, 500) : [];
    const seen = new Set();
    let mil = 0;
    for (const s of states) {
      const icao = s[0]; const lon = s[5]; const lat = s[6]; const alt = s[7] || s[13] || 0;
      if (lon == null || lat == null) continue;
      seen.add(icao);
      const cart = Cesium.Cartesian3.fromDegrees(lon, lat, (alt || 0) + 200);
      const m = isMilitary(icao, s[1]);
      if (m) mil++;
      let ent = planeEntities.get(icao);
      if (!ent) {
        ent = viewer.entities.add({ position: cart, point: { pixelSize: 5, color: m ? Cesium.Color.fromCssColorString('#ff6a3d') : Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK.withAlpha(0.5), outlineWidth: 1 } });
        ent._mil = m;
        planeEntities.set(icao, ent);
      } else { ent.position = cart; ent._mil = m; }
    }
    for (const [icao, ent] of planeEntities) { if (!seen.has(icao)) { try { viewer.entities.remove(ent); } catch (_e) {} planeEntities.delete(icao); } }
    planeMil = mil;
    applyPlaneFilter();
  } catch (_e) { /* rate-limited / offline */ }
}
function setPlanes(on) {
  if (on) {
    if (planesOn) { renderPlanesSection(); return { ok: true, on: true, count: planeCount }; }
    planesOn = true; pollPlanes(); planeTimer = setInterval(pollPlanes, 13000);
  } else { stopPlanes(); }
  renderPlanesSection();
  return { ok: true, on: planesOn, count: planeCount };
}
function stopPlanes() {
  planesOn = false;
  if (planeTimer) { clearInterval(planeTimer); planeTimer = 0; }
  for (const [, ent] of planeEntities) { try { viewer && viewer.entities.remove(ent); } catch (_e) {} }
  planeEntities = new Map(); planeCount = 0; planeMil = 0;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const EMPTY = { type: 'object', properties: {}, required: [] };
function needGlobe() { return active ? null : { ok: false, error: 'Najpierw otwórz glob (show_globe / „pokaż glob").' }; }

export async function init() {
  toolRouter.registerTool(
    { name: 'show_globe', description: 'Włącza TRYB GLOBUS: awatar zamienia się w interaktywny globus (Ziemia w czarnej pustce) na całym ekranie — obracasz/zoomujesz myszą i głosem. Widgety chowają się, czat zostaje. „pokaż glob/globus/Ziemię".', parameters: EMPTY },
    async () => showGlobe()
  );
  toolRouter.registerTool(
    { name: 'hide_globe', description: 'Wyłącza tryb globu i wraca do awatara. „schowaj glob".', parameters: EMPTY },
    async () => hideGlobe()
  );

  toolRouter.registerTool(
    { name: 'globe_fly_to', description: 'Leci globem do miejsca pod kątem ~45° (jak Google Earth). Miasta, dzielnice, ADRESY z numerem („Warszawa", „Mokotów", „Tyniecka 31"). Działa też do doprecyzowania z aktualnego widoku.', parameters: { type: 'object', properties: { place: { type: 'string', description: 'Nazwa miejsca lub adres.' } }, required: ['place'] } },
    async ({ place }) => { const g = needGlobe(); if (g) return g; const loc = await geocode(place); if (!loc) return { ok: false, error: 'Nie znalazłem miejsca „' + String(place || '').trim() + '".' }; flyOblique(loc.lat, loc.lon, heightForType(loc.type)); return { ok: true, place: loc.name, lat: +loc.lat.toFixed(4), lon: +loc.lon.toFixed(4) }; }
  );

  toolRouter.registerTool(
    { name: 'globe_camera', description: 'Steruje kamerą globu głosem. action: orbit_left/orbit_right/orbit_up/orbit_down/zoom_in/zoom_out/tilt. amount: „trochę"/„średnio"/„bardzo".', parameters: { type: 'object', properties: { action: { type: 'string', description: 'orbit_left|orbit_right|orbit_up|orbit_down|zoom_in|zoom_out|tilt' }, amount: { type: 'string', description: 'trochę | średnio | bardzo' } }, required: ['action'] } },
    async ({ action, amount }) => {
      const g = needGlobe(); if (g) return g;
      const a = { 'trochę': 1, 'troche': 1, 'średnio': 2, 'srednio': 2, 'bardzo': 3.5 }[String(amount || 'średnio').toLowerCase()] || 2;
      const cam = viewer.camera; const rad = Cesium.Math.toRadians(12 * a); const dist = cameraHeight();
      try {
        switch (String(action)) {
          case 'orbit_left': cam.rotateRight(-rad); break;
          case 'orbit_right': cam.rotateRight(rad); break;
          case 'orbit_up': cam.rotateUp(rad); break;
          case 'orbit_down': cam.rotateUp(-rad); break;
          case 'zoom_in': cam.zoomIn(dist * 0.3 * a); break;
          case 'zoom_out': cam.zoomOut(dist * 0.3 * a); break;
          case 'tilt': cam.lookUp(rad); break;
          default: return { ok: false, error: 'nieznana akcja: ' + action };
        }
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
      updateHudVisibility();
      return { ok: true, action, amount: amount || 'średnio' };
    }
  );

  toolRouter.registerTool(
    {
      name: 'globe_satellites',
      description: 'Sekcja SATELITY (lewy dół): włącz/wyłącz warstwę i USTAW które TYPY widać (filtry). ' +
        'on: true/false. types: lista typów do pokazania — stations, starlink, gnss, weather, science, geo, historic, other (albo „all"/„none"). ' +
        'Satelity widać tylko z widoku całego globu; przy włączaniu z bliska sam oddalę kamerę. Kropki są kolorowane wg typu.',
      parameters: { type: 'object', properties: { on: { type: 'boolean' }, types: { type: 'array', items: { type: 'string' }, description: 'Typy do pokazania lub ["all"]/["none"].' } }, required: [] }
    },
    async ({ on, types }) => {
      const g = needGlobe(); if (g) return g;
      if (Array.isArray(types)) {
        const keys = Object.keys(CATEGORIES);
        visibleCats.clear();
        if (types.length === 1 && types[0] === 'all') keys.forEach((k) => visibleCats.add(k));
        else if (types.length === 1 && types[0] === 'none') { /* leave empty */ }
        else types.map((t) => String(t).toLowerCase()).filter((t) => keys.includes(t)).forEach((t) => visibleCats.add(t));
      }
      const res = await setSatellites(on === undefined ? (satsOn || true) : !!on);
      if (Array.isArray(types)) { applySatFilter(); renderSatsSection(); }
      return { ...res, visible_types: [...visibleCats] };
    }
  );

  toolRouter.registerTool(
    { name: 'globe_show_satellite', description: 'Otwiera panel satelity (Nazwa, opis z Wikipedii, model 3D do obracania, dane orbity). Nazwa: „Hubble", „ISS", „Sputnik", „Starlink". Można też kliknąć kropkę.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    async ({ name }) => {
      const g = needGlobe(); if (g) return g;
      await ensureCatalog();
      let entry = searchByName(satCatalog, histCatalog, name);
      if (!entry) { const h = HISTORIC.find((x) => x.name.toLowerCase().includes(String(name || '').toLowerCase())); if (h) entry = { id: 'museum', name: h.name, category: 'historic', color: CATEGORIES.historic.color, reconstruction: true, meta: h }; }
      if (!entry) return { ok: false, error: 'Nie mam satelity „' + String(name || '').trim() + '" w katalogu.' };
      await openSatPanel(entry);
      return { ok: true, satellite: entry.name };
    }
  );

  toolRouter.registerTool(
    { name: 'globe_iss', description: 'Pokazuje ISS: leci do jej pozycji; z video:true otwiera darmowy live-stream NASA.', parameters: { type: 'object', properties: { video: { type: 'boolean' } }, required: [] } },
    async ({ video }) => { const g = needGlobe(); if (g) return g; return showISS(!!video); }
  );

  toolRouter.registerTool(
    { name: 'globe_dzialka', description: 'Pokazuje działkę w Gzowie z góry (statyczne zdjęcie — NIE live).', parameters: EMPTY },
    async () => { const g = needGlobe(); if (g) return g; return showDzialka(); }
  );

  toolRouter.registerTool(
    {
      name: 'globe_planes',
      description: 'Sekcja SAMOLOTY (prawy dół): włącz/wyłącz live samoloty (OpenSky, w granicach widoku) + filtr komercyjne/wojskowe. ' +
        'on: true/false. types: ["commercial"], ["military"] albo oba. Wojskowe są PRZYBLIŻONE (heurystyka callsign/hex — darmowo nie ma pewnego źródła). Zwraca liczbę w powietrzu.',
      parameters: { type: 'object', properties: { on: { type: 'boolean' }, types: { type: 'array', items: { type: 'string' }, description: 'commercial | military (oba = pokaż wszystkie).' } }, required: [] }
    },
    async ({ on, types }) => {
      const g = needGlobe(); if (g) return g;
      if (Array.isArray(types)) { planeFilter.commercial = types.map((t) => String(t).toLowerCase()).includes('commercial'); planeFilter.military = types.map((t) => String(t).toLowerCase()).includes('military'); if (!planeFilter.commercial && !planeFilter.military) { planeFilter.commercial = planeFilter.military = true; } }
      const res = setPlanes(on === undefined ? (planesOn || true) : !!on);
      if (Array.isArray(types)) { applyPlaneFilter(); renderPlanesSection(); }
      return { ...res, in_air: planeCount, military_approx: planeMil, types: { commercial: planeFilter.commercial, military: planeFilter.military } };
    }
  );

  toolRouter.registerTool(
    { name: 'globe_status', description: 'Zwraca aktualny stan trybu globu: czy otwarty, wysokość/widok kamery, stan sekcji SATELITY (on + widoczne typy) i SAMOLOTY (on + liczba w powietrzu + filtry). Użyj, gdy Jurek pyta „co jest włączone na globie".', parameters: EMPTY },
    async () => ({
      ok: true, open: active,
      view: active ? (isWholeGlobe() ? 'caly-glob' : 'zblizenie') : null,
      satellites: { on: satsOn, visible_types: [...visibleCats], loaded: satEntities.length },
      planes: { on: planesOn, in_air: planeCount, military_approx: planeMil, commercial: planeFilter.commercial, military: planeFilter.military }
    })
  );

  console.info('[globe] ready — spatial tools registered');
}
