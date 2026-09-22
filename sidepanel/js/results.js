// The generated results of the current queue, named the way auto-download names them.
import { app } from './app.js';
import { pad, slug, sanitizeSegment } from './utils.js';

export function generatedResults() {
  const out = [];
  for (const item of app.session.queue) {
    if (item.status !== 'success') continue;
    const base = sanitizeSegment(item.mentions.length ? item.mentions.join('_') : slug(item.prompt));
    (item.results || []).forEach((res, k) => {
      out.push({
        id: `${item.id}_${k}`,
        n: item.n,
        name: `${pad(item.n)}_${base}${item.results.length > 1 ? `_${k + 1}` : ''}`,
        kind: res.kind,
        prompt: item.prompt,
        thumbUrl: res.kind === 'image' && !res.url.startsWith('blob:') ? res.url : null,
        res,
      });
    });
  }
  return out;
}

/** Bytes for one result, read back through the Flow tab when the URL only exists there. */
export const resultBlob = (res) => app.runner.resultBlob(res);
