// js/globe/globe.js — GLOBE ("Spatial") mode. Cesium takeover: the avatar becomes
// an interactive Google-Earth-like globe, driven by voice + mouse. FREE Esri base
// imagery; Google Photorealistic 3D Tiles when config.google3d.key is set (else
// honest fallback to Esri). Layers: satellites (CelesTrak TLE + satellite.js,
// colour-coded), ISS (position + NASA video), planes (OpenSky), static Gzowo plot.
//
// Cesium is loaded LAZILY (only on first show_globe) so it never touches boot.
// Everything degrades honestly; every tool returns a real result. English code.

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
const NASA_ISS_VIDEO = 'https://www.youtube.com/embed/H999s0P1Er0?autoplay=1&mute=1'; // NASA ISS live

let Cesium = null;         // set after lazy load
let viewer = null;
let layer = null;          // #globe-layer overlay
let active = false;
let cesiumLoading = null;  // in-flight load promise

// Layer state
let satCatalog = [];       // live sats
let histCatalog = [];      // reconstruction sats
let satEntities = [];      // Cesium entities for sats
let satsOn = false;
let planesOn = false;
let planeTimer = 0;
let planeEntities = new Map();
let issEntity = null;
const satCache = new Map(); // id -> {t, cart}

// ---------------------------------------------------------------------------
// Lazy Cesium loader (UMD build via <script>, needs CESIUM_BASE_URL + CSS).
// ---------------------------------------------------------------------------
function loadCesium() {
  if (Cesium) return Promise.resolve(Cesium);
  if (cesiumLoading) return cesiumLoading;
  cesiumLoading = new Promise((resolve, reject) => {
    window.CESIUM_BASE_URL = CESIUM_BASE;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = CESIUM_BASE + 'Widgets/widgets.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = CESIUM_BASE + 'Cesium.js';
    s.onload = () => { Cesium = window.Cesium; Cesium ? resolve(Cesium) : reject(new Error('Cesium global missing')); };
    s.onerror = () => reject(new Error('Cesium script failed to load'));
    document.head.appendChild(s);
  });
  return cesiumLoading;
}

// Cesium ion token: config (public, usually empty) OR the bridge /cesium-token
// (local, keeps the token out of the public repo). Empty -> free Esri only.
async function ionToken() {
  const cfgTok = (CONFIG.cesium && CONFIG.cesium.ionToken) || '';
  if (cfgTok) return cfgTok;
  const base = ((CONFIG.bridge && CONFIG.bridge.url) || '').replace(/\/$/, '');
  if (!base) return '';
  try {
    const r = await fetch(base + '/cesium-token');
    if (r.ok) { const d = await r.json(); return d.token || ''; }
  } catch (_e) { /* no bridge */ }
  return '';
}

// ---------------------------------------------------------------------------
// Overlay + HUD
// ---------------------------------------------------------------------------
function buildLayer() {
  layer = document.getElementById('globe-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'globe-layer';
    document.body.appendChild(layer);
  }
  layer.innerHTML =
    '<div id="globe-canvas"></div>' +
    '<button id="globe-exit" title="Schowaj glob (Esc)">✕ SCHOWAJ GLOB</button>' +
    '<div id="globe-legend" hidden></div>' +
    '<div id="globe-panel" hidden></div>' +
    '<div id="globe-video" hidden></div>';
  layer.querySelector('#globe-exit').addEventListener('click', () => hideGlobe());
  return layer;
}

function renderLegend() {
  const el = layer.querySelector('#globe-legend');
  if (!satsOn) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<div class="gl-legend-title">SATELITY</div>' +
    Object.values(CATEGORIES).map((c) =>
      `<div class="gl-legend-row"><span class="gl-dot" style="background:${c.color}"></span>${c.label}</div>`
    ).join('');
}

