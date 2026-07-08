// bridge/brain.js — "Jurek's 2nd Brain" connector backend.
// Read-only access to the ClaudeMemory vault (all .md, skips dotdirs/.obsidian)
// + APPEND-ONLY drafts to inbox/gzowoai-drafts.md. NOTHING else is writable.
// Every route is gated by X-Brain-Pass (BRAIN_PASS in bridge/.env). Honest only.

import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { readFile, appendFile, readdir } from 'node:fs/promises';
import { resolve, join, relative, extname, sep } from 'node:path';

const DRAFTS_REL = 'inbox/gzowoai-drafts.md';

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
