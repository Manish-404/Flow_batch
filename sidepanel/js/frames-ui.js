// "Frame extractor" card.
import { app, on, persistSession } from './app.js';
import { addAssets, removeAssets } from './assets-ui.js';
import { probeVideo, frameTimes, extractVideoFrames, captureTabFrames, MAX_FRAMES } from './frames.js';
import { downloadBlob } from './downloads.js';
import { openZipPicker } from './zip-ui.js';
import { $, el, pad, sanitizeSegment, log, toast } from './utils.js';

let videoFile = null;
let videoInfo = null;
let videoUrl = null;
let controller = null;
let extracted = []; // { id, name, blob, time, assetId, thumbUrl } from the latest run

const f = () => app.session.frames;

function syncSource() {
  const tab = f().source === 'tab';
  document.querySelectorAll('[data-frame-source]').forEach((b) => b.classList.toggle('active', b.dataset.frameSource === f().source));
  $('frameVideoBox').hidden = tab;
  document.querySelectorAll('[data-video-only]').forEach((n) => (n.hidden = tab));
  document.querySelectorAll('[data-tab-only]').forEach((n) => (n.hidden = !tab));
  updateEstimate();
}

function updateEstimate() {
  const o = f();
  let text = '';
  if (o.source === 'tab') {
    const secs = Math.max(0.5, Number(o.interval) || 1);
    text = `≈ ${Math.min(MAX_FRAMES, Number(o.count) || 0)} screenshots of the active tab, one every ${secs}s (min 0.5s).`;
  } else if (videoInfo) {
    const n = frameTimes(videoInfo.duration, o).length;
    text = `≈ ${n} frame${n === 1 ? '' : 's'} · ${o.prefix}${pad(o.startNum)} … ${o.prefix}${pad(Number(o.startNum) + n - 1)}${n >= MAX_FRAMES ? ` (capped at ${MAX_FRAMES})` : ''}`;
  } else {
    text = 'Choose a video to see how many frames will be extracted.';
  }
  $('frameEstimate').textContent = text;
}

function renderResultRow() {
  const n = extracted.length;
  $('frameResultRow').hidden = n === 0;
  $('frameResultCount').textContent = `${n} frame${n === 1 ? '' : 's'} from the last run`;
}

function releaseExtracted() {
  extracted.forEach((e) => e.thumbUrl && URL.revokeObjectURL(e.thumbUrl));
  extracted = [];
}

async function clearFrames() {
  const withAssets = extracted.filter((e) => e.assetId).length;
  const msg = withAssets
    ? `Clear the ${extracted.length} extracted frame${extracted.length === 1 ? '' : 's'}? ${withAssets} will also be removed from Upload assets.`
    : `Clear the ${extracted.length} extracted frame${extracted.length === 1 ? '' : 's'} from the preview?`;
  if (!confirm(msg)) return;
  if (withAssets) await removeAssets(extracted.map((e) => e.assetId).filter(Boolean));
  $('framePreview').replaceChildren();
  releaseExtracted();
  $('frameProgressWrap').hidden = true;
  renderResultRow();
  toast('Frames cleared');
}

function zipFrames() {
  openZipPicker({
    title: 'Extracted frames → ZIP',
    note: 'Untick any frame you do not want in the archive.',
    filename: `${sanitizeSegment(app.session.projectName, 'frames')}_frames`,
    items: extracted.map((e) => ({ id: e.id, name: e.name, thumbUrl: e.thumbUrl, kind: 'image', getBlob: async () => e.blob })),
  });
}

function bindInput(id, key, parse = (v) => v) {
  const input = $(id);
  const value = f()[key];
  if (input.type === 'checkbox') input.checked = !!value;
  else input.value = value ?? '';
  input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
    f()[key] = input.type === 'checkbox' ? input.checked : parse(input.value);
    persistSession();
    updateEstimate();
  });
}

