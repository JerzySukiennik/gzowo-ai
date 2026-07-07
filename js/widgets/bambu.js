// js/widgets/bambu.js — DRUKARKA · BAMBU X1C widget (Home Assistant, via bridge).
// Owns: bambuDef() factory + async init() (registers the widget + two tools).
//
// v2 law: printer STATUS + CAMERA come EXCLUSIVELY through the local bridge's
// /ha/* endpoints (bridgeClient.haBambu()) — never a direct HA URL, never the
// Bambu cloud. Until Jurek fills bridge/.env (HA_URL/HA_TOKEN/HA_BAMBU_PREFIX)
// every surface degrades HONESTLY (no fake data). COLOR: the single accent
// '#7fd18b' lives ONLY inside .widget-body (var(--widget-accent)); chrome is B&W.
//
// Contract honored:
//   - export function bambuDef() -> frozen def for layout.addWidget()
//   - export async function init() (idempotent, never throws)
//   - render(bodyEl, ctx) returns a cleanup fn that clears BOTH intervals + unsubs.
//   - Fully fluid DOM (%, no fixed widget px).

import { defineWidget, el } from './widget-base.js';
import { bus } from '../core/event-bus.js';
import { bridgeClient } from '../bridge-client.js';
import { toolRouter } from '../core/tool-router.js';
import { layout } from '../core/layout-engine.js';

const CONFIG = window.GZOWO_CONFIG;
const ACCENT = '#7fd18b';

const POLL_MS = 10000;      // status re-poll cadence while mounted
const CAM_OK_MS = 3000;     // camera snapshot refresh when the feed is healthy
const CAM_FAIL_MS = 10000;  // slower retry after the camera errors out

// --- Bridge URL helper (relative bridge path -> absolute) --------------------
function bridgeUrl(path) {
  const base = (CONFIG && CONFIG.bridge && CONFIG.bridge.url) || '';
  return base.replace(/\/$/, '') + path;
}

// --- haBambu() through the bridge only ---------------------------------------
// Contractually bridgeClient.haBambu() exists; guard defensively so a bridge
// client that predates HA support degrades as "offline" instead of throwing raw.
async function haBambu() {
  if (!bridgeClient || typeof bridgeClient.haBambu !== 'function') {
    throw { offline: true };
  }
  return bridgeClient.haBambu();
}

// ============================================================================
// Entity heuristics — HA friendly names differ, so match by suffix substrings.
// ============================================================================
/**
 * Find the first printer entity whose suffix key includes any needle and none
 * of the excludes. Returns {key, state, attributes} or null.
 */
function findEntity(printer, needles, exclude = []) {
  const keys = Object.keys(printer || {});
  for (const needle of needles) {
    const nk = needle.toLowerCase();
    const found = keys.find((k) => {
      const lk = k.toLowerCase();
      if (!lk.includes(nk)) return false;
      return !exclude.some((x) => lk.includes(x));
    });
    if (found) return { key: found, ...printer[found] };
  }
  return null;
}

function num(s) {
  const n = parseFloat(String(s));
  return Number.isFinite(n) ? n : NaN;
}

function cleanInt(s) {
  const n = num(s);
  return Number.isFinite(n) ? String(Math.round(n)) : null;
}

