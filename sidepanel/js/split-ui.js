// "Split video" card: cut the video loaded in Frame extractor into clips every N seconds,
// then save the ones you want, zip them, or send them to Flow as references.
import { app, on, persistSession } from './app.js';
import { getLoadedVideo } from './frames-ui.js';
import { splitVideo, clipPlan, pickMime, toFlowMp4, FLOW_VIDEO_TYPES, MAX_CLIPS } from './split.js';
import { downloadBlob } from './downloads.js';
import { openZipPicker } from './zip-ui.js';
import { findFlowTab, callAgent, stageFiles } from './flow.js';
import { $, el, pad, extFromMime, fmtBytes, fmtDuration, sanitizeSegment, log, toast } from './utils.js';

// Clips Flow can take (MP4) up to this size go as they are; anything else is re-encoded first.
const FLOW_MAX_BYTES = 40 * 1024 * 1024;
// Size budget for a re-encoded copy — small enough to upload quickly.
const FLOW_TARGET_BYTES = 25 * 1024 * 1024;

let clips = []; // { id, name, start, end, blob, url, include, flowBlob?, flow? }
let controller = null; // splitting
let sender = null; // sending to Flow

const s = () => app.session.split;
const folder = () => `${sanitizeSegment(app.settings.baseFolder, 'FlowBatch')}/${sanitizeSegment(app.session.projectName, 'Untitled')}/clips`;
const selected = () => clips.filter((c) => c.include);
const busy = () => !!controller || !!sender;
const flowReady = (b) => FLOW_VIDEO_TYPES.test(b.type) && b.size <= FLOW_MAX_BYTES;

function setBar(p) {
  $('splitProgressWrap').hidden = p == null;
  if (p != null) $('splitProgress').style.width = `${Math.round(p * 100)}%`;
}

function renderSource() {
  const v = getLoadedVideo();
  $('splitSource').textContent = v
    ? `Source: ${v.file.name} · ${v.info.duration.toFixed(2)}s · ${v.info.width}×${v.info.height}`
    : 'Load a video in Frame extractor first (Video file or From URL).';
  $('splitSource').classList.toggle('warn', !v);
  $('btnSplit').disabled = busy() || !v;
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
  const mp4 = pickMime(s().format).startsWith('video/mp4');
  $('splitEstimate').textContent = plan.length
    ? `≈ ${plan.length} clip${plan.length === 1 ? '' : 's'} of ${Number(s().clipSec) || 5}s · ${mp4 ? 'MP4' : 'WebM'} · takes about ${fmtDuration(secs * 1000)}` +
      (plan.length >= MAX_CLIPS ? ` (capped at ${MAX_CLIPS})` : '') +
      (mp4 ? '' : ' · Flow only takes MP4, so WebM clips are converted when you send them')
    : 'Nothing to split — check Start and End.';
}

function flowLine(c) {
  if (!c.flow) return null;
  const cls = { ok: 'ok', error: 'bad', unconfirmed: 'warnc' }[c.flow.state];
  return el('span', { class: `split-flow ${cls}`, text: c.flow.text, title: c.flow.text });
}

