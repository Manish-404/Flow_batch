// Removing the visible Gemini sparkle from images Gemini generated for you.
//
// Gemini alpha-blends a white four-point sparkle into the bottom-right corner: 48 px with a 32 px
// margin on images up to 1024 px, 96 px with a 64 px margin on larger ones. Blending is
//   shown = α·255 + (1 − α)·original
// so with α known the original comes back exactly: original = (shown − 255α) / (1 − α).
// α is learned from your own images — each detected mark adds its estimate to a running average
// kept per size — and until enough are seen, the mark is filled in from its surroundings instead.
// Only the visible mark is touched: Google's invisible SynthID watermark and the file's
// metadata are left as they are.

const LEARN_AFTER = 3; // detected marks before the learned pattern is used for exact removal

/**
 * Where the mark may sit in a w×h picture: [{ size, x, y }], likeliest first. Images: 48 px at a
 * 32 px margin (96 at 64 when both sides exceed 1024). Veo videos: 48 px at a 96 px margin
 * (measured on a 720×1280 Gemini video). The rest are nearby variants, tried in case Gemini
 * scales the mark with the picture; the one that looks most like a sparkle wins.
 */
export function markBoxes(w, h) {
  const big = w > 1024 && h > 1024;
  const spots = big
    ? [[96, 64], [48, 32], [96, 192], [48, 96], [72, 144]]
    : [[48, 32], [48, 96], [96, 64], [72, 144], [96, 192]];
  // Each box is EDGE px bigger than the mark on every side: the mark may sit a pixel or two off its
  // nominal spot, and the background is read from a ring just outside the box, which must not
  // touch the mark itself.
  return spots
    .map(([size, m]) => ({ size: size + EDGE * 2, x: w - m - size - EDGE, y: h - m - size - EDGE }))
    .filter((b) => b.x >= 8 && b.y >= 8);
}
const EDGE = 4;

/**
 * Background under the box, guessed from the pixels around it: a Coons patch from the four
 * edges, relaxed towards a smooth (harmonic) fill. Returns Float32Array(size² · 3).
 */
function fillFromSurroundings(px, w, box, pad) {
  const n = box.size + pad * 2;
  const x0 = box.x - pad;
  const y0 = box.y - pad;
  const at = (x, y, c) => px[((y0 + y) * w + (x0 + x)) * 4 + c];
  const out = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    const v = y / (n - 1);
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1);
      for (let c = 0; c < 3; c++) {
        const L = at(0, y, c), R = at(n - 1, y, c), T = at(x, 0, c), B = at(x, n - 1, c);
        const c00 = at(0, 0, c), c10 = at(n - 1, 0, c), c01 = at(0, n - 1, c), c11 = at(n - 1, n - 1, c);
        out[(y * n + x) * 3 + c] =
          (1 - u) * L + u * R + (1 - v) * T + v * B -
          ((1 - u) * (1 - v) * c00 + u * (1 - v) * c10 + (1 - u) * v * c01 + u * v * c11);
      }
    }
  }
  for (let it = 0; it < 120; it++) {
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        for (let c = 0; c < 3; c++) {
          const i = (y * n + x) * 3 + c;
          out[i] = (out[i - 3] + out[i + 3] + out[i - n * 3] + out[i + n * 3]) / 4;
        }
      }
    }
  }
  return { out, n, x0, y0 };
}

/**
 * Per-pixel α against a guessed background o: shown − o = α·(255 − o). Returns the estimate
 * `a` (clamped, NaN where the background is too bright to tell) and the least-squares terms
 * num = Σ(shown − o)(255 − o), den = Σ(255 − o)² over the channels, unclamped, so they can be
 * summed across many images without the bias clamping would add.
 */
function estimateAlpha(px, w, box, fill) {
  const { out, n, x0 } = fill;
  const pad = box.x - x0;
  const len = box.size * box.size;
  const a = new Float32Array(len);
  const num = new Float32Array(len);
  const den = new Float32Array(len);
  for (let y = 0; y < box.size; y++) {
    for (let x = 0; x < box.size; x++) {
      const i = y * box.size + x;
      for (let c = 0; c < 3; c++) {
        const o = out[((y + pad) * n + (x + pad)) * 3 + c];
        const s = px[((box.y + y) * w + (box.x + x)) * 4 + c];
        if (255 - o < 24) continue; // background already near white: α can't be read here
        num[i] += (s - o) * (255 - o);
        den[i] += (255 - o) * (255 - o);
      }
      a[i] = den[i] ? Math.min(1, Math.max(0, num[i] / den[i])) : NaN;
    }
  }
  return { a, num, den };
}

