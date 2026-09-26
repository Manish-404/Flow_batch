// "Upload assets" card: add / rename / remove reference images and video clips (persisted in
// IndexedDB), and mark the ones already uploaded to Flow or Gemini so a run doesn't upload them again.
import { app, on, emit, persistSession } from './app.js';
import { putAsset, deleteAsset, clearAssets } from './store.js';
import { openZipPicker } from './zip-ui.js';
import { SITES, findSiteTab } from './site.js';
import { FLOW_VIDEO_TYPES, FLOW_MAX_BYTES } from './split.js';
import { cleanGeminiImage } from './mark-clean.js';
import { $, el, sanitizeName, sanitizeSegment, naturalCompare, isVideoAsset, assetFileName, geminiChatId, fmtBytes, log, toast } from './utils.js';

const site = () => (app.session.site === 'gemini' ? 'gemini' : 'flow');

/** A small picture of the asset for chips and menus: the image, or a film glyph for a clip. */
export const assetIcon = (a) => (isVideoAsset(a) ? el('span', { class: 'vid-dot', text: '🎞' }) : el('img', { src: a.thumbUrl, alt: '' }));

function assetThumb(a) {
  if (!isVideoAsset(a)) return el('img', { src: a.thumbUrl, alt: a.name, loading: 'lazy' });
  // The clip itself: shows its first frame, plays while hovered.
  const v = el('video', { src: a.thumbUrl, preload: 'metadata', playsinline: true, loop: true });
  v.muted = true;
  v.addEventListener('mouseenter', () => v.play().catch(() => {}));
  v.addEventListener('mouseleave', () => v.pause());
  return v;
}

const saveRecord = ({ thumbUrl, ...record }) => putAsset(record);

/**
 * Record that `asset` is already uploaded to `site` — `mark.file` is the name the site knows it
 * by; for Gemini, `mark.chat` is the chat it is in — or clear that with `mark = null`.
 * Call renderAssets() afterwards.
 */
export async function setOnSite(asset, siteKey, mark) {
  const onSite = { ...(asset.onSite || {}) };
  if (mark) onSite[siteKey] = { at: Date.now(), ...mark, file: mark.file || onSite[siteKey]?.file || assetFileName(asset) };
  else delete onSite[siteKey];
  asset.onSite = onSite;
  await saveRecord(asset);
}

// A Gemini file lives in one chat: remember which, so a run in another chat uploads it again.
async function newMark(s) {
  if (s !== 'gemini') return {};
  const tab = await findSiteTab('gemini', { open: false }).catch(() => null);
  return { chat: geminiChatId(tab?.url) };
}

function onSiteHint(a) {
  const s = site();
  const { name } = SITES[s];
  const mark = a.onSite?.[s];
  if (!mark) return `Not marked: FlowBatch uploads @${a.name} to ${name} each time a prompt uses it. Click if ${name} already has it.`;
  return s === 'flow'
    ? `Already in Flow as “${mark.file}”: FlowBatch picks it from Flow's file picker instead of uploading it (and uploads it if it isn't found there). Click to unmark.`
    : `Already in ${mark.chat ? `Gemini chat ${mark.chat}` : 'the open Gemini chat'} as “${mark.file}”: FlowBatch doesn't upload it and names that file in the prompt instead — ` +
        `only in that chat, with “Start a new Gemini chat for each prompt” off. Click to unmark.`;
}

function onSiteToast(a, s, marked) {
  const { name } = SITES[s];
  if (!marked) return `@${a.name} will be uploaded to ${name} again`;
  if (s === 'flow') return `@${a.name}: picked from Flow's file picker instead of uploaded (uploaded if it isn't there)`;
  return app.settings.geminiNewChat
    ? `@${a.name} marked — but each prompt starts a new Gemini chat (Settings), so it will still be uploaded`
    : `@${a.name}: not uploaded — the prompt names ${a.onSite.gemini.file}, already in this chat`;
}

async function toggleOnSite(a) {
  const s = site();
  const marked = !a.onSite?.[s];
  await setOnSite(a, s, marked ? await newMark(s) : null);
  renderAssets();
  toast(onSiteToast(a, s, marked), 5000);
}

async function markAll() {
  const s = site();
  const marked = !app.assets.every((a) => a.onSite?.[s]);
  const mark = marked ? await newMark(s) : null;
  for (const a of app.assets) await setOnSite(a, s, mark);
  renderAssets();
  const { name } = SITES[s];
  toast(
    !marked
      ? `Marks cleared — assets will be uploaded to ${name}`
      : s === 'gemini' && app.settings.geminiNewChat
        ? `Marked — but each prompt starts a new Gemini chat (Settings), so they will still be uploaded`
        : `All ${app.assets.length} assets marked as already in ${name}`,
    5000
  );
}

