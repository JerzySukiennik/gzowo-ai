// js/skills/launch.js — rocket LAUNCH WEATHER go/no-go (Jurek #12).
// Reads wind, gusts, cloud cover, precipitation + probability and visibility for
// the configured launch site (config.launchSite — default Dzbanice) and returns a
// simple START OK / OSTROŻNIE / NIE STARTUJ verdict with the numbers. Model-facing
// tool; it never invents data — on a fetch failure it says so.

import { toolRouter } from '../core/tool-router.js';

const CONFIG = window.GZOWO_CONFIG || {};

// Thresholds tuned for small model rockets (safety-first; Jurek can recalibrate).
const GUST_CAUTION = 25;   // km/h — above this, be careful
const GUST_NOGO = 40;      // km/h — hard no
const PRECIP_PROB_CAUTION = 30;  // %
const PRECIP_PROB_NOGO = 60;     // %

function verdict(w) {
  const reasons = [];
  let level = 'GO';
  const bump = (lvl, why) => {
    reasons.push(why);
    if (lvl === 'NOGO') level = 'NOGO';
    else if (lvl === 'CAUTION' && level !== 'NOGO') level = 'CAUTION';
  };
  if (w.precip_now > 0) bump('NOGO', 'pada teraz');
  if (w.gusts >= GUST_NOGO) bump('NOGO', `porywy ${w.gusts} km/h`);
  else if (w.gusts >= GUST_CAUTION) bump('CAUTION', `porywy ${w.gusts} km/h`);
  if (w.precip_prob >= PRECIP_PROB_NOGO) bump('NOGO', `${w.precip_prob}% szans na opady`);
  else if (w.precip_prob >= PRECIP_PROB_CAUTION) bump('CAUTION', `${w.precip_prob}% szans na opady`);
  if (w.cloud_cover >= 90) bump('CAUTION', 'zwarte chmury (słaba widoczność rakiety)');
  if (w.wind >= GUST_CAUTION) bump('CAUTION', `stały wiatr ${w.wind} km/h (znos)`);
  const label = level === 'GO' ? 'START OK' : level === 'CAUTION' ? 'OSTROŻNIE' : 'NIE STARTUJ';
  return { level, label, reasons };
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'launch_weather',
      description: 'Pogoda STARTOWA dla rakiet: wiatr, porywy, zachmurzenie, opady i widoczność w ' +
        'miejscu startu (' + ((CONFIG.launchSite && CONFIG.launchSite.name) || 'Dzbanice') + ') + werdykt ' +
        'START OK / OSTROŻNIE / NIE STARTUJ. Użyj, gdy Jurek pyta „czy mogę odpalić rakietę?", ' +
        '„jaka pogoda na start?". Podaj werdykt i najważniejsze liczby (porywy, opady).',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => {
      const site = CONFIG.launchSite || { lat: 52.6056, lon: 21.0768, name: 'Dzbanice' };
      try {
        const url = 'https://api.open-meteo.com/v1/forecast' +
          `?latitude=${site.lat}&longitude=${site.lon}` +
          '&current=temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,visibility' +
          '&hourly=precipitation_probability&timezone=auto&forecast_days=1';
        const d = await (await fetch(url, { cache: 'no-store' })).json();
        const cur = d.current || {};
        // precip probability for the current hour (first matching hourly index).
        let precipProb = 0;
        try {
          const times = (d.hourly && d.hourly.time) || [];
          const probs = (d.hourly && d.hourly.precipitation_probability) || [];
          const nowH = String(cur.time || '').slice(0, 13);   // 'YYYY-MM-DDTHH'
          let idx = times.findIndex((t) => String(t).slice(0, 13) === nowH);
          if (idx < 0) idx = 0;
          precipProb = Math.round(Number(probs[idx]) || 0);
        } catch (_e) { precipProb = 0; }

        const w = {
          temp: Math.round(cur.temperature_2m ?? 0),
          wind: Math.round(cur.wind_speed_10m ?? 0),
          gusts: Math.round(cur.wind_gusts_10m ?? 0),
          cloud_cover: Math.round(cur.cloud_cover ?? 0),
          precip_now: Number(cur.precipitation ?? 0),
          precip_prob: precipProb,
          visibility_m: Math.round(cur.visibility ?? 0)
        };
        const v = verdict(w);
        return {
          ok: true,
          site: site.name,
          verdict: v.label,
          level: v.level,
          reasons: v.reasons,
          wind_kmh: w.wind,
          gusts_kmh: w.gusts,
          cloud_cover_pct: w.cloud_cover,
          precip_probability_pct: w.precip_prob,
          precip_now_mm: w.precip_now,
          temp_c: w.temp
        };
      } catch (_e) {
        return { ok: false, error: 'nie udało się pobrać pogody startowej (Open-Meteo)' };
      }
    }
  );
}
