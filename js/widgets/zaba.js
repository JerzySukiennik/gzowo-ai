// js/widgets/zaba.js — the "Żaba" easter egg (Jurek, v3 #11).
// Saying "Żaba" to Gzowo spawns a widget with the frog gif + the Playtime tune.
// ONE-SHOT by design: the music plays exactly once and when it ends the widget
// throws ITSELF into the trash (fly-to-trash + crumple). Assets are vendored in
// assets/zaba/ (gif + AAC ripped from Jurek's .m4r ringtone) and served by the
// bridge / Pages — no external fetches.
//
// The gif is the ONLY colorful thing on screen — allowed: color lives INSIDE
// widgets (design law). Chrome around it stays B&W.

import { defineWidget } from './widget-base.js';
import { toolRouter } from '../core/tool-router.js';
import { layout } from '../core/layout-engine.js';

const GIF_URL = 'assets/zaba/zaba.gif';
const MUSIC_URL = 'assets/zaba/playtime.m4a';
const EXIT_DELAY_MS = 600;   // beat between the music ending and the trash throw
const MAX_LIFE_MS = 90_000;  // hard stop if 'ended' never fires (broken audio)

export function zabaDef() {
  return defineWidget({
    id: 'zaba',
    title: 'ŻABA',
    color: null,
    size: 'md',
    render(bodyEl) {
      let alive = true;
      let exitTimer = 0;
      let lifeTimer = 0;

      bodyEl.innerHTML =
        '<div class="zaba">' +
          '<img class="zaba-gif" alt="Żaba" src="' + GIF_URL + '">' +
        '</div>';
      // Self-contained styles (one-off widget — not worth a stylesheet).
      const wrap = bodyEl.querySelector('.zaba');
      Object.assign(wrap.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%'
      });
      const img = bodyEl.querySelector('.zaba-gif');
      Object.assign(img.style, {
        maxWidth: '100%', maxHeight: '100%', objectFit: 'contain'
      });

      const audio = new Audio(MUSIC_URL);
      audio.loop = false;               // ONE-SHOT (decided 2026-07-09)

      function selfDestruct() {
        if (!alive) return;
        alive = false;
        // The frog throws itself out — same trash choreography as "schowaj to".
        try { layout.removeWidget('zaba', { toTrash: true }); } catch (_e) { /* gone */ }
      }

      audio.addEventListener('ended', () => {
        exitTimer = window.setTimeout(selfDestruct, EXIT_DELAY_MS);
      });
      audio.addEventListener('error', () => {
        // No music (bad codec/offline) — keep the gif for a moment, then leave.
        exitTimer = window.setTimeout(selfDestruct, 8000);
      });
      audio.play().catch(() => {
        // Autoplay refused (no gesture yet) — the gif still shows; timed exit.
        exitTimer = window.setTimeout(selfDestruct, 8000);
      });
      lifeTimer = window.setTimeout(selfDestruct, MAX_LIFE_MS);

      return () => {
        alive = false;
        clearTimeout(exitTimer);
        clearTimeout(lifeTimer);
        try { audio.pause(); audio.src = ''; } catch (_e) { /* already dead */ }
      };
    }
  });
}

export async function init() {
  toolRouter.registerWidget('zaba', zabaDef);
  toolRouter.registerTool(
    {
      name: 'show_zaba',
      description: 'ŻABA! Gdy Jurek powie samo „żaba" (albo poprosi o żabę), natychmiast ' +
        'wywołaj to narzędzie — pokazuje widget z gifem żaby i muzyką Playtime. Gra raz i ' +
        'sam znika. Nie dopytuj, po prostu odpal.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => {
      layout.addWidget(zabaDef());
      // v4 #20: the frog is a compact SQUARE tile matched to the 224px gif
      // (+ header), not a huge grid cell.
      try { layout.shapeWidget('zaba', { square: true, max: 264 }); } catch (_e) { /* stub */ }
      return { ok: true, note: 'Żaba skacze — gif + muzyka lecą, zniknie sama po utworze.' };
    }
  );
}
