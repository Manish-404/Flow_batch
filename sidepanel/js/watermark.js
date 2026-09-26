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

/** Where the mark sits for an image of this size: [{ size, x, y }] — the usual one first. */
export function markBoxes(w, h) {
  const big = { size: 96, x: w - 64 - 96, y: h - 64 - 96 };
  const small = { size: 48, x: w - 32 - 48, y: h - 32 - 48 };
  const boxes = w > 1024 && h > 1024 ? [big, small] : [small, big];
  return boxes.filter((b) => b.x >= 4 && b.y >= 4);
}

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

/** Per-pixel α estimate inside the box against a guessed background (NaN where unknowable). */
function estimateAlpha(px, w, box, fill) {
  const { out, n, x0, y0 } = fill;
  const pad = box.x - x0;
  const a = new Float32Array(box.size * box.size);
  for (let y = 0; y < box.size; y++) {
    for (let x = 0; x < box.size; x++) {
      let sum = 0;
      let cnt = 0;
      for (let c = 0; c < 3; c++) {
        const o = out[((y + pad) * n + (x + pad)) * 3 + c];
        const s = px[((box.y + y) * w + (box.x + x)) * 4 + c];
        if (255 - o < 24) continue; // background already near white: α can't be read here
        sum += (s - o) / (255 - o);
        cnt++;
      }
      a[y * box.size + x] = cnt ? Math.min(1, Math.max(0, sum / cnt)) : NaN;
    }
  }
  return a;
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
 * `learned`: { [size]: { n, alpha: number[] (0–255) } } — read, and updated when a mark is found.
 * Returns { found, size, method }.
 */
export function cleanPixels(px, w, h, learned = {}) {
  let best = null;
  for (const box of markBoxes(w, h)) {
    const pad = Math.max(3, box.size >> 4);
    if (box.x - pad < 0 || box.y - pad < 0) continue;
    const fill = fillFromSurroundings(px, w, box, pad);
    const a = estimateAlpha(px, w, box, fill);
    const score = sparkleScore(a, box.size);
    if (score.found && (!best || score.centre - score.corner > best.score.centre - best.score.corner)) best = { box, fill, a, score };
  }
  if (!best) return { found: false };
  const { box, fill, a } = best;
  const size = box.size;
  const pad = box.x - fill.x0;
  const memo = learned[size];
  const useLearned = memo && memo.n >= LEARN_AFTER && memo.alpha?.length === size * size;

  // Scale the learned pattern to this image (it should be ~1; JPEG and resizing shift it a little).
  let k = 1;
  if (useLearned) {
    let num = 0, den = 0;
    for (let i = 0; i < a.length; i++) {
      if (Number.isNaN(a[i])) continue;
      const t = memo.alpha[i] / 255;
      num += a[i] * t;
      den += t * t;
    }
    k = den > 0 ? Math.min(1.4, Math.max(0.6, num / den)) : 1;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const alpha = useLearned ? Math.min(0.98, (memo.alpha[i] / 255) * k) : a[i];
      if (!(alpha > 0.015)) continue;
      const p = ((box.y + y) * w + (box.x + x)) * 4;
      for (let c = 0; c < 3; c++) {
        const guess = fill.out[((y + pad) * fill.n + (x + pad)) * 3 + c];
        let v;
        if (useLearned && alpha < 0.85) v = (px[p + c] - 255 * alpha) / (1 - alpha); // exact un-blend
        else v = guess; // opaque core, or nothing learned yet: fill from around
        px[p + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }

  // Learn: fold this estimate into the running average for the size.
  const prev = memo?.alpha?.length === size * size ? memo : { n: 0, alpha: new Array(size * size).fill(0) };
  const n = Math.min(prev.n, 49); // cap so the average keeps adapting
  learned[size] = {
    n: prev.n + 1,
    alpha: prev.alpha.map((old, i) => (Number.isNaN(a[i]) ? old : Math.round((old * n + a[i] * 255) / (n + 1)))),
  };
  return { found: true, size, method: useLearned ? 'learned pattern' : 'filled from surroundings' };
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
