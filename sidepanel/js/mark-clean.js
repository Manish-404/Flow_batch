// Removing Gemini's visible sparkle with the pattern learned so far (kept in settings.geminiMark).
import { app, persistSettings } from './app.js';
import { removeGeminiMark } from './watermark.js';

/** { blob, found, method } — the same blob back when it isn't an image or has no mark. */
export async function cleanGeminiImage(blob) {
  if (!/^image\//i.test(blob?.type || '')) return { blob, found: false };
  const learned = app.settings ? (app.settings.geminiMark ||= {}) : {};
  try {
    const r = await removeGeminiMark(blob, learned);
    if (r.found && app.settings) persistSettings(); // keep what was learned
    return r;
  } catch {
    return { blob, found: false }; // an undecodable image is saved as it came
  }
}
