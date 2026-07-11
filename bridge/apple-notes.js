// bridge/apple-notes.js — Apple Notes bridge (macOS only, via osascript).
// Lets Gzowo add a line to a note (e.g. "Zakupy") and read it back. The note
// syncs through iCloud, so it shows up on Jurek's iPhone too. Local-only: this
// runs on the Mac that hosts the bridge; the deployed site has no bridge.
//
// FIRST RUN prompts macOS for permission to control "Notes" (Automation) — Jurek
// must click OK once. Honest failures: any osascript error returns {ok:false}.

import { execFile } from 'node:child_process';

const APPLE_NOTES_ENABLED = process.platform === 'darwin';

function osa(script) {
  return new Promise((resolve) => {
    if (!APPLE_NOTES_ENABLED) { resolve({ ok: false, error: 'apple notes tylko na macOS' }); return; }
    execFile('osascript', ['-e', script], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || err).trim();
        // -1743 / "Not authorized" = user hasn't granted Automation permission yet.
        if (/-1743|not authoriz/i.test(msg)) {
          resolve({ ok: false, error: 'Brak zgody macOS na sterowanie Notatkami — pozwól w oknie systemowym (lub System Settings → Privacy → Automation).' });
          return;
        }
        resolve({ ok: false, error: msg || 'osascript error' });
        return;
      }
      resolve({ ok: true, out: String(stdout || '').trim() });
    });
  });
}

// AppleScript string escape (wrap client text safely).
function esc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// Strip the HTML that Notes stores as the body into readable lines.
function htmlToLines(html) {
  return String(html || '')
    .replace(/<div>/gi, '\n').replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Append a line to the note titled `title`. Creates the note if missing.
 * @returns {Promise<{ok:boolean, note?:string, error?:string}>}
 */
export async function appleNotesAdd(title, line) {
  const t = esc(title); const l = esc(line);
  if (!String(title || '').trim() || !String(line || '').trim()) {
    return { ok: false, error: 'podaj notatkę i treść' };
  }
  const script =
    'tell application "Notes"\n' +
    '  if not (exists note "' + t + '") then\n' +
    '    make new note with properties {name:"' + t + '", body:"' + t + '<div>' + l + '</div>"}\n' +
    '  else\n' +
    '    set n to note "' + t + '"\n' +
    '    set body of n to (body of n) & "<div>' + l + '</div>"\n' +
    '  end if\n' +
    'end tell';
  const r = await osa(script);
  return r.ok ? { ok: true, note: title } : r;
}

/**
 * Read the note titled `title` back as an array of lines (first line = title).
 * @returns {Promise<{ok:boolean, note?:string, items?:string[], error?:string}>}
 */
export async function appleNotesRead(title) {
  const t = esc(title);
  if (!String(title || '').trim()) return { ok: false, error: 'podaj nazwę notatki' };
  const script =
    'tell application "Notes"\n' +
    '  if not (exists note "' + t + '") then\n' +
    '    return "__NONE__"\n' +
    '  else\n' +
    '    return body of note "' + t + '"\n' +
    '  end if\n' +
    'end tell';
  const r = await osa(script);
  if (!r.ok) return r;
  if (r.out === '__NONE__') return { ok: true, note: title, items: [], missing: true };
  const lines = htmlToLines(r.out);
  // Drop the leading title line Notes echoes as the first body line.
  if (lines.length && lines[0].toLowerCase() === String(title).toLowerCase()) lines.shift();
  return { ok: true, note: title, items: lines };
}

export { APPLE_NOTES_ENABLED };