function clampPct(n) {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

// Translate a known print-status enum to friendly PL; fall back to raw upper.
function plStatus(raw) {
  const key = String(raw == null ? '' : raw).trim().toLowerCase();
  if (key === '' || key === 'unknown' || key === 'none') return null;
  const map = {
    idle: 'BEZCZYNNA', standby: 'BEZCZYNNA',
    running: 'DRUKUJE', printing: 'DRUKUJE', print: 'DRUKUJE',
    pause: 'PAUZA', paused: 'PAUZA',
    finish: 'GOTOWE', finished: 'GOTOWE', success: 'GOTOWE',
    complete: 'GOTOWE', completed: 'GOTOWE',
    fail: 'BŁĄD', failed: 'BŁĄD', error: 'BŁĄD',
    prepare: 'PRZYGOTOWANIE', preparing: 'PRZYGOTOWANIE', heating: 'NAGRZEWANIE',
    offline: 'OFFLINE', unavailable: 'NIEDOSTĘPNA'
  };
  return map[key] || String(raw).toUpperCase();
}

// hh:mm clock format for the tile (minutes in).
function fmtClock(min) {
  if (!Number.isFinite(min) || min < 0) return '—';
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// Spoken-friendly remaining time for the voice tool (minutes in) -> string|null.
function fmtRemainingWords(min) {
  if (!Number.isFinite(min) || min < 0) return null;
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0 && m > 0) return `${h} godz ${m} min`;
  if (h > 0) return `${h} godz`;
  return `${m} min`;
}

/** Extract the interesting entities + parse them into a normalized view. */
function computeView(printer) {
  const statusEnt = findEntity(printer, ['print_status', 'current_stage', 'stage']);
  const progressEnt = findEntity(printer, ['print_progress', 'progress']);
  const curLayerEnt = findEntity(printer, ['current_layer']) ||
    findEntity(printer, ['layer'], ['total', 'count', 'target', 'max', 'remain']);
  const totLayerEnt = findEntity(printer, ['total_layer', 'layer_count', 'total_layers']);
  const remainingEnt = findEntity(printer, ['remaining_time', 'time_left', 'remaining']);
  const nozzleEnt = findEntity(printer, ['nozzle'], ['target']);
  const bedEnt = findEntity(printer, ['bed'], ['target']);

  return {
    status: statusEnt ? plStatus(statusEnt.state) : null,
    progress: progressEnt ? clampPct(num(progressEnt.state)) : null,
    curLayer: curLayerEnt ? cleanInt(curLayerEnt.state) : null,
    totLayer: totLayerEnt ? cleanInt(totLayerEnt.state) : null,
    remainingMin: remainingEnt ? num(remainingEnt.state) : NaN,
    nozzle: nozzleEnt ? num(nozzleEnt.state) : NaN,
    bed: bedEnt ? num(bedEnt.state) : NaN
  };
}

function layerText(v) {
  if (v.curLayer != null && v.totLayer != null) return `${v.curLayer} / ${v.totLayer}`;
  if (v.curLayer != null) return v.curLayer;
  return null;
}

/** Compact, speakable status object for bambu_status (present fields only). */
function compactStatus(printer) {
  const v = computeView(printer);
  const out = {};
  if (v.status) out.status = v.status;
  if (v.progress != null) out.progress_pct = Math.round(v.progress);
  const lt = layerText(v);
  if (lt) out.layer = lt;
  const rem = fmtRemainingWords(v.remainingMin);
  if (rem) out.remaining = rem;
  if (Number.isFinite(v.nozzle)) out.nozzle_c = Math.round(v.nozzle);
  if (Number.isFinite(v.bed)) out.bed_c = Math.round(v.bed);
  return out;
}

// ============================================================================
// Honest degradation copy — one source, shared by the widget + the voice tool.
// ============================================================================
/** @returns {{title:string, sub:string}} for the widget's centered honest state. */
function classify(e) {
  if (e && e.offline) {
    return { title: 'MOST OFFLINE', sub: 'uruchom most: cd bridge && npm start' };
  }
  const msg = e && (e.error || e.message);
  if (msg === 'ha not configured') {
    return { title: 'HOME ASSISTANT NIEPODŁĄCZONY', sub: 'uzupełnij HA_URL i HA_TOKEN w bridge/.env' };
  }
  if (msg === 'HA_BAMBU_PREFIX not set') {
    return { title: 'USTAW HA_BAMBU_PREFIX', sub: 'w bridge/.env' };
  }
  return { title: 'BRAK POŁĄCZENIA Z HOME ASSISTANT', sub: 'sprawdź most i konfigurację bridge/.env' };
}

/** @returns {string} single honest PL sentence for the voice tool. */
function errorMessage(e) {
  if (e && e.offline) return 'Most jest offline — uruchom go: cd bridge && npm start.';
  const msg = e && (e.error || e.message);
  if (msg === 'ha not configured') {
    return 'Home Assistant nie jest podłączony — uzupełnij HA_URL i HA_TOKEN w bridge/.env.';
  }
  if (msg === 'HA_BAMBU_PREFIX not set') return 'Ustaw HA_BAMBU_PREFIX w bridge/.env.';
  return 'Nie mam połączenia z Home Assistant — sprawdź most i plik bridge/.env.';
}

const EMPTY_TITLE = 'NIE ZNALAZŁEM DRUKARKI W HA';
const EMPTY_SUB = 'prefix: sprawdź HA_BAMBU_PREFIX';
const EMPTY_MSG = 'Nie znalazłem drukarki w HA — sprawdź HA_BAMBU_PREFIX.';

// ============================================================================
// Scoped styles — .bmb- prefix; color allowed ONLY here (widget body).
// ============================================================================
const STYLE = `
.bmb {
  display: flex; flex-direction: column; gap: var(--space-4);
  width: 100%; height: 100%; box-sizing: border-box;
  font-family: var(--font-mono); color: var(--fg);
}
.bmb-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-3);
}
.bmb-status {
  font-size: var(--text-lg); letter-spacing: var(--tracking-wide);
  text-transform: uppercase; color: var(--fg); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.bmb-pct {
  font-size: var(--text-xl); font-weight: 600; line-height: 1;
  color: var(--widget-accent); font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
.bmb-bar {
  position: relative; width: 100%; height: 10px;
  background: var(--line-strong); border-radius: 999px; overflow: hidden;
}
.bmb-bar-fill {
  position: absolute; left: 0; top: 0; height: 100%; width: 0;
  background: var(--widget-accent); border-radius: 999px;
  transition: width var(--t-med) var(--ease-out);
}
.bmb-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: var(--space-3);
}
.bmb-tile {
  display: flex; flex-direction: column; gap: var(--space-1);
  padding: var(--space-3); border: 1px solid var(--line);
  border-radius: var(--glass-radius-sm); background: rgba(255, 255, 255, 0.03);
}
.bmb-tile-val {
  font-size: var(--text-xl); font-weight: 600; line-height: 1; color: var(--fg);
  font-variant-numeric: tabular-nums;
}
.bmb-tile-lbl {
  font-size: var(--text-xs); letter-spacing: var(--tracking);
  color: var(--fg-dim); text-transform: uppercase;
}
.bmb-cam-wrap { position: relative; width: 100%; margin-top: auto; }
.bmb-cam {
  display: block; width: 100%; max-width: 100%; aspect-ratio: 16 / 9;
  object-fit: cover; border: 1px solid var(--line-strong);
  border-radius: var(--glass-radius-sm); background: var(--bg-raised);
}
.bmb-cam-cap {
  margin-top: var(--space-2); min-height: 1em; font-size: var(--text-xs);
  letter-spacing: var(--tracking); text-transform: uppercase; color: var(--fg-dim);
}
.bmb-honest {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: var(--space-3); width: 100%; height: 100%;
  min-height: 160px; text-align: center; padding: var(--space-5);
}
.bmb-honest-title {
  font-size: var(--text-md); letter-spacing: var(--tracking-wide);
  color: var(--fg-dim); text-transform: uppercase;
}
.bmb-honest-sub {
  font-size: var(--text-sm); color: var(--fg-faint);
  font-family: var(--font-mono); word-break: break-word;
}
`;

// ============================================================================
// Widget definition factory
// ============================================================================
export function bambuDef() {
  return defineWidget({
    id: 'bambu',
    title: 'DRUKARKA · BAMBU X1C',
    color: ACCENT,
    size: 'lg',
    render(bodyEl) {
      let alive = true;
      let statusTimer = null;   // 10s status poll
      let camTimer = null;      // 3s / 10s camera snapshot loop
      let unsubBridge = null;

      // Data-view mount tracking + node refs.
      let dataMounted = false;
      let builtWithCamera = false;
      let camRelSrc = null;
      let camIntervalMs = CAM_OK_MS;
      let camFailShown = false;
      const refs = {};

      // Scoped style once; `root` holds swappable content (honest <-> data).
      const styleEl = el('style');
      styleEl.textContent = STYLE;
      const root = el('div', 'bmb');
      bodyEl.replaceChildren(styleEl, root);

      function stopCam() {
        if (camTimer) { clearInterval(camTimer); camTimer = null; }
      }

      function refreshCam() {
        if (!alive || !refs.cam || !camRelSrc) return;
        refs.cam.src = bridgeUrl(camRelSrc) + '&t=' + Date.now();
      }

      function restartCamLoop(ms) {
        stopCam();
        camTimer = setInterval(refreshCam, ms);
      }

      function showHonest(title, sub) {
        stopCam();
        dataMounted = false;
        const wrap = el('div', 'bmb-honest');
        wrap.append(el('div', 'bmb-honest-title', title));
        if (sub) wrap.append(el('div', 'bmb-honest-sub', sub));
        root.replaceChildren(wrap);
      }

      function showLoading() {
        stopCam();
        dataMounted = false;
        const wrap = el('div', 'bmb-honest');
        wrap.append(el('div', 'bmb-honest-title', 'ŁĄCZĘ Z HOME ASSISTANT…'));
        root.replaceChildren(wrap);
      }

      function tile(label) {
        const t = el('div', 'bmb-tile');
        const val = el('div', 'bmb-tile-val', '—');
        t.append(val, el('div', 'bmb-tile-lbl', label));
        return { tile: t, val };
      }

      function buildSkeleton(hasCamera) {
        // Header: STATUS + big % progress.
        const head = el('div', 'bmb-head');
        refs.status = el('span', 'bmb-status', '—');
        refs.pct = el('span', 'bmb-pct', '—');
        head.append(refs.status, refs.pct);

        // Progress bar.
        const bar = el('div', 'bmb-bar');
        refs.fill = el('div', 'bmb-bar-fill');
        bar.append(refs.fill);

        // Stat tiles.
        const grid = el('div', 'bmb-grid');
        const tLayer = tile('WARSTWA');
        const tRemain = tile('POZOSTAŁO');
        const tNozzle = tile('DYSZA °C');
        const tBed = tile('STÓŁ °C');
        refs.layer = tLayer.val;
        refs.remaining = tRemain.val;
        refs.nozzle = tNozzle.val;
        refs.bed = tBed.val;
        grid.append(tLayer.tile, tRemain.tile, tNozzle.tile, tBed.tile);

        root.replaceChildren(head, bar, grid);

        // Camera figure (snapshot) or honest no-camera caption.
        const camWrap = el('div', 'bmb-cam-wrap');
        if (hasCamera) {
          refs.cam = el('img', 'bmb-cam');
          refs.cam.alt = 'Podgląd druku';
          refs.camCap = el('div', 'bmb-cam-cap');
          refs.cam.onerror = () => {
            if (!alive) return;
            if (!camFailShown) {
              refs.camCap.textContent = 'KAMERA NIEDOSTĘPNA';
              camFailShown = true;
            }
            if (camIntervalMs !== CAM_FAIL_MS) {
              camIntervalMs = CAM_FAIL_MS;
              restartCamLoop(CAM_FAIL_MS);
            }
          };
          refs.cam.onload = () => {
            if (!alive) return;
            if (camFailShown) { refs.camCap.textContent = ''; camFailShown = false; }
            if (camIntervalMs !== CAM_OK_MS) {
              camIntervalMs = CAM_OK_MS;
              restartCamLoop(CAM_OK_MS);
            }
          };
          camWrap.append(refs.cam, refs.camCap);
          root.append(camWrap);
          // Kick the first frame + start the refresh loop.
          camFailShown = false;
          camIntervalMs = CAM_OK_MS;
          refreshCam();
          restartCamLoop(CAM_OK_MS);
        } else {
          refs.cam = null;
          stopCam();
          camWrap.append(el('div', 'bmb-cam-cap', 'brak encji kamery w HA'));
          root.append(camWrap);
        }
      }

      function updateValues(v) {
        refs.status.textContent = v.status || '—';
        refs.pct.textContent = v.progress == null ? '—' : Math.round(v.progress) + '%';
        refs.fill.style.width = (v.progress == null ? 0 : v.progress) + '%';
        refs.layer.textContent = layerText(v) || '—';
        refs.remaining.textContent = fmtClock(v.remainingMin);
        refs.nozzle.textContent = Number.isFinite(v.nozzle) ? String(Math.round(v.nozzle)) : '—';
        refs.bed.textContent = Number.isFinite(v.bed) ? String(Math.round(v.bed)) : '—';
      }

      function renderData(data) {
        const printer = data.printer || {};
        const camera = data.camera || null;
        const hasCam = !!(camera && camera.src);
        if (hasCam) camRelSrc = camera.src;

        if (!dataMounted || builtWithCamera !== hasCam) {
          buildSkeleton(hasCam);
          dataMounted = true;
          builtWithCamera = hasCam;
        }
        updateValues(computeView(printer));
      }

      async function poll() {
        let data;
        try {
          data = await haBambu();
        } catch (e) {
          if (!alive) return;
          const h = classify(e);
          showHonest(h.title, h.sub);
          return;
        }
        if (!alive) return;
        const printer = (data && data.printer) || {};
        if (!data || !data.ok || Object.keys(printer).length === 0) {
          showHonest(EMPTY_TITLE, EMPTY_SUB);
          return;
        }
        renderData(data);
      }

      // Re-attempt fast when the bridge comes back online.
      unsubBridge = bus.on('bridge:status', (payload) => {
        if (alive && payload && payload.online) poll();
      });

      showLoading();
      poll();
      statusTimer = setInterval(poll, POLL_MS);

      // cleanup: zero running timers, drop the bus sub.
      return () => {
        alive = false;
        if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
        stopCam();
        if (unsubBridge) { unsubBridge(); unsubBridge = null; }
      };
    }
  });
}

// ============================================================================
// init() — register the widget + voice tools. Idempotent, never throws.
// ============================================================================
export async function init() {
  try {
    toolRouter.registerWidget('bambu', bambuDef);

    toolRouter.registerTool(
      {
        name: 'show_bambu',
        description: 'Pokaż widget drukarki Bambu X1C (status druku + podgląd kamery przez Home Assistant).',
        parameters: { type: 'object', properties: {} }
      },
      async () => {
        layout.addWidget(bambuDef());
        return { ok: true };
      }
    );

    toolRouter.registerTool(
      {
        name: 'bambu_status',
        description: 'Sprawdź aktualny status drukarki Bambu (postęp, czas, temperatury) — użyj, gdy Jurek pyta słownie o druk.',
        parameters: { type: 'object', properties: {} }
      },
      async () => {
        let data;
        try {
          data = await haBambu();
        } catch (e) {
          return { ok: false, error: errorMessage(e) };
        }
        const printer = (data && data.printer) || {};
        if (!data || !data.ok || Object.keys(printer).length === 0) {
          return { ok: false, error: EMPTY_MSG };
        }
        return { ok: true, ...compactStatus(printer) };
      }
    );
  } catch (err) {
    console.warn('[bambu] init failed', err);
  }
}
