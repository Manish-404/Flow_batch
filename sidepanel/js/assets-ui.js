// "Upload assets" card: add / rename / remove reference images (persisted in IndexedDB).
import { app, emit, persistSession } from './app.js';
import { putAsset, deleteAsset, clearAssets } from './store.js';
import { openZipPicker } from './zip-ui.js';
import { $, el, sanitizeName, sanitizeSegment, naturalCompare, toast } from './utils.js';

function uniqueName(base, exceptId) {
  const taken = new Set(app.assets.filter((a) => a.id !== exceptId).map((a) => a.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`.toLowerCase())) return `${base}_${i}`;
}

/** items: [{ blob, name }] — returns the created assets. */
export async function addAssets(items) {
  let order = app.assets.reduce((m, a) => Math.max(m, a.order), 0) + 1;
  const created = [];
  for (const { blob, name } of items) {
    const asset = {
      id: crypto.randomUUID(),
      name: uniqueName(sanitizeName(name)),
      type: blob.type || 'image/png',
      blob,
      order: order++,
    };
    await putAsset(asset);
    asset.thumbUrl = URL.createObjectURL(blob);
    app.assets.push(asset);
    created.push(asset);
  }
  renderAssets();
  emit('assetsChanged');
  return created;
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/')).sort((a, b) => naturalCompare(a.name, b.name));
  if (!files.length) return toast('No image files found');
  await addAssets(files.map((f) => ({ blob: f, name: f.name })));
  toast(`Added ${files.length} image${files.length > 1 ? 's' : ''}`);
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

export async function removeAllAssets() {
  await clearAssets();
  app.assets.forEach((a) => URL.revokeObjectURL(a.thumbUrl));
  app.assets = [];
  renderAssets();
  emit('assetsChanged');
}

export function renderAssets() {
  const grid = $('assetGrid');
  grid.replaceChildren(
    ...app.assets.map((a) => {
      const input = el('input', { value: a.name, spellcheck: 'false', title: 'Rename' });
      input.addEventListener('change', () => renameAsset(a, input));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      return el(
        'div',
        { class: 'asset' },
        el('img', { src: a.thumbUrl, alt: a.name, loading: 'lazy' }),
        el('button', { class: 'x', title: 'Remove', text: '✕', onclick: () => removeAsset(a) }),
        input,
        el('span', { class: 'at', text: `@${a.name}` })
      );
    })
  );
  const n = app.assets.length;
  $('assetCount').textContent = `${n} image${n === 1 ? '' : 's'}`;
  $('assetActions').hidden = n === 0;
  $('dropzone').classList.toggle('compact', n > 0);
  $('dropText').textContent = n ? 'Add more images' : 'Drop images here, or click to browse';
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
      note: 'Untick any image you do not want in the archive.',
      filename: `${sanitizeSegment(app.session.projectName, 'flowbatch')}_assets`,
      items: app.assets.map((a) => ({ id: a.id, name: a.name, thumbUrl: a.thumbUrl, kind: 'image', getBlob: async () => a.blob })),
    })
  );
  renderAssets();
}
