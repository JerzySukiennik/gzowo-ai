// js/skills/brief.js — Morning brief (Jurek #5), set up via „Zbudujmy coś".
// morning_brief assembles a short spoken/pushed summary: greeting + today's
// weather (default = Gzowo) + optional custom line, shows the weather widget,
// toasts, pushes to the phone, and speaks it if a voice session is live.
//
// Typical use: an AUTOMATION (create_automation, time="07:00") whose action is
// tool="morning_brief". At that hour there's usually no session, so the phone
// push + on-screen weather carry it; if Jurek is already talking, Gzowo says it.

import { bus } from '../core/event-bus.js';
import { toolRouter } from '../core/tool-router.js';
import { notifyPhone } from '../core/notify.js';

const CONFIG = window.GZOWO_CONFIG || {};

function wmoShort(code) {
  const c = Math.round(Number(code));
  if (c === 0 || c === 1) return 'słonecznie';
  if (c === 2) return 'część chmur';
  if (c === 3) return 'pochmurno';
  if (c === 45 || c === 48) return 'mgła';
  if (c >= 51 && c <= 67) return 'deszcz';
  if (c >= 71 && c <= 77) return 'śnieg';
  if (c >= 80 && c <= 82) return 'przelotny deszcz';
  if (c >= 95) return 'burza';
  return 'zmiennie';
}

async function weatherLine() {
  const lat = (CONFIG.weather && CONFIG.weather.lat) ?? 52.6154;
  const lon = (CONFIG.weather && CONFIG.weather.lon) ?? 21.0888;
  const city = (CONFIG.weather && CONFIG.weather.city) || 'Gzowo';
  try {
    const url = 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1';
    const d = await (await fetch(url, { cache: 'no-store' })).json();
    const cur = d.current || {};
    const daily = d.daily || {};
    const t = Math.round(cur.temperature_2m ?? 0);
    const hi = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : null;
    const lo = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : null;
    const wind = Math.round(cur.wind_speed_10m ?? 0);
    const cond = wmoShort(cur.weather_code);
    let s = `W ${city} ${t}°, ${cond}, wiatr ${wind} km/h`;
    if (hi != null && lo != null) s += `, dziś od ${lo}° do ${hi}°`;
    return s + '.';
  } catch (_e) {
    return null;
  }
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'morning_brief',
      description: 'Składa i wygłasza PORANNY BRIEFING: powitanie + dzisiejsza pogoda (domyślnie ' +
        'Gzowo) + opcjonalne zdanie. Pokazuje widget pogody, wysyła push na telefon i mówi na głos ' +
        '(jeśli trwa rozmowa). Najczęściej odpalany przez automatyzację o ustalonej porze ' +
        '(create_automation, time="07:00", tool="morning_brief"). extra = własna linijka do dołożenia.',
      parameters: {
        type: 'object',
        properties: {
          greeting: { type: 'string', description: 'Powitanie (domyślnie „Dzień dobry, Jurek.").' },
          extra: { type: 'string', description: 'Dodatkowe zdanie do briefingu (opcjonalnie).' },
          show_weather: { type: 'boolean', description: 'Czy pokazać widget pogody (domyślnie tak).' }
        },
        required: []
      }
    },
    async (a) => {
      const args = a || {};
      const parts = [];
      parts.push(String(args.greeting || '').trim() || 'Dzień dobry, Jurek.');
      const wx = await weatherLine();
      if (wx) parts.push(wx);
      if (args.extra && String(args.extra).trim()) parts.push(String(args.extra).trim());
      const brief = parts.join(' ');

      if (args.show_weather !== false) {
        try { await toolRouter.dispatch('show_weather', {}); } catch (_e) { /* non-fatal */ }
      }
      bus.emit('toast', { text: '☀️ ' + brief, kind: 'info' });
      bus.emit('assistant:announce', { text: brief });
      notifyPhone('Poranny briefing', brief);   // fire-and-forget
      return { ok: true, brief };
    }
  );
}
