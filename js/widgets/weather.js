// js/widgets/weather.js — POGODA widget (Open-Meteo, no API key).
// Owns: weatherDef() factory + async init(). The shared tool/request router
// (owned by clock.js) maps show_weather / widget:request 'weather' -> weatherDef().
// COLOR: single accent '#7fb8ff' lives ONLY inside .widget-body descendants.
//
// Contract honored:
//   - export async function init()
//   - export function weatherDef()  -> def for layout.addWidget
//   - render(bodyEl, ctx) returns a cleanup fn (clears the refresh interval).
//   - Fully fluid DOM (%/clamp), no fixed px widget dimensions, overflow safe.
//   - Honest degradation on fetch failure (Edek-tone Polish copy + 60s retry).

import { defineWidget } from './widget-base.js';

const CONFIG = window.GZOWO_CONFIG;
const ACCENT = '#7fb8ff';
const REFRESH_MS = 15 * 60 * 1000; // live refresh every 15 min while mounted
const RETRY_MS = 60 * 1000;        // retry 60s after a failed fetch

// ---- WMO weather-code -> Polish condition text (full map) -------------------
function wmoText(code) {
  if (code === 0) return 'Czyste niebo';
  if (code === 1) return 'Głównie bezchmurnie';
  if (code === 2) return 'Częściowe zachmurzenie';
  if (code === 3) return 'Zachmurzenie';
  if (code === 45 || code === 48) return 'Mgła';
  if (code === 51) return 'Lekka mżawka';
  if (code === 53) return 'Mżawka';
  if (code === 55) return 'Gęsta mżawka';
  if (code === 56 || code === 57) return 'Marznąca mżawka';
  if (code === 61) return 'Lekki deszcz';
  if (code === 63) return 'Deszcz';
  if (code === 65) return 'Ulewny deszcz';
  if (code === 66 || code === 67) return 'Marznący deszcz';
  if (code === 71) return 'Lekki śnieg';
  if (code === 73) return 'Śnieg';
  if (code === 75) return 'Gęsty śnieg';
  if (code === 77) return 'Ziarna śniegu';
  if (code === 80) return 'Przelotny deszcz';
  if (code === 81) return 'Przelotne opady';
  if (code === 82) return 'Ulewne przelotne opady';
  if (code === 85 || code === 86) return 'Przelotny śnieg';
  if (code === 95) return 'Burza';
  if (code === 96 || code === 99) return 'Burza z gradem';
  return 'Pogoda nieznana';
}

// ---- WMO code -> icon group (inline SVG line icon, stroke:currentColor) ------
function wmoGroup(code) {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2 || code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
}

// stroke=currentColor so accent/gray inherits from the surrounding context.
function iconSVG(group) {
  const open = '<svg class="wx-svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">';
  const cloud = '<path d="M6.5 18a4 4 0 0 1 .3-8 5.5 5.5 0 0 1 10.6 1.3A3.5 3.5 0 0 1 17 18z"/>';
  switch (group) {
    case 'sun':
      return open +
        '<circle cx="12" cy="12" r="4.2"/>' +
        '<path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>' +
        '</svg>';
    case 'cloud':
      return open + cloud + '</svg>';
    case 'fog':
      return open + '<path d="M4 9h16M4 13h16M6 17h12M7 5h10"/></svg>';
    case 'rain':
      return open + cloud +
        '<path d="M8.5 20l-.8 1.6M12 20l-.8 1.6M15.5 20l-.8 1.6"/></svg>';
    case 'snow':
      return open + cloud +
        '<circle cx="9" cy="21" r="0.5"/><circle cx="12" cy="21.4" r="0.5"/><circle cx="15" cy="21" r="0.5"/></svg>';
    case 'storm':
      return open + cloud + '<path d="M12.5 18l-2 3h2.2l-1.5 3"/></svg>';
    default:
      return open + cloud + '</svg>';
  }
}

// ---- PL short weekday from ISO date string ('2026-07-07') -------------------
const PL_DAYS_SHORT = ['ndz', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob'];
function shortDay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return PL_DAYS_SHORT[d.getDay()] || '—';
}

