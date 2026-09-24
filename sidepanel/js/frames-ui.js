// "Frame extractor" card.
import { app, on, emit, persistSession } from './app.js';
import { addAssets, removeAssets } from './assets-ui.js';
import { probeVideo, frameTimes, extractVideoFrames, captureTabStream, captureTabFrames, fetchVideoFile, MAX_FRAMES } from './frames.js';
import { downloadBlob } from './downloads.js';
import { openZipPicker } from './zip-ui.js';
import { $, el, pad, sanitizeSegment, fmtDuration, log, toast } from './utils.js';

let videoFile = null;
let videoInfo = null;
let videoUrl = null;
let controller = null;
let extracted = []; // { id, name, blob, time, assetId, thumbUrl } from the latest run

const f = () => app.session.frames;
const isTab = () => f().source === 'tab';

/** The video currently loaded here (file or URL) — the Split video card works on the same one. */
export const getLoadedVideo = () => (videoFile ? { file: videoFile, info: videoInfo } : null);

function syncSource() {
  const src = f().source;
  document.querySelectorAll('[data-frame-source]').forEach((b) => b.classList.toggle('active', b.dataset.frameSource === src));
  $('frameFileBox').hidden = src !== 'video';
  $('frameUrlBox').hidden = src !== 'url';
  $('frameCaptureBox').hidden = src !== 'tab';
  $('frameVideoBox').hidden = src === 'tab';
  document.querySelectorAll('[data-video-only]').forEach((n) => (n.hidden = src === 'tab'));
  document.querySelectorAll('[data-tab-only]').forEach((n) => (n.hidden = src !== 'tab'));
  $('btnExtract').textContent = src === 'tab' ? 'Capture frames' : 'Extract frames';
  updateEstimate();
}

function updateEstimate() {
  const o = f();
  let text = '';
  if (o.source === 'tab') {
    const secs = Math.max(0.05, Number(o.interval) || 1);
    const n = Math.min(MAX_FRAMES, Number(o.count) || 0);
    text = `≈ ${n} frame${n === 1 ? '' : 's'} from the active tab, one every ${secs}s · about ${fmtDuration(n * secs * 1000)} of real time`;
  } else if (videoInfo) {
    const n = frameTimes(videoInfo.duration, o).length;
    text = `≈ ${n} frame${n === 1 ? '' : 's'} · ${o.prefix}${pad(o.startNum)} … ${o.prefix}${pad(Number(o.startNum) + n - 1)}${n >= MAX_FRAMES ? ` (capped at ${MAX_FRAMES})` : ''}`;
  } else {
    text = o.source === 'url' ? 'Load a video URL to see how many frames will be extracted.' : 'Choose a video to see how many frames will be extracted.';
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

/** Adopt a File (picked from disk or fetched from a URL) as the extraction source. */
async function useVideoFile(file) {
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
    toast(e.message, 4000);
  }
  updateEstimate();
  emit('videoChanged');
}

async function loadFromUrl() {
  const url = $('frameVideoUrl').value.trim();
  if (!url) return toast('Paste a link to a video file');
  const btn = $('btnLoadUrl');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  $('videoMeta').textContent = 'Fetching…';
  try {
    const file = await fetchVideoFile(url);
    await useVideoFile(file);
    log(`Loaded video from URL: ${file.name} (${Math.round(file.size / 1024)} KB)`, 'ok');
  } catch (e) {
    $('videoMeta').textContent = e.message;
    log(`Video URL failed: ${e.message}`, 'error');
    toast(e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load';
  }
  return undefined;
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
  if (!isTab() && !videoFile) return toast(o.source === 'url' ? 'Load a video URL first' : 'Choose a video first');
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
  const onStream = (stream) => {
    const pv = $('capturePreview');
    pv.srcObject = stream;
    pv.hidden = false;
    pv.play().catch(() => {});
  };
  const onNote = (m) => log(m, 'warn');

  try {
    if (isTab()) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) throw new Error('No active tab to capture');
      log(`Capturing tab: ${tab.title || tab.url}`);
      try {
        await captureTabStream({ tabId: tab.id, ...o }, { onFrame, onProgress, onStream, onNote, signal: controller.signal });
      } catch (e) {
        log(`Tab capture unavailable (${e.message}) — falling back to tab screenshots at 2/sec`, 'warn');
        await captureTabFrames({ windowId: tab.windowId, ...o }, { onFrame, onProgress, signal: controller.signal });
      }
    } else {
      await extractVideoFrames(videoFile, o, { onFrame, onProgress, signal: controller.signal });
    }
    await flush();
    const msg = `${controller.signal.aborted ? 'Cancelled after' : 'Captured'} ${total} frame${total === 1 ? '' : 's'}`;
    log(`${msg}${o.toAssets ? ' → assets' : ''}${o.toDownloads ? ` → Downloads/${folder}` : ''}`, 'ok');
    toast(msg);
  } catch (e) {
    await flush();
    log(`Frame extraction failed: ${e.message}`, 'error');
    toast(e.message, 4000);
  } finally {
    controller = null;
    const pv = $('capturePreview');
    pv.srcObject = null;
    pv.hidden = true;
    $('btnExtract').disabled = false;
    $('btnCancelExtract').hidden = true;
    renderResultRow();
  }
  return undefined;
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
    if (file) await useVideoFile(file);
  });
  $('btnLoadUrl').addEventListener('click', loadFromUrl);
  $('frameVideoUrl').addEventListener('keydown', (e) => e.key === 'Enter' && loadFromUrl());
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
  bindInput('frameCropToVideo', 'cropToVideo');
  bindInput('frameVideoUrl', 'videoUrl');
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
