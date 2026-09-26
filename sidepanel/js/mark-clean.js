// Removing Gemini's visible sparkle with the pattern learned so far (kept in settings.geminiMark).
import { app, persistSettings } from './app.js';
import { removeGeminiMark } from './watermark.js';
import { removeMarkFromVideo } from './video-mark.js';

const learnedStore = () => (app.settings ? (app.settings.geminiMark ||= {}) : {});

/** { blob, found, method } — the same blob back when it isn't an image or has no mark. */
export async function cleanGeminiImage(blob) {
  if (!/^image\//i.test(blob?.type || '')) return { blob, found: false };
  const learned = learnedStore();
  try {
    const r = await removeGeminiMark(blob, learned);
    if (r.found && app.settings) persistSettings(); // keep what was learned
    return r;
  } catch {
    return { blob, found: false }; // an undecodable image is saved as it came
  }
}

/** A Veo video: { blob, found, frames, cleaned }. Plays through once in real time. */
export async function cleanGeminiVideo(blob, opts) {
  if (!/^video\//i.test(blob?.type || '')) return { blob, found: false };
  try {
    const r = await removeMarkFromVideo(blob, learnedStore(), opts);
    if (r.found && app.settings) persistSettings();
    return r;
  } catch (e) {
    if (/cancel/i.test(e.message)) throw e;
    return { blob, found: false, error: e.message }; // saved as it came
  }
}

/** Image or video, whichever `blob` is. */
export const cleanGeminiMedia = (blob, opts) => (/^video\//i.test(blob?.type || '') ? cleanGeminiVideo(blob, opts) : cleanGeminiImage(blob));
