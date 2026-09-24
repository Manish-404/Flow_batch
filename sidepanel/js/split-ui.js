// "Split video" card: cut the video loaded in Frame extractor into clips every N seconds,
// then save the ones you want, zip them, or send them to Flow as references.
import { app, on, persistSession } from './app.js';
import { getLoadedVideo } from './frames-ui.js';
import { splitVideo, clipPlan, pickMime, MAX_CLIPS } from './split.js';
import { downloadBlob } from './downloads.js';
import { openZipPicker } from './zip-ui.js';
import { findFlowTab, callAgent } from './flow.js';
import { $, el, pad, extFromMime, fmtBytes, fmtDuration, sanitizeSegment, blobToDataUrl, log, toast } from './utils.js';

// A clip travels to the Flow tab as a data: URL in one message; past this it gets slow and fragile.
const FLOW_CLIP_LIMIT = 40 * 1024 * 1024;

let clips = []; // { id, name, start, end, blob, url, include }
let controller = null;
let sending = false;

const s = () => app.session.split;
const folder = () => `${sanitizeSegment(app.settings.baseFolder, 'FlowBatch')}/${sanitizeSegment(app.session.projectName, 'Untitled')}/clips`;
const selected = () => clips.filter((c) => c.include);

function renderSource() {
  const v = getLoadedVideo();
  $('splitSource').textContent = v
    ? `Source: ${v.file.name} · ${v.info.duration.toFixed(2)}s · ${v.info.width}×${v.info.height}`
    : 'Load a video in Frame extractor first (Video file or From URL).';
  $('splitSource').classList.toggle('warn', !v);
  $('btnSplit').disabled = !!controller || !v;
  updateEstimate();
}

function updateEstimate() {
  const v = getLoadedVideo();
  if (!v) {
    $('splitEstimate').textContent = '';
    return;
  }
  const plan = clipPlan(v.info.duration, s());
  const secs = plan.reduce((n, c) => n + (c.end - c.start), 0);
  const mime = pickMime(s().format);
  const container = mime.startsWith('video/mp4') ? 'MP4' : 'WebM';
  $('splitEstimate').textContent = plan.length
    ? `≈ ${plan.length} clip${plan.length === 1 ? '' : 's'} of ${Number(s().clipSec) || 5}s · ${container} · takes about ${fmtDuration(secs * 1000)}` +
      (plan.length >= MAX_CLIPS ? ` (capped at ${MAX_CLIPS})` : '')
    : 'Nothing to split — check Start and End.';
}

function renderClips() {
  $('splitList').replaceChildren(
    ...clips.map((c) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = c.include;
      const row = el(
        'div',
        { class: `split-row${c.include ? '' : ' off'}` },
        el('label', { class: 'split-pick' }, box),
        el('video', { src: c.url, controls: true, muted: true, playsinline: true, preload: 'metadata' }),
        el(
          'div',
          { class: 'split-meta' },
          el('b', { text: c.name }),
          el('span', { text: `${c.start.toFixed(1)}s → ${c.end.toFixed(1)}s` }),
          el('span', { text: fmtBytes(c.blob.size) })
        )
      );
      box.addEventListener('change', () => {
        c.include = box.checked;
        row.classList.toggle('off', !box.checked);
        renderCount();
      });
      return row;
    })
  );
  renderCount();
}

function renderCount() {
  const n = selected().length;
  const size = selected().reduce((t, c) => t + c.blob.size, 0);
  $('splitActions').hidden = clips.length === 0;
  $('splitExport').hidden = clips.length === 0;
  $('splitCount').textContent = `${n} of ${clips.length} selected · ${fmtBytes(size)}`;
  for (const id of ['btnSplitSave', 'btnSplitZip', 'btnSplitToFlow']) $(id).disabled = n === 0 || sending || !!controller;
}

function releaseClips() {
  clips.forEach((c) => URL.revokeObjectURL(c.url));
  clips = [];
}

