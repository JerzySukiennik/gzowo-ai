// bridge/projects-index.js — builds a LIGHT description index of PROJECTS_DIR.
// Contract (shared): buildIndex(projectsDir) -> [{name, description, stack[],
// status, path, updated}]. Reads only shallow metadata files (README/SPEC/
// CLAUDE + a few root *.md), NEVER the full source — Gzowo knows projects at
// the description level, not their contents. Result is cached for 5 minutes.
// Never throws: a per-project failure is logged and that project is skipped.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Directory names we never treat as a project.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

// Priority metadata files read first for the description.
const PRIORITY_FILES = ['README.md', 'SPEC.md', 'CLAUDE.md'];

// Max characters read per file (cheap scan, never the whole thing).
const MAX_READ = 3000;

// Max extra root-level *.md files (beyond the priority set) scanned per project.
const MAX_EXTRA_MD = 4;

// Keyword -> canonical stack label. Scanned case-insensitively across the
// concatenated metadata text. Order defines scan order; output is deduped.
const STACK_KEYWORDS = [
  [/three\.?js/i, 'three.js'],
  [/\brapier\b/i, 'rapier'],
  [/firebase|firestore/i, 'firebase'],
  [/\bnode(?:\.?js)?\b/i, 'node'],
  [/\barduino\b/i, 'arduino'],
  [/\bopenscad\b/i, 'openscad'],
  [/\bopenrocket\b/i, 'openrocket'],
  [/\bpython\b/i, 'python'],
  [/c\+\+|\bcpp\b/i, 'c++'],
  [/\bgemini\b/i, 'gemini'],
  [/cloudflare|\bworker\b/i, 'cloudflare'],
  [/\bnetlify\b/i, 'netlify'],
  [/html|css|javascript|\bjs\b/i, 'html/css/js']
];

// Module-level 5-minute cache. buildIndex returns the cached array while fresh.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { ts: 0, data: null };

/**
 * Strip enough markdown to get a clean one-paragraph description.
 * @param {string} md
 * @returns {string}
 */
function firstParagraph(md) {
  const lines = md.split(/\r?\n/);
  const buf = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (buf.length) break; // blank line ends the first paragraph
      continue;              // skip leading blanks
    }
    if (line.startsWith('#')) continue;              // skip headings
    if (/^[-*_]{3,}$/.test(line)) continue;          // skip horizontal rules
    if (line.startsWith('>')) { buf.push(line.replace(/^>\s?/, '')); continue; }
    if (/^!\[.*\]\(.*\)\s*$/.test(line)) continue;   // skip lone images
    buf.push(line);
  }
  let text = buf.join(' ');
  // Strip common inline markdown syntax down to plain readable text.
  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')         // links -> label
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')           // code spans
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strike
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 220) text = text.slice(0, 219).trimEnd() + '…';
  return text;
}

/**
 * Detect stack labels present in the metadata blob (deduped, max 6).
 * @param {string} blob
 * @returns {string[]}
 */
function detectStack(blob) {
  const out = [];
  for (const [re, label] of STACK_KEYWORDS) {
    if (out.length >= 6) break;
    if (re.test(blob) && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Detect a status: explicit "status: X" wins, else a version mention (vX.Y),
 * else 'unknown'.
 * @param {string} blob
 * @returns {string}
 */
function detectStatus(blob) {
  const explicit = blob.match(/status[:\s]+\*{0,2}([\w./-]+)/i);
  if (explicit) return explicit[1].toLowerCase();
  const version = blob.match(/\bv\d+(?:\.\d+){0,2}\b/i);
  if (version) return version[0].toLowerCase();
  return 'unknown';
}

/**
 * Safely read up to MAX_READ chars of a file. Returns '' if missing/unreadable.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readSlice(filePath) {
  try {
    const buf = await readFile(filePath, 'utf8');
    return buf.slice(0, MAX_READ);
  } catch {
    return '';
  }
}

/**
 * Build metadata for a single project directory. Returns null on failure so
 * the caller can skip it without aborting the whole index.
 * @param {string} projectsDir
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function indexProject(projectsDir, name) {
  const path = join(projectsDir, name);
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return null;

    // Read priority files, then up to MAX_EXTRA_MD more root-level *.md files.
    const chunks = [];
    for (const f of PRIORITY_FILES) {
      const text = await readSlice(join(path, f));
      if (text) chunks.push(text);
    }

    let extraMd = [];
    try {
      const entries = await readdir(path, { withFileTypes: true });
      extraMd = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map((e) => e.name)
        .filter((n) => !PRIORITY_FILES.includes(n))
        .slice(0, MAX_EXTRA_MD);
    } catch {
      extraMd = [];
    }
    for (const f of extraMd) {
      const text = await readSlice(join(path, f));
      if (text) chunks.push(text);
    }

    const blob = chunks.join('\n\n');
    const description = blob ? firstParagraph(blob) : '';
    const stack = blob ? detectStack(blob) : [];
    const status = blob ? detectStatus(blob) : 'unknown';

    return {
      name,
      description,
      stack,
      status,
      path,
      updated: st.mtime.toISOString()
    };
  } catch (err) {
    console.warn('[projects-index] skip', name, '-', err.message);
    return null;
  }
}

/**
 * Scan the first level of PROJECTS_DIR and build a light index. Cached 5 min.
 * Never throws.
 * @param {string} projectsDir
 * @returns {Promise<object[]>}
 */
export async function buildIndex(projectsDir) {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    console.warn('[projects-index] cannot read PROJECTS_DIR', projectsDir, '-', err.message);
    cache = { ts: now, data: [] };
    return [];
  }

  const dirNames = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.') && !SKIP_DIRS.has(n));

  const results = await Promise.all(
    dirNames.map((name) => indexProject(projectsDir, name))
  );
  const data = results.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

  cache = { ts: now, data };
  return data;
}