/** A sparkle is bright at its centre and along its arms, and absent in the box's corners. */
function sparkleScore(a, size) {
  const c = (size - 1) / 2;
  let centre = 0, nc = 0, corner = 0, nk = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = a[y * size + x];
      if (Number.isNaN(v)) continue;
      const dx = Math.abs(x - c) / size;
      const dy = Math.abs(y - c) / size;
      if (dx < 0.1 && dy < 0.1) (centre += v), nc++;
      else if (dx > 0.36 && dy > 0.36) (corner += v), nk++;
    }
  }
  if (nc < 4 || nk < 4) return { found: false, centre: 0, corner: 0 };
  centre /= nc;
  corner /= nk;
  return { found: centre > 0.12 && centre - corner > 0.1, centre, corner };
}

/**
 * Remove the mark from RGBA pixels in place.
 * `learned`: { [size]: { n, num[], den[] }, at: { 'WxH': box } } — read, and updated when a mark is found.
 * Returns { found, size, method }.
 */
export function cleanPixels(px, w, h, learned = {}) {
  let best = null;
  // Where the mark was last found at this resolution is tried first; a hit there skips the search
  // (one video's frames all share it).
  const key = `${w}x${h}`;
  const known = learned.at?.[key];
  const boxes = markBoxes(w, h);
  const order = known ? [known, ...boxes.filter((b) => b.x !== known.x || b.y !== known.y || b.size !== known.size)] : boxes;
  for (const box of order) {
    const pad = Math.max(3, box.size >> 4);
    if (box.x - pad < 0 || box.y - pad < 0) continue;
    const fill = fillFromSurroundings(px, w, box, pad);
    const est = estimateAlpha(px, w, box, fill);
    const score = sparkleScore(est.a, box.size);
    if (score.found && (!best || score.centre - score.corner > best.score.centre - best.score.corner)) best = { box, fill, est, score };
    if (best && known && box === order[0]) break; // found where it was last time
  }
  if (!best) return { found: false };
  return cleanBox(px, w, best, learned, key, best.box);
}

/**
 * The learned α map: Σnum / Σden per pixel. Gemini's sparkle is one flat opacity inside with
 * soft edges, so its inside is set to a single robust value (the median) — local errors from
 * backgrounds that happened to sit under it can't bend it — the edges keep their own values
 * (capped at it) and the faint noise around the star is zeroed.
 */
function learnedPattern(memo, len) {
  const T = memo.num.map((v, i) => (memo.den[i] > 0 ? Math.max(0, v / memo.den[i]) : 0));
  const peak = T.reduce((m, v) => Math.max(m, v), 0);
  const A = median(T.filter((v) => v > peak * 0.6));
  for (let i = 0; i < len; i++) {
    if (T[i] < 0.04) T[i] = 0;
    else if (T[i] > A * 0.75) T[i] = A;
  }
  return { T, A };
}

const median = (list) => {
  if (!list.length) return 0;
  const sorted = [...list].sort((x, y) => x - y);
  return sorted[sorted.length >> 1];
};

/**
 * The mark's opacity measured at its own edge: a pixel just inside and one 2 px outside share
 * almost the same background, so (inside − outside) / (255 − outside) is α with nearly no
 * background error — unlike comparing against a background guessed from the box's surroundings,
 * which leans high. Median over all edge pairs; null when too few can be read.
 */
function edgeOpacity(px, w, box, T, A) {
  const size = box.size;
  const ratios = [];
  const dirs = [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [-2, 2], [2, -2], [2, 2]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (T[y * size + x] < A * 0.9) continue;
      for (const [dy, dx] of dirs) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= size || xx >= size || T[yy * size + xx] !== 0) continue;
        const pi = ((box.y + y) * w + box.x + x) * 4;
        const po = ((box.y + yy) * w + box.x + xx) * 4;
        let r = 0;
        let ok = true;
        for (let c = 0; c < 3; c++) {
          if (255 - px[po + c] < 30) ok = false; // too bright outside to read
          r += (px[pi + c] - px[po + c]) / Math.max(1, 255 - px[po + c]);
        }
        if (ok) ratios.push(r / 3);
        break;
      }
    }
  }
  return ratios.length >= 20 ? median(ratios) : null;
}

/** Look for the mark in one known box (px is a w-wide buffer); { box, fill, est, score } or null. */
function probe(px, w, box) {
  const pad = Math.max(3, box.size >> 4);
  if (box.x - pad < 0 || box.y - pad < 0) return null;
  const fill = fillFromSurroundings(px, w, box, pad);
  const est = estimateAlpha(px, w, box, fill);
  const score = sparkleScore(est.a, box.size);
  return score.found ? { box, fill, est, score } : null;
}

/**
 * Remove the mark from one found box, and learn from it. `fullBox` is where the box sits in the
 * whole picture (it differs from `found.box` when px is only a crop around it).
 */