async function run() {
  const v = getLoadedVideo();
  if (!v) return toast('Load a video in Frame extractor first');
  const o = { ...s() };
  const prefix = String(o.prefix ?? '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'clip_';
  if (clips.length && !confirm(`Replace the ${clips.length} clip(s) from the last split?`)) return undefined;
  releaseClips();
  renderClips();
  controller = new AbortController();
  $('btnSplit').disabled = true;
  $('btnCancelSplit').hidden = false;
  $('splitProgressWrap').hidden = false;
  $('splitProgress').style.width = '0%';
  $('splitStatus').textContent = 'Starting…';

  try {
    const { total, mime } = await splitVideo(v.file, o, {
      signal: controller.signal,
      onNote: (m) => log(m, 'warn'),
      onProgress: (p) => ($('splitProgress').style.width = `${Math.round(p * 100)}%`),
      onClip: async ({ index, start, end, blob }) => {
        const name = `${prefix}${pad(index + 1)}`;
        clips.push({ id: crypto.randomUUID(), name, start, end, blob, url: URL.createObjectURL(blob), include: true });
        $('splitStatus').textContent = `Recorded ${name} (${start.toFixed(1)}s → ${end.toFixed(1)}s)`;
        renderClips();
        if (o.toDownloads) await downloadBlob(blob, `${folder()}/${name}`, extFromMime(blob.type, 'webm'));
      },
    });
    const cancelled = controller.signal.aborted;
    const msg = `${cancelled ? 'Cancelled after' : 'Split into'} ${clips.length} of ${total} clip${total === 1 ? '' : 's'}`;
    log(`${msg} · ${mime.split(';')[0]}${o.toDownloads ? ` → Downloads/${folder()}` : ''}`, cancelled ? 'warn' : 'ok');
    toast(msg);
  } catch (e) {
    log(`Split failed: ${e.message}`, 'error');
    toast(e.message, 4000);
  } finally {
    controller = null;
    $('btnCancelSplit').hidden = true;
    $('splitProgressWrap').hidden = true;
    $('splitStatus').textContent = '';
    renderSource();
    renderCount();
  }
  return undefined;
}

async function saveSelected() {
  const chosen = selected();
  for (const c of chosen) await downloadBlob(c.blob, `${folder()}/${c.name}`, extFromMime(c.blob.type, 'webm'));
  log(`Saved ${chosen.length} clip(s) → Downloads/${folder()}`, 'ok');
  toast(`Saving ${chosen.length} clip${chosen.length === 1 ? '' : 's'}`);
}

function zipSelected() {
  openZipPicker({
    title: 'Video clips → ZIP',
    note: 'Untick any clip you do not want in the archive.',
    filename: `${sanitizeSegment(app.session.projectName, 'clips')}_clips`,
    items: selected().map((c) => ({ id: c.id, name: c.name, kind: 'video', thumbUrl: null, getBlob: async () => c.blob })),
  });
}

/**
 * Attach each selected clip to Flow's prompt box as a reference, one at a time, through the same
 * upload path the queue uses for images. Nothing is typed or submitted — you write the prompt.
 */
async function sendToFlow() {
  const chosen = selected();
  const tooBig = chosen.filter((c) => c.blob.size > FLOW_CLIP_LIMIT);
  if (tooBig.length) {
    toast(`${tooBig.length} clip(s) over ${fmtBytes(FLOW_CLIP_LIMIT)} — use a shorter clip or lower quality`, 5000);
    return;
  }
  if (!confirm(`Attach ${chosen.length} clip(s) to the prompt box in your Flow tab? Nothing will be submitted.`)) return;
  sending = true;
  renderCount();
  const selectors = app.settings.selectors;
  let ok = 0;
  try {
    const tab = await findFlowTab({ open: true, flowUrl: app.settings.flowUrl });
    await chrome.tabs.update(tab.id, { active: true });
    await callAgent(tab.id, 'waitReady', { selectors, timeoutMs: 30000 }, { timeoutMs: 40000 });
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      $('splitStatus').textContent = `Uploading ${c.name} to Flow · ${i + 1}/${chosen.length}`;
      const dataUrl = await blobToDataUrl(c.blob);
      const r = await callAgent(
        tab.id,
        'attachImage',
        { selectors, name: c.name, dataUrl, type: c.blob.type },
        { timeoutMs: 180000, retries: 0 }
      );
      if (r.confirmed) ok++;
      log(
        `Flow: attached ${c.name} via ${r.method}${r.confirmed ? '' : ' — not confirmed; Flow may not accept video here'}` +
          `${r.dialogClicks?.length ? ` · clicked ${r.dialogClicks.join(', ')}` : ''}`,
        r.confirmed ? 'ok' : 'warn'
      );
      if (r.openDialogs?.length) log(`Flow dialog still open: ${r.openDialogs.join(' | ')}`, 'warn');
    }
    toast(ok === chosen.length ? `Attached ${ok} clip(s) in Flow` : `${ok} of ${chosen.length} confirmed — see the Activity log`, 5000);
  } catch (e) {
    log(`Send to Flow failed: ${e.message}`, 'error');
    toast(e.message, 5000);
  } finally {
    sending = false;
    $('splitStatus').textContent = '';
    renderCount();
  }
}

export function initSplit() {
  const o = s();
  const bind = (id, key, parse = (v) => v) => {
    const input = $(id);
    if (input.type === 'checkbox') input.checked = !!o[key];
    else input.value = o[key] ?? '';
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
      o[key] = input.type === 'checkbox' ? input.checked : parse(input.value);
      persistSession();
      updateEstimate();
    });
  };
  const num = (v) => (v === '' ? '' : Number(v));
  bind('splitLen', 'clipSec', num);
  bind('splitStart', 'start', num);
  bind('splitEnd', 'end', num);
  bind('splitPrefix', 'prefix');
  bind('splitFormat', 'format');
  bind('splitQuality', 'quality');
  bind('splitToDownloads', 'toDownloads');

  $('btnSplit').addEventListener('click', run);
  $('btnCancelSplit').addEventListener('click', () => controller?.abort());
  $('btnSplitAll').addEventListener('click', () => {
    clips.forEach((c) => (c.include = true));
    renderClips();
  });
  $('btnSplitNone').addEventListener('click', () => {
    clips.forEach((c) => (c.include = false));
    renderClips();
  });
  $('btnSplitClear').addEventListener('click', () => {
    if (clips.length && !confirm(`Discard all ${clips.length} clip(s)?`)) return;
    releaseClips();
    renderClips();
  });
  $('btnSplitSave').addEventListener('click', saveSelected);
  $('btnSplitZip').addEventListener('click', zipSelected);
  $('btnSplitToFlow').addEventListener('click', sendToFlow);
  on('videoChanged', renderSource);
  renderSource();
  renderClips();
}