async function run() {
  const o = { ...f() };
  if (o.source === 'video' && !videoFile) return toast('Choose a video first');
  const prefix = String(o.prefix ?? '').replace(/[^A-Za-z0-9_-]+/g, '_');
  const folder = `${sanitizeSegment(app.settings.baseFolder, 'FlowBatch')}/${sanitizeSegment(app.session.projectName, 'Untitled')}/frames`;
  controller = new AbortController();
  $('btnExtract').disabled = true;
  $('btnCancelExtract').hidden = false;
  $('frameProgressWrap').hidden = false;
  $('frameProgress').style.width = '0%';
  $('framePreview').replaceChildren();
  releaseExtracted();
  renderResultRow();

  let pending = [];
  let total = 0;
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const created = await addAssets(batch.map(({ blob, name }) => ({ blob, name })));
    // addAssets may rename on collision — keep the frame list in step with the real asset.
    created.forEach((asset, i) => {
      batch[i].entry.assetId = asset.id;
      batch[i].entry.name = asset.name;
    });
  };
  const onFrame = async ({ index, time, blob }) => {
    const name = `${prefix}${pad(Number(o.startNum) + index)}`;
    total++;
    const entry = { id: crypto.randomUUID(), name, blob, time, assetId: null, thumbUrl: URL.createObjectURL(blob) };
    extracted.push(entry);
    $('framePreview').append(
      el('figure', {}, el('img', { src: entry.thumbUrl, alt: name }), el('figcaption', { text: `${name} · ${time.toFixed(2)}s` }))
    );
    if (o.toAssets) pending.push({ blob, name, entry });
    if (o.toDownloads) await downloadBlob(blob, `${folder}/${name}`, o.format === 'jpg' ? 'jpg' : 'png');
    if (pending.length >= 10) await flush();
  };
  const onProgress = (p) => ($('frameProgress').style.width = `${Math.round(p * 100)}%`);

  try {
    if (o.source === 'tab') {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      await captureTabFrames({ windowId: win.id, interval: o.interval, count: o.count, format: o.format }, { onFrame, onProgress, signal: controller.signal });
    } else {
      await extractVideoFrames(videoFile, o, { onFrame, onProgress, signal: controller.signal });
    }
    await flush();
    const msg = `${controller.signal.aborted ? 'Cancelled after' : 'Extracted'} ${total} frame${total === 1 ? '' : 's'}`;
    log(`${msg}${o.toAssets ? ' → assets' : ''}${o.toDownloads ? ` → Downloads/${folder}` : ''}`, 'ok');
    toast(msg);
  } catch (e) {
    await flush();
    log(`Frame extraction failed: ${e.message}`, 'error');
    toast(e.message, 4000);
  } finally {
    controller = null;
    $('btnExtract').disabled = false;
    $('btnCancelExtract').hidden = true;
    renderResultRow();
  }
}

export function initFrames() {
  document.querySelectorAll('[data-frame-source]').forEach((b) =>
    b.addEventListener('click', () => {
      f().source = b.dataset.frameSource;
      persistSession();
      syncSource();
    })
  );
  $('btnChooseVideo').addEventListener('click', () => $('videoInput').click());
  $('videoInput').addEventListener('change', async () => {
    const file = $('videoInput').files[0];
    $('videoInput').value = '';
    if (!file) return;
    try {
      videoInfo = await probeVideo(file);
      videoFile = file;
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      videoUrl = URL.createObjectURL(file);
      $('videoPreview').src = videoUrl;
      $('videoPreview').hidden = false;
      $('videoMeta').textContent = `${file.name} · ${videoInfo.duration.toFixed(2)}s · ${videoInfo.width}×${videoInfo.height}`;
      $('btnChooseVideo').textContent = 'Change video…';
    } catch (e) {
      videoFile = null;
      videoInfo = null;
      $('videoPreview').hidden = true;
      $('videoMeta').textContent = e.message;
    }
    updateEstimate();
  });
  const num = (v) => (v === '' ? '' : Number(v));
  bindInput('frameInterval', 'interval', num);
  bindInput('frameStart', 'start', num);
  bindInput('frameEnd', 'end', num);
  bindInput('frameCount', 'count', num);
  bindInput('framePrefix', 'prefix');
  bindInput('frameStartNum', 'startNum', num);
  bindInput('frameFormat', 'format');
  bindInput('frameToAssets', 'toAssets');
  bindInput('frameToDownloads', 'toDownloads');
  $('btnExtract').addEventListener('click', run);
  $('btnCancelExtract').addEventListener('click', () => controller?.abort());
  $('btnZipFrames').addEventListener('click', zipFrames);
  $('btnClearFrames').addEventListener('click', clearFrames);
  // Frames removed from the Upload assets card should not linger in this card's list.
  on('assetsChanged', () => {
    const live = new Set(app.assets.map((a) => a.id));
    extracted.forEach((e) => {
      if (e.assetId && !live.has(e.assetId)) e.assetId = null;
    });
  });
  syncSource();
  renderResultRow();
}