function uniqueName(base, exceptId) {
  const taken = new Set(app.assets.filter((a) => a.id !== exceptId).map((a) => a.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`.toLowerCase())) return `${base}_${i}`;
}

/** items: [{ blob, name, onSite? }] — returns the created assets. */
export async function addAssets(items) {
  let order = app.assets.reduce((m, a) => Math.max(m, a.order), 0) + 1;
  const created = [];
  for (const { blob, name, onSite } of items) {
    const asset = {
      id: crypto.randomUUID(),
      name: uniqueName(sanitizeName(name)),
      type: blob.type || 'image/png',
      blob,
      order: order++,
    };
    if (onSite) asset.onSite = onSite;
    await putAsset(asset);
    asset.thumbUrl = URL.createObjectURL(blob);
    app.assets.push(asset);
    created.push(asset);
  }
  renderAssets();
  emit('assetsChanged');
  return created;
}

/** Swap an asset's file, keeping its id, name, marks and @mentions. Call renderAssets() afterwards. */
export async function replaceAssetFile(asset, blob) {
  URL.revokeObjectURL(asset.thumbUrl);
  asset.blob = blob;
  asset.type = blob.type || asset.type;
  asset.thumbUrl = URL.createObjectURL(blob);
  await saveRecord(asset);
  emit('assetsChanged');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Clips go in only when Flow takes them as they are; Split video converts the rest.
function videoProblem(f) {
  if (!FLOW_VIDEO_TYPES.test(f.type)) return `Flow takes MP4, MOV, M4V, 3GP or AVI, not ${f.type.replace('video/', '').toUpperCase()}`;
  if (f.size > FLOW_MAX_BYTES) return `${fmtBytes(f.size)} is over the ${fmtBytes(FLOW_MAX_BYTES)} FlowBatch sends as is`;
  return null;
}

async function addFiles(fileList) {
  const media = [...fileList].filter((f) => /^(image|video)\//.test(f.type)).sort((a, b) => naturalCompare(a.name, b.name));
  const skipped = media.filter((f) => f.type.startsWith('video/') && videoProblem(f));
  const files = media.filter((f) => !skipped.includes(f));
  skipped.forEach((f) =>
    log(`${f.name} not added: ${videoProblem(f)}. Load it in Frame extractor and use Split video → + Assets, which converts it.`, 'warn')
  );
  if (!files.length) return toast(skipped.length ? `${plural(skipped.length, 'video')} not added — see the Activity log` : 'No image or video files found', 5000);
  await addAssets(files.map((f) => ({ blob: f, name: f.name })));
  const clips = files.filter((f) => f.type.startsWith('video/')).length;
  const added = [files.length - clips && plural(files.length - clips, 'image'), clips && plural(clips, 'clip')].filter(Boolean).join(' and ');
  return toast(`Added ${added}${skipped.length ? ` · ${skipped.length} not added, see the Activity log` : ''}`, skipped.length ? 5000 : 2600);
}

async function renameAsset(asset, input) {
  const next = uniqueName(sanitizeName(input.value), asset.id);
  input.value = next;
  if (next === asset.name) return;
  const old = asset.name;
  asset.name = next;
  const { thumbUrl, ...record } = asset;
  await putAsset(record);
  // Keep existing prompts pointing at the renamed asset.
  const re = new RegExp(`@${old.replace(/[-]/g, '\\-')}(?![A-Za-z0-9_-])`, 'gi');
  if (re.test(app.session.promptText)) {
    app.session.promptText = app.session.promptText.replace(re, `@${next}`);
    persistSession();
    emit('promptChanged');
  }
  renderAssets();
  emit('assetsChanged');
}

async function removeAsset(asset) {
  await deleteAsset(asset.id);
  URL.revokeObjectURL(asset.thumbUrl);
  app.assets = app.assets.filter((a) => a.id !== asset.id);
  renderAssets();
  emit('assetsChanged');
}

/** Remove several assets at once; ids that are already gone are ignored. */
export async function removeAssets(ids) {
  const set = new Set(ids);
  for (const asset of app.assets.filter((a) => set.has(a.id))) {
    await deleteAsset(asset.id);
    URL.revokeObjectURL(asset.thumbUrl);
  }
  app.assets = app.assets.filter((a) => !set.has(a.id));
  renderAssets();
  emit('assetsChanged');
}

/** Remove the visible Gemini sparkle from image assets (ones downloaded from Gemini by hand). */
async function cleanAssets() {
  const images = app.assets.filter((a) => !isVideoAsset(a));
  if (!images.length) return toast('No image assets');
  if (!confirm(`Look for the visible Gemini sparkle in ${plural(images.length, 'image')} and remove it where found?

Images without it are left as they are. Google's invisible SynthID watermark is not affected.`)) return;
  const btn = $('btnCleanAssets');
  btn.disabled = true;
  let cleaned = 0;
  try {
    for (const [i, a] of images.entries()) {
      btn.textContent = `✦ ${i + 1}/${images.length}`;
      const r = await cleanGeminiImage(a.blob);
      if (!r.found) continue;
      URL.revokeObjectURL(a.thumbUrl);
      a.blob = r.blob;
      a.type = r.blob.type;
      a.thumbUrl = URL.createObjectURL(r.blob);
      delete a.onSite; // the site has the marked copy, not this one
      await saveRecord(a);
      cleaned++;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ Clean';
  }
  renderAssets();
  emit('assetsChanged');
  log(`Gemini sparkle removed from ${cleaned} of ${images.length} image asset(s)`, cleaned ? 'ok' : 'info');
  toast(cleaned ? `Removed the Gemini sparkle from ${plural(cleaned, 'image')}` : 'No visible Gemini sparkle found');
  return undefined;
}

export async function removeAllAssets() {
  await clearAssets();
  app.assets.forEach((a) => URL.revokeObjectURL(a.thumbUrl));
  app.assets = [];
  renderAssets();
  emit('assetsChanged');
}

export function renderAssets() {
  const grid = $('assetGrid');
  const s = site();
  const siteName = SITES[s].name;
  grid.replaceChildren(
    ...app.assets.map((a) => {
      const input = el('input', { value: a.name, spellcheck: 'false', title: 'Rename' });
      input.addEventListener('change', () => renameAsset(a, input));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      const marked = !!a.onSite?.[s];
      return el(
        'div',
        { class: 'asset' },
        el(
          'div',
          { class: 'thumb' },
          assetThumb(a),
          isVideoAsset(a) ? el('span', { class: 'vid', text: '🎞' }) : null,
          el('button', {
            class: `onsite${marked ? ' on' : ''}`,
            type: 'button',
            text: marked ? `✓ In ${siteName}` : `☁ In ${siteName}?`,
            title: onSiteHint(a),
            onclick: () => toggleOnSite(a),
          })
        ),
        el('button', { class: 'x', title: 'Remove', text: '✕', onclick: () => removeAsset(a) }),
        input,
        el('span', { class: 'at', text: `@${a.name}` })
      );
    })
  );
  const n = app.assets.length;
  const clips = app.assets.filter(isVideoAsset).length;
  $('assetCount').textContent = clips ? `${plural(n - clips, 'image')} · ${plural(clips, 'clip')}` : plural(n, 'image');
  $('assetActions').hidden = n === 0;
  $('dropzone').classList.toggle('compact', n > 0);
  $('dropText').textContent = n ? 'Add more images or clips' : 'Drop images or video clips here, or click to browse';
  const all = n > 0 && app.assets.every((a) => a.onSite?.[s]);
  $('btnMarkAssets').textContent = all ? `☁ Unmark all` : `☁ All in ${siteName}`;
  $('btnMarkAssets').title = all
    ? `Clear the marks — FlowBatch will upload these assets to ${siteName} again`
    : `Mark every asset as already uploaded to ${siteName}, so a run doesn't upload them again`;
}

export function initAssets() {
  const dz = $('dropzone');
  const fileInput = $('fileInput');
  const folderInput = $('folderInput');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click());
  $('btnFolder').addEventListener('click', () => folderInput.click());
  fileInput.addEventListener('change', async () => {
    await addFiles(fileInput.files);
    fileInput.value = '';
  });
  folderInput.addEventListener('change', async () => {
    await addFiles(folderInput.files);
    folderInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) =>
    dz.addEventListener(t, (e) => {
      e.preventDefault();
      dz.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('drag')));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
  $('btnClearAssets').addEventListener('click', async () => {
    if (!confirm(`Remove all ${app.assets.length} assets?`)) return;
    await removeAllAssets();
  });
  $('btnZipAssets').addEventListener('click', () =>
    openZipPicker({
      title: 'Assets → ZIP',
      note: 'Untick any file you do not want in the archive.',
      filename: `${sanitizeSegment(app.session.projectName, 'flowbatch')}_assets`,
      items: app.assets.map((a) => {
        const video = isVideoAsset(a);
        return { id: a.id, name: a.name, thumbUrl: video ? null : a.thumbUrl, kind: video ? 'video' : 'image', getBlob: async () => a.blob };
      }),
    })
  );
  $('btnMarkAssets').addEventListener('click', markAll);
  $('btnCleanAssets').addEventListener('click', cleanAssets);
  on('siteChanged', renderAssets);
  renderAssets();
}
