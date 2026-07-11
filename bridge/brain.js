// bridge/brain.js — "Jurek's 2nd Brain" connector backend.
// Read-only access to the ClaudeMemory vault (all .md, skips dotdirs/.obsidian)
// + APPEND-ONLY drafts to inbox/gzowoai-drafts.md. NOTHING else is writable.
// Every route is gated by X-Brain-Pass (BRAIN_PASS in bridge/.env). Honest only.

import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { readFile, appendFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, relative, extname, sep } from 'node:path';

const DRAFTS_REL = 'inbox/gzowoai-drafts.md';
const FLIGHTLOG_DIR = 'Flight-Logs';

// Read env at CALL time — the bridge's loadEnv() runs AFTER this module is
// imported, so reading process.env at module-load would see empty values.
function vault() { return resolve(process.env.BRAIN_VAULT || join(homedir(), 'Downloads/Claude/ClaudeMemory')); }
function pass() { return process.env.BRAIN_PASS || ''; }

/** Configured only when a pass is set AND the vault exists on disk. */
export function brainConfigured() {
  return Boolean(pass() && existsSync(vault()));
}

/** The request must carry the exact X-Brain-Pass header. */
export function brainPassOk(req) {
  const h = req.headers['x-brain-pass'] || '';
  return Boolean(pass()) && String(h) === pass();
}

// Resolve a client-supplied relative path safely INSIDE the vault, .md only.
function safePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const V = vault();
  const target = resolve(join(V, rel));
  if (target !== V && !target.startsWith(V + sep)) return null; // block ../
  if (extname(target).toLowerCase() !== '.md') return null;
  return target;
}

/** Recursively list every .md file (skips names starting with '.'). Newest first. */
export async function brainIndex() {
  const V = vault();
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .obsidian, dotfiles
      const full = join(dir, e.name);
      if (e.isDirectory()) { await walk(full); }
      else if (e.isFile() && extname(e.name).toLowerCase() === '.md') {
        let st; try { st = statSync(full); } catch { continue; }
        out.push({ path: relative(V, full), mtime: st.mtimeMs, size: st.size });
      }
    }
  }
  await walk(V);
  out.sort((a, b) => b.mtime - a.mtime);
  return { vault: 'ClaudeMemory', files: out };
}

/** Raw content of a vault .md file, or null if invalid/missing. */
export async function brainReadFile(rel) {
  const target = safePath(rel);
  if (!target || !existsSync(target)) return null;
  return await readFile(target, 'utf8');
}

/** Append a draft entry to inbox/gzowoai-drafts.md — the ONLY write path. */
export async function brainAppendDraft(topic, text) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  const t = String(topic || '').trim() || 'notatka';
  const body = String(text || '').trim();
  const entry = `\n## [${stamp}] ${t}\n${body}\n`;
  await appendFile(join(vault(), DRAFTS_REL), entry, 'utf8');
  return { ok: true, appendedTo: DRAFTS_REL };
}

// ---------------------------------------------------------------------------
// Write helpers (v4-f). Paths are built HERE (never from raw client input) and
// sanitized to a slug, so there is no traversal surface. All stay inside vault().
// ---------------------------------------------------------------------------
function slugify(s, fallback) {
  const out = String(s || '').toLowerCase().trim()
    .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return out || fallback;
}
function dateStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Save a real, dated note file into inbox/ (vault convention), never overwriting. */
export async function brainSaveNote(title, text) {
  const now = new Date();
  const day = dateStamp(now);
  const t = String(title || '').trim() || 'notatka';
  const base = day + '-' + slugify(t, 'notatka');
  const V = vault();
  let rel = 'inbox/' + base + '.md';
  let n = 2;
  while (existsSync(join(V, rel))) { rel = 'inbox/' + base + '-' + n + '.md'; n++; }
  const front = `---\ntype: note\nsource: session\ncreated: ${day}\n---\n\n`;
  const body = `# ${t}\n\n${String(text || '').trim()}\n`;
  await mkdir(join(V, 'inbox'), { recursive: true });
  await writeFile(join(V, rel), front + body, 'utf8');
  return { ok: true, savedTo: rel };
}

/** Append a flight log as its OWN file in Flight-Logs/ (one file per flight). */
export async function brainFlightLog(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const now = new Date();
  const day = dateStamp(now);
  const name = String(f.name || f.rocket || '').trim();
  const base = day + (name ? '-' + slugify(name, 'lot') : '-lot');
  const V = vault();
  await mkdir(join(V, FLIGHTLOG_DIR), { recursive: true });
  let rel = FLIGHTLOG_DIR + '/' + base + '.md';
  let n = 2;
  while (existsSync(join(V, rel))) { rel = FLIGHTLOG_DIR + '/' + base + '-' + n + '.md'; n++; }
  const rows = [];
  const add = (k, v) => { if (v != null && String(v).trim() !== '') rows.push(`- **${k}:** ${String(v).trim()}`); };
  add('Data', f.date || day);
  add('Rakieta', f.rocket || f.name);
  add('Silnik', f.motor);
  add('Apogeum', f.apogee);
  add('Miejsce', f.site);
  add('Pogoda', f.weather);
  add('Wynik', f.outcome);
  const notes = String(f.notes || '').trim();
  const front = `---\ntype: flight-log\ncreated: ${day}\n---\n\n`;
  const body = `# Lot — ${name || day}\n\n${rows.join('\n')}\n${notes ? '\n## Notatki\n' + notes + '\n' : ''}`;
  await writeFile(join(V, rel), front + body, 'utf8');
  return { ok: true, savedTo: rel };
}

/** Grep the vault for a query across all .md; return matching files + snippets. */
export async function brainSearch(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return { ok: false, error: 'empty query' };
  const { files } = await brainIndex();
  const hits = [];
  for (const f of files) {
    let content;
    try { content = await readFile(join(vault(), f.path), 'utf8'); } catch { continue; }
    const idx = content.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 60);
    const snippet = content.slice(start, idx + q.length + 120).replace(/\s+/g, ' ').trim();
    hits.push({ path: f.path, snippet });
    if (hits.length >= 12) break;
  }
  return { ok: true, count: hits.length, hits };
}