// ---------------------------------------------------------------------------
// Show / hide (takeover)
// ---------------------------------------------------------------------------
async function showGlobe() {
  if (active) { return { ok: true, already: true }; }
  try { await loadCesium(); }
  catch (e) { return { ok: false, error: 'Nie udało się załadować silnika globu (Cesium): ' + (e.message || e) }; }

  buildLayer();
  document.body.dataset.globe = 'on';           // CSS hides widgets/avatar/islands
  active = true;

  // 3D source precedence: Google Photorealistic (needs key+card) > Cesium ion
  // (terrain + OSM buildings + Bing imagery, free/no-card) > free Esri flat.
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
  // Chrome-free + performance tuning for a 2019 Intel Mac (smoothness > detail).
  viewer.cesiumWidget.creditContainer.style.display = 'none';
  viewer.scene.globe.maximumScreenSpaceError = 2.2;   // higher = fewer tiles
  viewer.resolutionScale = Math.min(1, (window.devicePixelRatio || 1) >= 2 ? 0.85 : 1);
  viewer.scene.fog.enabled = true;
  viewer.scene.skyAtmosphere.show = true;

  // Imagery: Bing aerial via ion when we have a token, else free Esri.
  let usedEsri = true;
  if (ionTok) {
    try {
      viewer.imageryLayers.addImageryProvider(await Cesium.IonImageryProvider.fromAssetId(2)); // Bing Aerial
      usedEsri = false;
    } catch (e) { console.warn('[globe] ion imagery failed — Esri fallback', e); }
  }
  if (usedEsri) {
    try {
      viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: ESRI_URL, maximumLevel: 19, credit: 'Esri World Imagery'
      }));
    } catch (e) { console.warn('[globe] Esri imagery failed', e); }
  }

  // 3D layer.
  if (gkey) {
    // Premium: Google Photorealistic 3D Tiles (textured buildings).
    try {
      const tileset = await Cesium.createGooglePhotorealistic3DTileset({ key: gkey });
      viewer.scene.primitives.add(tileset);
      bus.emit('toast', { text: '🌍 Google 3D Tiles (fototekstury) włączone.', kind: 'info' });
    } catch (e) {
      console.warn('[globe] Google 3D tiles failed — flat imagery', e);
      bus.emit('toast', { text: 'Google 3D niedostępne (klucz/quota) — płaskie zdjęcia.', kind: 'warn' });
    }
  } else if (ionTok) {
    // Free (no card): real terrain + global OSM 3D building shapes.
    try { viewer.terrainProvider = await Cesium.createWorldTerrainAsync(); }
    catch (e) { console.warn('[globe] world terrain failed', e); }
    try {
      const osm = await Cesium.createOsmBuildingsAsync();
      viewer.scene.primitives.add(osm);
      bus.emit('toast', { text: '🌍 Cesium ion: teren + budynki 3D (bez fototekstur).', kind: 'info' });
    } catch (e) { console.warn('[globe] OSM buildings failed', e); }
  }

  // Pointer pick -> satellite panel.
  viewer.screenSpaceEventHandler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (picked && picked.id && picked.id._satData) openSatPanel(picked.id._satData);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Start on the whole globe.
  viewer.camera.flyHome(0);

  bus.emit('globe:shown', {});
  return { ok: true };
}

function hideGlobe() {
  if (!active) return { ok: false, error: 'glob nie jest otwarty' };
  stopPlanes();
  try { viewer && viewer.destroy(); } catch (_e) { /* ignore */ }
  viewer = null;
  satEntities = []; satsOn = false; planesOn = false; issEntity = null;
  planeEntities = new Map(); satCache.clear();
  delete document.body.dataset.globe;
  if (layer) { try { layer.remove(); } catch (_e) { /* ignore */ } layer = null; }
  active = false;
  bus.emit('globe:hidden', {});
  return { ok: true };
}

// Esc closes globe.
window.addEventListener('keydown', (e) => { if (active && e.key === 'Escape') hideGlobe(); });

// ---------------------------------------------------------------------------
// Camera helpers
// ---------------------------------------------------------------------------
function cameraHeight() {
  try { return viewer.camera.positionCartographic.height; } catch (_e) { return Infinity; }
}
function isWholeGlobe() { return cameraHeight() > 3_000_000; }   // >3000 km ~ whole globe

// Fly to a lat/lon with a Google-Earth oblique (~45°) framing on the point.
function flyOblique(lat, lon, viewH) {
  const H = viewH;
  const dLat = H / 111320;                       // metres south -> degrees (tan45=1)
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat - dLat, H),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 2.5
  });
}
function flyTopDown(lat, lon, viewH, duration = 2.5) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, viewH),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration
  });
}

// Pick a view height from the place type (city vs street address).
function heightForType(type) {
  if (/city|town|administrative|state|country/.test(String(type || ''))) return 9000;
  if (/suburb|neighbourhood|quarter|village/.test(String(type || ''))) return 3500;
  return 700; // street / house / poi
}

// ---------------------------------------------------------------------------
// Satellites layer
// ---------------------------------------------------------------------------
async function ensureCatalog() {
  if (satCatalog.length) return;
  histCatalog = historicCatalog();
  try { satCatalog = await loadCatalog(); }
  catch (e) { console.warn('[globe] catalog load failed', e); satCatalog = []; }
}

