// bridge/whisper.js — fallback STT via whisper.cpp on the Mac.
// Contract (shared): transcribe(wavBuffer, env) -> {text} | throws.
// When WHISPER_BIN is unset we throw {code:503} so the server answers a clean
// "whisper not configured" instead of pretending. Honest degradation, no fakes.
//
// Install hint (whisper.cpp):
//   brew install whisper-cpp
//   # download a ggml model, e.g. base:
//   curl -L -o ~/whisper/ggml-base.bin \
//     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
//   # then in bridge/.env:
//   WHISPER_BIN=/opt/homebrew/bin/whisper-cli
//   WHISPER_MODEL=/Users/jurek/whisper/ggml-base.bin

import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hard cap on a single transcription; kills the child if it hangs.
const TIMEOUT_MS = 60 * 1000;

/**
 * Transcribe a WAV buffer to Polish text using whisper.cpp.
 * @param {Buffer} wavBuffer  raw audio/wav bytes
 * @param {Record<string,string>} env  process.env (needs WHISPER_BIN, WHISPER_MODEL)
 * @returns {Promise<{text:string}>}
 * @throws {{code:503, message:string}} when whisper is not configured
 */
export async function transcribe(wavBuffer, env) {
  if (!env.WHISPER_BIN) {
    throw { code: 503, message: 'whisper not configured' };
  }
  // Model is required too — spawning with an empty -m would fail at runtime.
  // Degrade honestly to a 503 instead of a thrown 500.
  if (!env.WHISPER_MODEL) {
    throw { code: 503, message: 'whisper model not configured' };
  }

  const tmp = join(tmpdir(), `gzowo-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await writeFile(tmp, wavBuffer);

  // whisper.cpp flags: -m model, -l pl (Polish), -f input, -nt (no timestamps).
  // Transcript is printed to stdout; we capture and trim it.
  const args = ['-m', env.WHISPER_MODEL, '-l', 'pl', '-f', tmp, '-nt'];

  try {
    const text = await new Promise((resolve, reject) => {
      const child = spawn(env.WHISPER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('whisper timeout after 60s'));
      }, TIMEOUT_MS);

      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });

      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`whisper spawn failed: ${e.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(out.trim());
        } else {
          reject(new Error(`whisper exited ${code}: ${err.trim().slice(0, 300)}`));
        }
      });
    });

    return { text };
  } finally {
    // Always clean up the temp file, success or failure.
    await unlink(tmp).catch(() => {});
  }
}