function apiURL() {
  const { lat, lon } = CONFIG.weather;
  return 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code' +
    '&timezone=auto&forecast_days=4';
}

// ---- Render states ----------------------------------------------------------
function renderData(bodyEl, data) {
  const cur = data.current || {};
  const daily = data.daily || {};
  const code = Math.round(cur.weather_code ?? 3);
  const temp = Math.round(cur.temperature_2m ?? 0);
  const feels = Math.round(cur.apparent_temperature ?? temp);
  const wind = Math.round(cur.wind_speed_10m ?? 0);
  const hum = Math.round(cur.relative_humidity_2m ?? 0);

  // 3-day strip: skip today (index 0), take the next three days.
  let strip = '';
  const times = daily.time || [];
  const maxs = daily.temperature_2m_max || [];
  const mins = daily.temperature_2m_min || [];
  const codes = daily.weather_code || [];
  for (let i = 1; i < Math.min(4, times.length); i++) {
    strip +=
      '<div class="wx-day">' +
        `<span class="wx-day-name">${shortDay(times[i])}</span>` +
        `<span class="wx-day-icon">${iconSVG(wmoGroup(Math.round(codes[i] ?? 3)))}</span>` +
        `<span class="wx-day-temps"><b>${Math.round(maxs[i])}&deg;</b> ${Math.round(mins[i])}&deg;</span>` +
      '</div>';
  }

  bodyEl.innerHTML =
    '<div class="wx">' +
      '<div class="wx-now">' +
        `<div class="wx-icon">${iconSVG(wmoGroup(code))}</div>` +
        '<div class="wx-now-main">' +
          `<div class="wx-temp">${temp}<span class="wx-deg">&deg;</span></div>` +
          `<div class="wx-cond">${wmoText(code)}</div>` +
          `<div class="wx-feels">odczuwalna ${feels}&deg;</div>` +
        '</div>' +
      '</div>' +
      '<div class="wx-meta">' +
        `<span class="wx-meta-item">wiatr <b>${wind}</b> km/h</span>` +
        `<span class="wx-meta-item">wilg. <b>${hum}</b>%</span>` +
      '</div>' +
      `<div class="wx-strip">${strip}</div>` +
    '</div>';
}

function renderError(bodyEl) {
  bodyEl.innerHTML =
    '<div class="wx wx-err">' +
      '<div class="wx-err-title">OPEN-METEO NIE ODPOWIADA</div>' +
      '<div class="wx-err-sub">spróbuję za chwilę, człowieku</div>' +
    '</div>';
}

function renderLoading(bodyEl) {
  bodyEl.innerHTML =
    '<div class="wx wx-load"><div class="wx-load-txt">łapię pogodę&hellip;</div></div>';
}

// ---- Widget definition factory ---------------------------------------------
export function weatherDef() {
  const city = (CONFIG.weather.city || '').toUpperCase();
  return defineWidget({
    id: 'weather',
    title: 'POGODA · ' + city,
    color: ACCENT,
    size: 'md',
    render(bodyEl) {
      let alive = true;
      let refreshTimer = null;
      let retryTimer = null;

      async function load() {
        if (!alive) return;
        try {
          const res = await fetch(apiURL(), { cache: 'no-store' });
          if (!res.ok) throw new Error('http ' + res.status);
          const data = await res.json();
          if (!alive) return;
          renderData(bodyEl, data);
          // Success: (re)arm the 15-min live refresh, drop any pending retry.
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          if (!refreshTimer) refreshTimer = setInterval(load, REFRESH_MS);
        } catch (_err) {
          if (!alive) return;
          renderError(bodyEl);
          // Failure: pause the long refresh, schedule a fast 60s retry.
          if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(load, RETRY_MS);
        }
      }

      renderLoading(bodyEl);
      load();

      // cleanup: kill every timer so a removed widget never ticks (60fps hygiene).
      return () => {
        alive = false;
        if (refreshTimer) clearInterval(refreshTimer);
        if (retryTimer) clearTimeout(retryTimer);
      };
    }
  });
}

// This module registers no bus listeners itself — routing lives in clock.js.
export async function init() {
  // Idempotent no-op: the def factory is imported by the router.
}