function cleanBox(px, w, found, learned, key, fullBox, learn = true) {
  const { box, fill, est } = found;
  const { a } = est;
  const size = box.size;
  const len = size * size;
  const pad = box.x - fill.x0;
  const memo = learned[size];
  const useLearned = memo && memo.n >= LEARN_AFTER && memo.num?.length === len;

  const pattern = useLearned ? learnedPattern(memo, len) : null;
  const T = pattern?.T || null;

  // The pattern gives the shape; its strength comes from edge measurements (this picture's and
  // earlier ones'), which are far less biased than the pattern's own level.
  let k = 1;
  let edgeA = memo?.edgeA || [];
  if (T && pattern.A > 0) {
    const here = edgeOpacity(px, w, box, T, pattern.A);
    if (here != null && learn) edgeA = [...edgeA, Math.round(here * 1000) / 1000].slice(-60);
    const pool = here != null && !learn ? [...edgeA, here] : edgeA;
    if (pool.length) k = Math.min(1.3, Math.max(0.7, median(pool) / pattern.A));
  }

  // Un-blend (or fill) into a buffer first, then write it back.
  const alphaAt = new Float32Array(len);
  const val = new Float32Array(len * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const alpha = T ? Math.min(0.98, T[i] * k) : a[i];
      alphaAt[i] = alpha > 0.015 ? alpha : 0;
      const p = ((box.y + y) * w + (box.x + x)) * 4;
      for (let c = 0; c < 3; c++) {
        const guess = fill.out[((y + pad) * fill.n + (x + pad)) * 3 + c];
        let v = px[p + c];
        if (alphaAt[i]) v = T && alpha < 0.85 ? (px[p + c] - 255 * alpha) / (1 - alpha) : guess; // exact un-blend, or fill
        val[i * 3 + c] = v;
      }
    }
  }
  // Un-blending multiplies compression noise by 1/(1 − α); where α is high, a 3×3 median of the
  // recovered pixels removes the isolated specks that leaves without blurring real detail.
  const out = val.slice();
  if (T) {
    const win = new Float32Array(9);
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        if (alphaAt[y * size + x] < 0.3) continue;
        for (let c = 0; c < 3; c++) {
          let m = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[m++] = val[((y + dy) * size + (x + dx)) * 3 + c];
          win.sort();
          out[(y * size + x) * 3 + c] = win[4];
        }
      }
    }
  }
  for (let i = 0; i < len; i++) {
    if (!alphaAt[i]) continue;
    const p = ((box.y + Math.floor(i / size)) * w + (box.x + (i % size))) * 4;
    for (let c = 0; c < 3; c++) px[p + c] = Math.max(0, Math.min(255, Math.round(out[i * 3 + c])));
  }

  if (!learn) return { found: true, size, method: T ? 'learned pattern' : 'filled from surroundings' };
  // Learn: add this picture's least-squares terms. Older ones fade after ~60 pictures so the
  // pattern keeps adapting; values are rounded to keep the stored settings small.
  const prev = memo?.num?.length === len ? memo : { n: 0, num: new Array(len).fill(0), den: new Array(len).fill(0) };
  const fade = prev.n >= 60 ? 60 / 61 : 1;
  const scale = 1 / 1000; // store sums in thousands
  learned[size] = {
    n: prev.n + 1,
    edgeA,
    num: prev.num.map((v, i) => Math.round((v * fade + est.num[i] * scale) * 100) / 100),
    den: prev.den.map((v, i) => Math.round((v * fade + est.den[i] * scale) * 100) / 100),
  };
  learned.at = { ...(learned.at || {}), [key]: { x: fullBox.x, y: fullBox.y, size } };
  return { found: true, size, method: useLearned ? 'learned pattern' : 'filled from surroundings' };
}

/**
 * Clean one frame drawn on a 2D canvas context (w×h). Once the mark's box is known for this
 * resolution only the pixels around it are read and written, which keeps video real-time.
 * Returns { found, size, method }.
 */
export function cleanCanvasFrame(ctx, w, h, learned, { learn = true } = {}) {
  const key = `${w}x${h}`;
  const known = learned.at?.[key];
  if (known) {
    const pad = Math.max(3, known.size >> 4);
    const side = known.size + pad * 2;
    const img = ctx.getImageData(known.x - pad, known.y - pad, side, side);
    const found = probe(img.data, side, { x: pad, y: pad, size: known.size });
    if (!found) return { found: false }; // this frame hides it (e.g. a flash to white)
    const r = cleanBox(img.data, side, found, learned, key, known, learn);
    ctx.putImageData(img, known.x - pad, known.y - pad);
    return r;
  }
  const img = ctx.getImageData(0, 0, w, h);
  const r = cleanPixels(img.data, w, h, learned);
  if (r.found) ctx.putImageData(img, 0, 0);
  return r;
}

/** Clean an image Blob. Returns { blob, found, method, size } — the original blob when no mark is found. */
export async function removeGeminiMark(blob, learned = {}) {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const r = cleanPixels(img.data, canvas.width, canvas.height, learned);
  if (!r.found) return { blob, found: false };
  ctx.putImageData(img, 0, 0);
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), ...r };
}
