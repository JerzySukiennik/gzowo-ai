// js/globe/globe-data.js — data sources for GLOBE mode. All FREE, no keys.
//   - geocode(place)  -> Nominatim (OpenStreetMap) place/address lookup
//   - wikiSummary(t)  -> Wikipedia REST summary (satellite descriptions)
//   - SAT_GROUPS      -> CelesTrak groups to load, with color + per-group cap
//   - FAMOUS          -> curated notable sats (wiki title, category, model hint)
//   - HISTORIC        -> decayed/deep-space objects shown on a RECONSTRUCTION orbit
// English code; PL copy only where user-facing text is returned.

// ---- Geocoding (Nominatim, free; light use, CORS-enabled) -------------------
export async function geocode(place) {
  const q = String(place || '').trim();
  if (!q) return null;
  // Bias toward Poland but allow worldwide; Nominatim needs a descriptive UA/Referer
  // (browsers send Referer automatically). Keep volume low per their policy.
  const url = 'https://nominatim.openstreetmap.org/search'
    + '?format=jsonv2&limit=1&addressdetails=0&q=' + encodeURIComponent(q);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const r = arr[0];
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // bbox: [south, north, west, east] in Nominatim's boundingbox order.
    let bbox = null;
    if (Array.isArray(r.boundingbox) && r.boundingbox.length === 4) {
      const b = r.boundingbox.map(Number);
      bbox = { south: b[0], north: b[1], west: b[2], east: b[3] };
    }
    return { lat, lon, name: r.display_name || q, type: r.type, bbox };
  } catch (_e) { return null; }
}

// ---- Wikipedia summary (free, CORS-enabled) ---------------------------------
export async function wikiSummary(title, lang = 'pl') {
  const t = String(title || '').trim();
  if (!t) return null;
  const url = 'https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/'
    + encodeURIComponent(t.replace(/ /g, '_'));
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    if (d.type === 'disambiguation' || !d.extract) return null;
    return { title: d.title, extract: d.extract, url: (d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page) || '' };
  } catch (_e) { return null; }
}

// Try PL, fall back to EN.
export async function describeSatellite(title) {
  return (await wikiSummary(title, 'pl')) || (await wikiSummary(title, 'en'));
}

// ---- Satellite categories: CelesTrak group -> color + PL label + sample cap --
// Colors are the on-globe dot color per type (Jurek: kolor per typ). Caps keep the
// total ~200 for smoothness on a 2019 Intel Mac.
export const CATEGORIES = {
  stations: { color: '#ff5a5a', label: 'Stacje', cap: 8 },
  starlink: { color: '#57b9ff', label: 'Starlink', cap: 70 },
  gnss:     { color: '#ffd166', label: 'Nawigacja (GNSS)', cap: 40 },
  weather:  { color: '#7cfc98', label: 'Pogodowe', cap: 20 },
  science:  { color: '#c792ea', label: 'Nauka / teleskopy', cap: 24 },
  geo:      { color: '#ff9f4a', label: 'Geostacjonarne', cap: 30 },
  historic: { color: '#e0e0e0', label: 'Historyczne (rekonstrukcja)', cap: 6 },
  other:    { color: '#9aa0a6', label: 'Inne', cap: 20 }
};

// CelesTrak GP groups to fetch, each mapped to a category above.
export const SAT_GROUPS = [
  { group: 'stations', category: 'stations' },
  { group: 'starlink', category: 'starlink' },
  { group: 'gps-ops', category: 'gnss' },
  { group: 'galileo', category: 'gnss' },
  { group: 'glo-ops', category: 'gnss' },
  { group: 'beidou', category: 'gnss' },
  { group: 'weather', category: 'weather' },
  { group: 'science', category: 'science' },
  { group: 'geo', category: 'geo' }
];

export function celestrakUrl(group) {
  return 'https://celestrak.org/NORAD/elements/gp.php?GROUP=' + encodeURIComponent(group) + '&FORMAT=tle';
}

// ---- Famous sats: name aliases -> {wiki title, category}. Used for voice
// "pokaż Hubble" resolution + richer panel. (Models are procedural in satmodel.js;
// specific glTF meshes can be dropped in later.) --------------------------------
export const FAMOUS = [
  { keys: ['iss', 'stacja', 'international space station', 'zarya'], match: 'ISS', wiki: 'Międzynarodowa Stacja Kosmiczna', category: 'stations' },
  { keys: ['hubble', 'hst'], match: 'HST', wiki: 'Kosmiczny Teleskop Hubble’a', category: 'science' },
  { keys: ['tiangong', 'css', 'chińska stacja'], match: 'CSS', wiki: 'Tiangong', category: 'stations' },
  { keys: ['noaa'], match: 'NOAA', wiki: 'NOAA (satelity)', category: 'weather' },
  { keys: ['gps'], match: 'GPS', wiki: 'GPS', category: 'gnss' },
  { keys: ['galileo'], match: 'GALILEO', wiki: 'Galileo (system nawigacji)', category: 'gnss' }
];

// Resolve a spoken name to a hint (category + wiki) even before the live catalog
// is searched. Returns null if unknown.
export function famousHint(name) {
  const q = String(name || '').toLowerCase().trim();
  if (!q) return null;
  return FAMOUS.find((f) => f.keys.some((k) => q.includes(k))) || null;
}

// ---- Historic / deep-space: shown on a RECONSTRUCTION orbit (approx, labelled).
// These have no current TLE (decayed or beyond Earth orbit). Orbit params are
// representative, animated by a simple circular model in satellites.js.
export const HISTORIC = [
  { name: 'Sputnik 1', wiki: 'Sputnik 1', note: 'Pierwszy sztuczny satelita (1957). Spłonął w atmosferze w 1958 — orbita rekonstrukcyjna.', altKm: 577, incDeg: 65.1, periodMin: 96.2 },
  { name: 'Explorer 1', wiki: 'Explorer 1', note: 'Pierwszy satelita USA (1958). Zdeorbitował 1970 — orbita rekonstrukcyjna.', altKm: 1000, incDeg: 33.2, periodMin: 114.8 },
  { name: 'Vostok 1 (Gagarin)', wiki: 'Wostok 1', note: 'Pierwszy lot człowieka w kosmos (1961). Orbita rekonstrukcyjna.', altKm: 200, incDeg: 64.9, periodMin: 89.3 },
  { name: 'JWST', wiki: 'Kosmiczny Teleskop Jamesa Webba', note: 'Teleskop w punkcie L2 (~1.5 mln km) — nie na orbicie Ziemi. Pozycja poglądowa.', altKm: 60000, incDeg: 5, periodMin: 1440, deepSpace: true },
  { name: 'Voyager 1', wiki: 'Voyager 1', note: 'W przestrzeni międzygwiezdnej (>24 mld km) — daleko poza globem. Wpis muzealny.', deepSpace: true, museumOnly: true }
];
