// Shared "Download as ZIP" sheet: tick the images you want, then save the archive
// wherever you like (Chrome's Save As dialog picks the location).
import { buildZip } from './zip.js';
import { downloadBlobAs } from './downloads.js';
import { $, el, extFromMime, fmtBytes, log, toast } from './utils.js';

let items = [];
let selected = new Set();
let busy = false;
let controller = null;

function setProgress(p, label) {
  $('zipProgressWrap').hidden = p == null;
  if (p != null) $('zipProgress').style.width = `${Math.round(p * 100)}%`;
  $('zipStatus').textContent = label || '';
}

function close() {
  if (busy) return;
  $('zipModal').hidden = true;
  items = [];
  selected = new Set();
}

function renderCount() {
  $('zipCount').textContent = `${selected.size} of ${items.length} selected`;
  $('zipGo').disabled = busy || selected.size === 0;
}

function renderGrid() {
  $('zipGrid').replaceChildren(
    ...items.map((it) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = selected.has(it.id);
      const tile = el(
        'label',
        { class: `zip-tile${box.checked ? '' : ' off'}`, title: it.name },
        box,
        it.thumbUrl
          ? el('img', { src: it.thumbUrl, alt: '', loading: 'lazy' })
          : el('div', { class: 'zip-noimg', text: it.kind === 'video' ? '🎞' : '🖼' }),
        el('span', { class: 'zip-name', text: it.name })
      );
      box.addEventListener('change', () => {
        if (box.checked) selected.add(it.id);
        else selected.delete(it.id);
        tile.classList.toggle('off', !box.checked);
        renderCount();
      });
      return tile;
    })
  );
  renderCount();
}

async function run() {
  const chosen = items.filter((i) => selected.has(i.id));
  if (!chosen.length) return;
  busy = true;
  controller = new AbortController();
  $('zipCancel').textContent = 'Cancel';
  $('zipClose').disabled = true;
  renderCount();
  let done = false;
  try {
    const files = [];
    for (let i = 0; i < chosen.length; i++) {
      if (controller.signal.aborted) throw new Error('Cancelled');
      setProgress((i / chosen.length) * 0.5, `Reading ${chosen[i].name} · ${i + 1}/${chosen.length}`);
      const blob = await chosen[i].getBlob();
      const ext = extFromMime(blob.type, chosen[i].kind === 'video' ? 'mp4' : 'png');
      files.push({ name: `${chosen[i].name}.${ext}`, blob });
    }
    const zip = await buildZip(files, {
      signal: controller.signal,
      onProgress: (p) => setProgress(0.5 + p * 0.5, 'Building archive…'),
    });
    setProgress(1, `Saving ${fmtBytes(zip.size)} — choose where`);
    const name = ($('zipName').value.trim() || 'flowbatch').replace(/\.zip$/i, '');
    await downloadBlobAs(zip, `${name}.zip`);
    log(`ZIP saved: ${name}.zip — ${files.length} file(s), ${fmtBytes(zip.size)}`, 'ok');
    toast(`ZIP saved · ${files.length} file${files.length === 1 ? '' : 's'}`);
    done = true;
  } catch (e) {
    const cancelled = /cancel/i.test(e.message);
    log(cancelled ? 'ZIP cancelled' : `ZIP failed: ${e.message}`, cancelled ? 'warn' : 'error');
    toast(cancelled ? 'Cancelled' : e.message, 4000);
  } finally {
    busy = false;
    controller = null;
    setProgress(null, '');
    $('zipClose').disabled = false;
    $('zipCancel').textContent = 'Close';
    if (done) close();
    else renderCount();
  }
}

/** items: [{ id, name, thumbUrl?, kind?, getBlob() }] — everything starts ticked. */
export function openZipPicker({ title, note, items: list, filename }) {
  if (!list?.length) return toast('Nothing to put in a ZIP yet');
  items = list;
  selected = new Set(list.map((i) => i.id));
  $('zipTitle').textContent = title || 'Download as ZIP';
  $('zipNote').textContent = note || '';
  $('zipNote').hidden = !note;
  $('zipName').value = (filename || 'flowbatch').replace(/\.zip$/i, '');
  $('zipCancel').textContent = 'Close';
  setProgress(null, '');
  $('zipModal').hidden = false;
  renderGrid();
  return undefined;
}

export function initZip() {
  $('zipClose').addEventListener('click', close);
  $('zipCancel').addEventListener('click', () => (busy ? controller?.abort() : close()));
  $('zipAll').addEventListener('click', () => {
    selected = new Set(items.map((i) => i.id));
    renderGrid();
  });
  $('zipNone').addEventListener('click', () => {
    selected = new Set();
    renderGrid();
  });
  $('zipInvert').addEventListener('click', () => {
    selected = new Set(items.filter((i) => !selected.has(i.id)).map((i) => i.id));
    renderGrid();
  });
  $('zipGo').addEventListener('click', run);
  $('zipModal').addEventListener('click', (e) => e.target === $('zipModal') && close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('zipModal').hidden && close());
}