function satCartesian(entry, jsDate) {
  const now = Date.now();
  const cached = satCache.get(entry.id);
  if (cached && now - cached.t < 1500) return cached.cart;   // throttle SGP4
  const geo = entry.reconstruction ? propagateHistoric(entry, jsDate) : propagate(entry, jsDate);
  if (!geo) return cached ? cached.cart : Cesium.Cartesian3.fromDegrees(0, 0, 0);
  const cart = Cesium.Cartesian3.fromDegrees(geo.lon, geo.lat, geo.altKm * 1000);
  satCache.set(entry.id, { t: now, cart });
  return cart;
}

async function showSatellites(force) {
  if (!isWholeGlobe() && !force) {
    return { ok: false, need_zoom_out: true,
      message: 'Satelity widać tylko z widoku całego globu. Muszę się oddalić — zrobić to?' };
  }
  if (!isWholeGlobe()) viewer.camera.flyHome(1.5);
  await ensureCatalog();
  if (satsOn) { renderLegend(); return { ok: true, count: satEntities.length }; }

  const all = [...satCatalog, ...histCatalog];
  for (const entry of all) {
    const ent = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => satCartesian(entry, Cesium.JulianDate.toDate(viewer.clock.currentTime)), false),
      point: {
        pixelSize: entry.reconstruction ? 6 : 4,
        color: Cesium.Color.fromCssColorString(entry.color),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.4), outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1.4, 4.0e7, 0.5)
      }
    });
    ent._satData = entry;
    satEntities.push(ent);
  }
  satsOn = true;
  renderLegend();
  return { ok: true, count: satEntities.length };
}

