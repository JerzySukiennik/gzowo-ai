// js/globe/satellites.js — satellite catalog + propagation for GLOBE mode.
// FREE data: CelesTrak TLE (SGP4 orbits) propagated with satellite.js. Historic /
// decayed objects (Sputnik…) get a synthetic RECONSTRUCTION orbit (labelled).
// globe.js turns these into Cesium points; this module owns the math + catalog.

import { SAT_GROUPS, CATEGORIES, celestrakUrl, HISTORIC } from './globe-data.js';

const RE_KM = 6378.137;            // Earth equatorial radius
const EARTH_ROT = 7.2921159e-5;    // rad/s

let _sat = null;                   // lazily-imported satellite.js module

async function satlib() {
  if (_sat) return _sat;
  _sat = await import('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/+esm');
  return _sat;
}

// Parse a CelesTrak TLE text blob into [{name, l1, l2}] triples.
function parseTLE(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (lines[i] && lines[i + 1] && lines[i + 2] &&
        lines[i + 1][0] === '1' && lines[i + 2][0] === '2') {
      out.push({ name: lines[i].trim(), l1: lines[i + 1], l2: lines[i + 2] });
      i += 2;
    }
  }
  return out;
}

function noradOf(l1) { return l1.slice(2, 7).trim(); }

/**
 * Load the curated live catalog (~200 sats) from CelesTrak, per-category capped.
 * @returns {Promise<Array>} [{id, name, category, color, satrec}]
 */
export async function loadCatalog() {
  const sat = await satlib();
  const seen = new Set();
  const results = await Promise.all(SAT_GROUPS.map(async (g) => {
    const cat = CATEGORIES[g.category] || CATEGORIES.other;
    let text = '';
    try {
      const res = await fetch(celestrakUrl(g.group), { cache: 'no-store' });
      if (res.ok) text = await res.text();
    } catch (_e) { /* group offline — skip */ }
    const triples = parseTLE(text).slice(0, cat.cap);
    const list = [];
    for (const t of triples) {
      const id = noradOf(t.l1);
      if (seen.has(id)) continue;
      seen.add(id);
      let satrec;
      try { satrec = sat.twoline2satrec(t.l1, t.l2); } catch (_e) { continue; }
      if (!satrec || satrec.error) continue;
      list.push({ id, name: t.name, category: g.category, color: cat.color, satrec });
    }
    return list;
  }));
  return results.flat();
}

/**
 * Geodetic position of a live sat at `date`. Returns {lat, lon, altKm} | null.
 */
export function propagate(satEntry, date) {
  const sat = _sat;
  if (!sat || !satEntry || !satEntry.satrec) return null;
  try {
    const pv = sat.propagate(satEntry.satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = sat.gstime(date);
    const geo = sat.eciToGeodetic(pv.position, gmst);
    return {
      lat: sat.degreesLat(geo.latitude),
      lon: sat.degreesLong(geo.longitude),
      altKm: geo.height
    };
  } catch (_e) { return null; }
}

// ---- Historic / reconstruction orbits (approximate, labelled) ----------------
// Simple circular orbit with inclination, in ECI, then rotated to ECEF by GMST
// so the ground track drifts realistically. Deep-space / museum-only entries
// (Voyager) return null (not shown orbiting).
function wrap180(deg) { return ((deg + 180) % 360 + 360) % 360 - 180; }

export function historicCatalog() {
  return HISTORIC.filter((h) => !h.museumOnly).map((h, i) => ({
    id: 'hist-' + i,
    name: h.name,
    category: 'historic',
    color: CATEGORIES.historic.color,
    reconstruction: true,
    a: RE_KM + (h.altKm || 500),
    inc: (h.incDeg || 50) * Math.PI / 180,
    n: (2 * Math.PI) / ((h.periodMin || 95) * 60),   // rad/s
    node: (i * 47) * Math.PI / 180,                   // spread ascending nodes
    meta: h
  }));
}

export function propagateHistoric(h, date) {
  if (!h || !h.reconstruction) return null;
  const t = date.getTime() / 1000;
  const theta = h.n * t + h.node;
  // orbital plane
  const xp = h.a * Math.cos(theta);
  const yp = h.a * Math.sin(theta);
  // inclination about x-axis
  const x = xp;
  const y = yp * Math.cos(h.inc);
  const z = yp * Math.sin(h.inc);
  // ECI -> ECEF by -GMST about z
  const g = EARTH_ROT * t;
  const xe = x * Math.cos(g) + y * Math.sin(g);
  const ye = -x * Math.sin(g) + y * Math.cos(g);
  const r = Math.sqrt(xe * xe + ye * ye + z * z);
  return {
    lat: Math.asin(z / r) * 180 / Math.PI,
    lon: wrap180(Math.atan2(ye, xe) * 180 / Math.PI),
    altKm: r - RE_KM
  };
}

// Fuzzy name search over a live catalog (+ historic). Returns the best match.
export function searchByName(catalog, historic, query) {
  const q = String(query || '').toUpperCase().trim();
  if (!q) return null;
  const all = [...(catalog || []), ...(historic || [])];
  return all.find((s) => s.name.toUpperCase() === q)
    || all.find((s) => s.name.toUpperCase().includes(q))
    || all.find((s) => q.includes(s.name.toUpperCase()))
    || null;
}

// Extract the ISS entry from a loaded catalog (name contains ZARYA / ISS).
export function findISS(catalog) {
  return (catalog || []).find((s) => /ISS|ZARYA/i.test(s.name)) || null;
}