function renderClips() {
  $('splitList').replaceChildren(
    ...clips.map((c) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = c.include;
      const type = (c.flowBlob || c.blob).type.includes('mp4') ? 'MP4' : 'WebM';
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
          el('span', { text: `${fmtBytes(c.blob.size)} · ${type}` }),
          flowLine(c)
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
  for (const id of ['btnSplitSave', 'btnSplitZip', 'btnSplitToFlow']) $(id).disabled = n === 0 || busy();
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
  setBar(0);
  $('splitStatus').textContent = 'Starting…';

  try {
    const { total, mime } = await splitVideo(v.file, o, {
      signal: controller.signal,
      onNote: (m) => log(m, 'warn'),
      onProgress: setBar,
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
    setBar(null);
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

/** A copy of the clip that Flow will take: MP4, and small enough to upload quickly. */
async function forFlow(c, signal) {
  if (flowReady(c.blob)) return c.blob;
  if (c.flowBlob && flowReady(c.flowBlob)) return c.flowBlob;
  const why = FLOW_VIDEO_TYPES.test(c.blob.type) ? `${fmtBytes(c.blob.size)} is over ${fmtBytes(FLOW_MAX_BYTES)}` : 'Flow does not accept WebM';
  log(`${c.name}: re-encoding to MP4 (${why})`);
  const out = await toFlowMp4(c.blob, {
    seconds: Math.max(0.5, c.end - c.start),
    maxBytes: FLOW_TARGET_BYTES,
    quality: s().quality,
    signal,
    onNote: (m) => log(m, 'warn'),
  });
  if (out.size > FLOW_MAX_BYTES) throw new Error(`${c.name} is still ${fmtBytes(out.size)} after re-encoding — split it into shorter clips`);
  c.flowBlob = out;
  return out;
}

/**
 * Send every selected clip to Flow's prompt box in one batch: convert what Flow can't take,
 * stream the files into the tab, attach them together, then report per clip whether Flow
 * showed it or rejected it by name. Nothing is typed or submitted.
 */
async function sendToFlow() {
  const chosen = selected();
  if (!chosen.length) return;
  const needConvert = chosen.filter((c) => !flowReady(c.blob) && !(c.flowBlob && flowReady(c.flowBlob)));
  const convertSecs = needConvert.reduce((n, c) => n + (c.end - c.start), 0);
  const plan = needConvert.length
    ? `\n\n${needConvert.length} of them will be converted to MP4 first (about ${fmtDuration(convertSecs * 1000)}) — Flow does not accept WebM or files over ${fmtBytes(FLOW_MAX_BYTES)}.`
    : '';
  if (!confirm(`Attach ${chosen.length} clip(s) to the prompt box in your Flow tab? Nothing will be submitted.${plan}`)) return;

  sender = new AbortController();
  const signal = sender.signal;
  chosen.forEach((c) => (c.flow = null));
  renderClips();
  renderSource();
  $('btnCancelSplit').hidden = false;
  let keys = null;
  let tab = null;
  try {
    // 1. Make every clip Flow-ready.
    const files = [];
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      if (signal.aborted) throw new Error('Cancelled');
      if (!flowReady(c.blob) && !(c.flowBlob && flowReady(c.flowBlob))) {
        $('splitStatus').textContent = `Converting ${c.name} to MP4 · ${i + 1}/${chosen.length}`;
        setBar(i / chosen.length);
      }
      const blob = await forFlow(c, signal);
      files.push({ blob, name: `${c.name}.${extFromMime(blob.type, 'mp4')}`, type: blob.type });
    }
    renderClips();

    // 2. Stream them into the Flow tab.
    tab = await findFlowTab({ open: true, flowUrl: app.settings.flowUrl });
    await chrome.tabs.update(tab.id, { active: true });
    const selectors = app.settings.selectors;
    await callAgent(tab.id, 'waitReady', { selectors, timeoutMs: 30000 }, { timeoutMs: 40000 });
    keys = await stageFiles(tab.id, files, {
      signal,
      onProgress: (p, sent, total) => {
        setBar(p);
        $('splitStatus').textContent = `Sending to Flow · ${fmtBytes(sent)} / ${fmtBytes(total)}`;
      },
    });

    // 3. Attach them together and wait for Flow's verdict on each.
    const totalMB = files.reduce((n, f) => n + f.blob.size, 0) / 1048576;
    const settleMs = Math.min(300000, 45000 + totalMB * 2000);
    $('splitStatus').textContent = `Waiting for Flow to accept ${files.length} clip${files.length === 1 ? '' : 's'}…`;
    setBar(1);
    const r = await callAgent(tab.id, 'attachFiles', { selectors, keys, settleMs }, { timeoutMs: settleMs + 60000, retries: 0 });
    keys = null; // consumed by the tab

    const rejected = r.files.filter((f) => f.error).length;
    const allShown = r.added >= r.expected - rejected;
    r.files.forEach((f, i) => {
      const c = chosen[i];
      if (f.error) c.flow = { state: 'error', text: `Flow rejected it: ${f.error}` };
      else if (allShown) c.flow = { state: 'ok', text: 'In Flow ✓' };
      else c.flow = { state: 'unconfirmed', text: 'Sent — not seen on the page yet' };
    });
    const ok = chosen.filter((c) => c.flow?.state === 'ok').length;
    log(`Flow: ${r.method} · ${ok}/${r.expected} confirmed, ${rejected} rejected, ${r.added} new on the page`, rejected || ok < r.expected ? 'warn' : 'ok');
    r.files.filter((f) => f.error).forEach((f) => log(`Flow rejected ${f.name}: ${f.error}`, 'error'));
    r.otherErrors.forEach((t) => log(`Flow message: ${t}`, 'warn'));
    if (r.openDialogs?.length) log(`Flow dialog still open: ${r.openDialogs.join(' | ')}`, 'warn');
    toast(
      ok === chosen.length
        ? `All ${ok} clip${ok === 1 ? '' : 's'} are in Flow`
        : rejected
          ? `${rejected} clip(s) rejected by Flow — see the Activity log`
          : `${ok} of ${chosen.length} confirmed — Flow may still be processing; check the tab`,
      6000
    );
  } catch (e) {
    const cancelled = /cancel/i.test(e.message);
    log(cancelled ? 'Send to Flow cancelled' : `Send to Flow failed: ${e.message}`, cancelled ? 'warn' : 'error');
    toast(cancelled ? 'Cancelled' : e.message, 5000);
    if (keys && tab) callAgent(tab.id, 'dropStaged', { keys }, { timeoutMs: 10000, retries: 0 }).catch(() => {});
  } finally {
    sender = null;
    $('btnCancelSplit').hidden = true;
    setBar(null);
    $('splitStatus').textContent = '';
    renderClips();
    renderSource();
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
  $('btnCancelSplit').addEventListener('click', () => {
    controller?.abort();
    sender?.abort();
  });
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