function hideSatellites() {
  for (const e of satEntities) { try { viewer.entities.remove(e); } catch (_e) { /* ignore */ } }
  satEntities = []; satsOn = false;
  renderLegend();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Satellite detail panel (name + Wikipedia + real data + 3D model)
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

  // Real orbital data (live sats only).
  const dataEl = panel.querySelector('#gl-data');
  if (!entry.reconstruction) {
    const geo = propagate(entry, new Date());
    if (geo) {
      dataEl.innerHTML =
        `<div><b>NORAD</b> ${escapeHTML(entry.id)}</div>` +
        `<div><b>Wysokość</b> ${Math.round(geo.altKm)} km</div>` +
        `<div><b>Pozycja</b> ${geo.lat.toFixed(1)}°, ${geo.lon.toFixed(1)}°</div>`;
    }
  } else {
    dataEl.innerHTML = '<div><i>Orbita rekonstrukcyjna (przybliżona)</i></div>';
  }

  // 3D model.
  if (disposeModel) { try { disposeModel(); } catch (_e) {} disposeModel = null; }
  try { disposeModel = await mountSatModel(panel.querySelector('#gl-model'), { variant: entry.category }); }
  catch (e) { panel.querySelector('#gl-model').textContent = '(model 3D niedostępny)'; }

  // Wikipedia description (skip if we already showed a reconstruction note).
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

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// ISS
// ---------------------------------------------------------------------------
async function showISS(withVideo) {
  await ensureCatalog();
  const iss = findISS(satCatalog);
  if (!iss) return { ok: false, error: 'Nie znalazłem ISS w katalogu (CelesTrak offline?).' };
  if (!satsOn) {
    // add just the ISS entity if satellites aren't all shown
    if (!issEntity) {
      issEntity = viewer.entities.add({
        position: new Cesium.CallbackProperty(() => satCartesian(iss, Cesium.JulianDate.toDate(viewer.clock.currentTime)), false),
        point: { pixelSize: 9, color: Cesium.Color.fromCssColorString(CATEGORIES.stations.color), outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
        label: { text: 'ISS', font: '12px monospace', pixelOffset: new Cesium.Cartesian2(0, -16), fillColor: Cesium.Color.WHITE }
      });
      issEntity._satData = iss;
    }
  }
  const geo = propagate(iss, new Date());
  if (geo) flyTopDown(geo.lat, geo.lon, 6_000_000, 2.5);
  if (withVideo) openVideo(NASA_ISS_VIDEO, 'ISS — LIVE (NASA)');
  return { ok: true, position: geo ? { lat: +geo.lat.toFixed(2), lon: +geo.lon.toFixed(2), altKm: Math.round(geo.altKm) } : null, video: !!withVideo };
}

function openVideo(src, title) {
  const v = layer.querySelector('#globe-video');
  v.hidden = false;
  v.innerHTML = `<button class="gl-video-close">✕</button><div class="gl-video-title">${escapeHTML(title)}</div>` +
    `<iframe src="${src}" allow="autoplay; encrypted-media" allowfullscreen frameborder="0"></iframe>`;
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
// Planes (OpenSky, free) — within the current view bounds.
// ---------------------------------------------------------------------------
async function pollPlanes() {
  if (!active || !planesOn) return;
  let rect;
  try { rect = viewer.camera.computeViewRectangle(); } catch (_e) { rect = null; }
  if (!rect) return;
  const q = 'lamin=' + Cesium.Math.toDegrees(rect.south).toFixed(3) +
    '&lomin=' + Cesium.Math.toDegrees(rect.west).toFixed(3) +
    '&lamax=' + Cesium.Math.toDegrees(rect.north).toFixed(3) +
    '&lomax=' + Cesium.Math.toDegrees(rect.east).toFixed(3);
  // OpenSky sends no CORS headers -> route through the bridge /proxy (local only).
  const target = 'https://opensky-network.org/api/states/all?' + q;
  const base = ((CONFIG.bridge && CONFIG.bridge.url) || '').replace(/\/$/, '');
  const url = base ? base + '/proxy?url=' + encodeURIComponent(target) : target;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const text = await res.text();
    if (text.includes('gz-proxy-error')) return;
    let data; try { data = JSON.parse(text); } catch (_e) { return; }
    const states = Array.isArray(data.states) ? data.states.slice(0, 400) : [];
    const seen = new Set();
    for (const s of states) {
      const icao = s[0]; const lon = s[5]; const lat = s[6]; const alt = s[7] || s[13] || 0;
      if (lon == null || lat == null) continue;
      seen.add(icao);
      const cart = Cesium.Cartesian3.fromDegrees(lon, lat, (alt || 0) + 200);
      let ent = planeEntities.get(icao);
      if (!ent) {
        ent = viewer.entities.add({ position: cart, point: { pixelSize: 4, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK.withAlpha(0.5), outlineWidth: 1 } });
        planeEntities.set(icao, ent);
      } else { ent.position = cart; }
    }
    for (const [icao, ent] of planeEntities) {
      if (!seen.has(icao)) { try { viewer.entities.remove(ent); } catch (_e) {} planeEntities.delete(icao); }
    }
  } catch (_e) { /* rate-limited / offline — silent */ }
}
function startPlanes() {
  if (planesOn) return;
  planesOn = true;
  pollPlanes();
  planeTimer = setInterval(pollPlanes, 13000);
}
function stopPlanes() {
  planesOn = false;
  if (planeTimer) { clearInterval(planeTimer); planeTimer = 0; }
  for (const [, ent] of planeEntities) { try { viewer && viewer.entities.remove(ent); } catch (_e) {} }
  planeEntities = new Map();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const EMPTY = { type: 'object', properties: {}, required: [] };
function needGlobe() { return active ? null : { ok: false, error: 'Najpierw otwórz glob (show_globe / „pokaż glob").' }; }

export async function init() {
  toolRouter.registerTool(
    { name: 'show_globe', description: 'Włącza TRYB GLOBUS: awatar zamienia się w interaktywny, fotorealistyczny globus (Google-Earth-owy) na całym ekranie — można nim obracać/zoomować myszą i głosem. Widgety chowają się. Użyj na „pokaż glob/globus/Ziemię".', parameters: EMPTY },
    async () => showGlobe()
  );
  toolRouter.registerTool(
    { name: 'hide_globe', description: 'Wyłącza tryb globu i wraca do awatara (widgety wracają). „schowaj glob".', parameters: EMPTY },
    async () => hideGlobe()
  );

  toolRouter.registerTool(
    {
      name: 'globe_fly_to',
      description: 'Leci globem do miejsca i pokazuje je pod kątem ~45° (jak Google Earth). Przyjmuje miasta, dzielnice i ADRESY z numerem („Warszawa", „Mokotów", „Tyniecka 31"). Działa też do doprecyzowania z aktualnego widoku.',
      parameters: { type: 'object', properties: { place: { type: 'string', description: 'Nazwa miejsca lub adres.' } }, required: ['place'] }
    },
    async ({ place }) => {
      const g = needGlobe(); if (g) return g;
      const loc = await geocode(place);
      if (!loc) return { ok: false, error: 'Nie znalazłem miejsca „' + String(place || '').trim() + '".' };
      flyOblique(loc.lat, loc.lon, heightForType(loc.type));
      return { ok: true, place: loc.name, lat: +loc.lat.toFixed(4), lon: +loc.lon.toFixed(4) };
    }
  );

  toolRouter.registerTool(
    {
      name: 'globe_camera',
      description: 'Steruje kamerą globu głosem. action: orbit_left/orbit_right/orbit_up/orbit_down/zoom_in/zoom_out/tilt. amount: „trochę"/„średnio"/„bardzo".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'orbit_left|orbit_right|orbit_up|orbit_down|zoom_in|zoom_out|tilt' },
          amount: { type: 'string', description: 'trochę | średnio | bardzo' }
        },
        required: ['action']
      }
    },
    async ({ action, amount }) => {
      const g = needGlobe(); if (g) return g;
      const a = { 'trochę': 1, 'troche': 1, 'średnio': 2, 'srednio': 2, 'bardzo': 3.5 }[String(amount || 'średnio').toLowerCase()] || 2;
      const cam = viewer.camera;
      const rad = Cesium.Math.toRadians(12 * a);
      const dist = cameraHeight();
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
      return { ok: true, action, amount: amount || 'średnio' };
    }
  );

  toolRouter.registerTool(
    {
      name: 'globe_satellites',
      description: 'Włącza/wyłącza warstwę SATELIT na globie (kolorowe kropki wg typu: Starlink, GNSS, pogodowe, teleskopy, stacje, historyczne). Satelity widać TYLKO z widoku całego globu — gdy jesteś w mieście, narzędzie zwróci need_zoom_out:true (zapytaj Jurka „oddalić się?" i wywołaj ponownie z confirm_zoom_out:true).',
      parameters: {
        type: 'object',
        properties: {
          on: { type: 'boolean', description: 'true = pokaż, false = schowaj.' },
          confirm_zoom_out: { type: 'boolean', description: 'true = zgoda Jurka na oddalenie do widoku globu.' }
        },
        required: ['on']
      }
    },
    async ({ on, confirm_zoom_out }) => {
      const g = needGlobe(); if (g) return g;
      if (on === false) return hideSatellites();
      return showSatellites(!!confirm_zoom_out);
    }
  );

  toolRouter.registerTool(
    {
      name: 'globe_show_satellite',
      description: 'Otwiera panel wybranej satelity (Nazwa, Opis z Wikipedii, model 3D do obracania, dane orbity). Podaj nazwę („Hubble", „ISS", „Sputnik", „Starlink"). Można też kliknąć kropkę na globie.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'Nazwa satelity.' } }, required: ['name'] }
    },
    async ({ name }) => {
      const g = needGlobe(); if (g) return g;
      await ensureCatalog();
      let entry = searchByName(satCatalog, histCatalog, name);
      // fall back to a historic museum entry by fuzzy name
      if (!entry) {
        const h = HISTORIC.find((x) => x.name.toLowerCase().includes(String(name || '').toLowerCase()));
        if (h) entry = { id: 'museum', name: h.name, category: 'historic', color: CATEGORIES.historic.color, reconstruction: true, meta: h };
      }
      if (!entry) return { ok: false, error: 'Nie mam satelity „' + String(name || '').trim() + '" w katalogu.' };
      await openSatPanel(entry);
      return { ok: true, satellite: entry.name };
    }
  );

  toolRouter.registerTool(
    {
      name: 'globe_iss',
      description: 'Pokazuje Międzynarodową Stację Kosmiczną: leci do jej aktualnej pozycji na globie; z video:true otwiera darmowy live-stream NASA z ISS.',
      parameters: { type: 'object', properties: { video: { type: 'boolean', description: 'true = otwórz live wideo NASA.' } }, required: [] }
    },
    async ({ video }) => { const g = needGlobe(); if (g) return g; return showISS(!!video); }
  );

  toolRouter.registerTool(
    { name: 'globe_dzialka', description: 'Pokazuje działkę w Gzowie z góry (statyczne zdjęcie lotnicze — NIE live). „pokaż działkę/Gzowo z góry".', parameters: EMPTY },
    async () => { const g = needGlobe(); if (g) return g; return showDzialka(); }
  );

  toolRouter.registerTool(
    {
      name: 'globe_planes',
      description: 'Włącza/wyłącza live SAMOLOTY nad globem (OpenSky, darmowe) — w granicach aktualnego widoku.',
      parameters: { type: 'object', properties: { on: { type: 'boolean', description: 'true = pokaż, false = schowaj.' } }, required: ['on'] }
    },
    async ({ on }) => {
      const g = needGlobe(); if (g) return g;
      if (on === false) { stopPlanes(); return { ok: true, planes: 'off' }; }
      startPlanes();
      return { ok: true, planes: 'on' };
    }
  );

  console.info('[globe] ready — spatial tools registered');
}
