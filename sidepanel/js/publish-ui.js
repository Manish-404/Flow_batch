// "Publish queue" card: turn generated results into ready-to-post captions, hashtags and
// posting times, exported as one ZIP for Meta Business Suite / YouTube Studio's schedulers.
import { app, persistSession } from './app.js';
import { generatedResults, resultBlob } from './results.js';
import { buildZip } from './zip.js';
import { downloadBlobAs } from './downloads.js';
import { suggestHashtags, parseTags, formatTags, promptSummary, buildCaption, DISCLOSURE_TAGS } from './hashtags.js';
import { $, el, pad, extFromMime, fmtBytes, sanitizeSegment, log, toast } from './utils.js';

let plan = [];
let busy = false;

const p = () => app.session.publish;
const PLATFORMS = [
  ['ig', 'Instagram'],
  ['fb', 'Facebook'],
  ['yt', 'YouTube'],
];

const two = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;

function defaultStart() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return toLocalInput(d);
}

/** Whatever the chosen source offers, in a shape the plan can use. */
function sourceItems() {
  if (p().source === 'assets') {
    const byName = new Map();
    for (const q of app.session.queue) for (const m of q.mentions) if (!byName.has(m.toLowerCase())) byName.set(m.toLowerCase(), q.prompt);
    return app.assets.map((a) => ({
      id: a.id,
      name: a.name,
      kind: 'image',
      prompt: byName.get(a.name.toLowerCase()) || app.session.promptText.split(app.settings.separator)[0] || '',
      thumbUrl: a.thumbUrl,
      getBlob: async () => a.blob,
    }));
  }
  return generatedResults().map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    prompt: r.prompt,
    thumbUrl: r.thumbUrl,
    getBlob: () => resultBlob(r.res),
  }));
}

const activePlatforms = () => PLATFORMS.filter(([k]) => p().platforms[k]).map(([, label]) => label);

function buildPlan() {
  const items = sourceItems();
  if (!items.length) {
    toast(p().source === 'assets' ? 'No assets yet' : 'No generated results yet — run the queue first');
    return;
  }
  const tags = parseTags(p().hashtags);
  const start = p().startAt ? new Date(p().startAt) : new Date();
  const stepMs = Math.max(0.25, Number(p().everyHours) || 1) * 3600 * 1000;
  const edits = p().edits || {};

  plan = items.map((it, i) => {
    const at = new Date(start.getTime() + i * stepMs);
    const caption = buildCaption(p().template, {
      summary: promptSummary(it.prompt),
      prompt: String(it.prompt || '').replace(/@[A-Za-z0-9_-]+/g, '').replace(/\s+/g, ' ').trim(),
      project: app.session.projectName || 'Untitled',
      name: it.name,
      n: pad(i + 1),
      tags: formatTags(tags),
      date: at.toLocaleDateString(),
    });
    const saved = edits[it.id] || {};
    return {
      ...it,
      caption: saved.caption ?? caption,
      at: saved.at ?? at.toISOString(),
      include: saved.include !== false,
    };
  });
  renderPlan();
  log(`Publish plan: ${plan.length} post(s) for ${activePlatforms().join(', ') || 'no platform selected'}`);
}

function saveEdit(item) {
  p().edits = { ...(p().edits || {}), [item.id]: { caption: item.caption, at: item.at, include: item.include } };
  persistSession();
}

function planRow(item, i) {
  const when = new Date(item.at);
  const box = el('input', { type: 'checkbox' });
  box.checked = item.include;
  box.addEventListener('change', () => {
    item.include = box.checked;
    row.classList.toggle('off', !box.checked);
    saveEdit(item);
    renderCount();
  });

  const caption = el('textarea', { class: 'input', rows: '4', spellcheck: 'false' });
  caption.value = item.caption;
  caption.addEventListener('input', () => {
    item.caption = caption.value;
    preview.textContent = item.caption.replace(/\s+/g, ' ').slice(0, 90);
    saveEdit(item);
  });

  const time = el('input', { class: 'input', type: 'datetime-local' });
  time.value = toLocalInput(when);
  time.addEventListener('change', () => {
    const d = new Date(time.value);
    if (isNaN(d)) return;
    item.at = d.toISOString();
    stamp.textContent = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    saveEdit(item);
  });

  const stamp = el('span', { class: 'pub-when', text: when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) });
  const preview = el('span', { class: 'pub-cap', text: item.caption.replace(/\s+/g, ' ').slice(0, 90) });
  const editor = el('div', { class: 'pub-edit' }, el('label', { class: 'field' }, el('span', { text: 'Caption' }), caption), el('label', { class: 'field' }, el('span', { text: 'Post at' }), time));
  editor.hidden = true;

  const head = el(
    'div',
    { class: 'pub-head', onclick: (e) => e.target.tagName !== 'INPUT' && (editor.hidden = !editor.hidden) },
    box,
    item.thumbUrl ? el('img', { src: item.thumbUrl, alt: '', loading: 'lazy' }) : el('span', { class: 'pub-noimg', text: item.kind === 'video' ? '🎞' : '🖼' }),
    el('div', { class: 'pub-meta' }, el('b', { text: item.name }), stamp, preview)
  );
  const row = el('div', { class: `pub-row${item.include ? '' : ' off'}` }, head, editor);
  return row;
}

function renderCount() {
  const n = plan.filter((i) => i.include).length;
  $('pubCount').textContent = plan.length ? `${n} of ${plan.length} selected` : '';
  $('btnExportPlan').disabled = busy || n === 0;
}

function renderPlan() {
  $('pubList').replaceChildren(...plan.map(planRow));
  renderCount();
}

function csvBlob(items) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const platforms = activePlatforms().join(' + ');
  const rows = [['file', 'scheduled_local', 'scheduled_iso', 'platforms', 'caption'].map(cell).join(',')];
  for (const it of items) {
    rows.push([it.file, new Date(it.at).toLocaleString(), it.at, platforms, it.caption].map(cell).join(','));
  }
  // The BOM keeps Excel from mangling non-ASCII captions.
  return new Blob([`﻿${rows.join('\r\n')}\r\n`], { type: 'text/csv' });
}

async function exportPlan() {
  const chosen = plan.filter((i) => i.include);
  if (!chosen.length) return;
  busy = true;
  $('btnExportPlan').disabled = true;
  $('btnBuildPlan').disabled = true;
  $('pubProgressWrap').hidden = false;
  const setBar = (v) => ($('pubProgress').style.width = `${Math.round(v * 100)}%`);
  try {
    const files = [];
    const rows = [];
    for (let i = 0; i < chosen.length; i++) {
      const it = chosen[i];
      $('pubStatus').textContent = `Reading ${it.name} · ${i + 1}/${chosen.length}`;
      setBar((i / chosen.length) * 0.5);
      const blob = await it.getBlob();
      const file = `${it.name}.${extFromMime(blob.type, it.kind === 'video' ? 'mp4' : 'png')}`;
      files.push({ name: `media/${file}`, blob });
      files.push({ name: `captions/${it.name}.txt`, blob: new Blob([`${it.caption}\n`], { type: 'text/plain' }) });
      rows.push({ file, at: it.at, caption: it.caption });
    }
    files.push({ name: 'captions.csv', blob: csvBlob(rows) });
    files.push({
      name: 'schedule.json',
      blob: new Blob(
        [
          JSON.stringify(
            {
              project: app.session.projectName || 'Untitled',
              generatedAt: new Date().toISOString(),
              platforms: activePlatforms(),
              note: 'Load these into each platform\'s own scheduler. Disclose AI-generated media with the in-app label as well as any hashtag.',
              posts: rows.map((r) => ({ media: `media/${r.file}`, scheduledAt: r.at, caption: r.caption })),
            },
            null,
            2
          ),
        ],
        { type: 'application/json' }
      ),
    });

    $('pubStatus').textContent = 'Building archive…';
    const zip = await buildZip(files, { onProgress: (v) => setBar(0.5 + v * 0.5) });
    $('pubStatus').textContent = `Saving ${fmtBytes(zip.size)} — choose where`;
    const name = `${sanitizeSegment(app.session.projectName, 'flowbatch')}_publish`;
    await downloadBlobAs(zip, `${name}.zip`);
    log(`Publish batch exported: ${chosen.length} post(s), ${fmtBytes(zip.size)}`, 'ok');
    toast(`Exported ${chosen.length} post${chosen.length === 1 ? '' : 's'}`);
  } catch (e) {
    const cancelled = /cancel/i.test(e.message);
    log(cancelled ? 'Publish export cancelled' : `Publish export failed: ${e.message}`, cancelled ? 'warn' : 'error');
    toast(cancelled ? 'Cancelled' : e.message, 4000);
  } finally {
    busy = false;
    $('pubProgressWrap').hidden = true;
    $('pubStatus').textContent = '';
    $('btnBuildPlan').disabled = false;
    renderCount();
  }
  return undefined;
}

function suggest() {
  const prompts = plan.length ? plan.map((i) => i.prompt) : sourceItems().map((i) => i.prompt);
  const texts = prompts.filter(Boolean);
  if (!texts.length) texts.push(app.session.promptText);
  const tags = [...new Set([...suggestHashtags(texts, { max: 12 }), ...DISCLOSURE_TAGS])];
  p().hashtags = formatTags(tags);
  $('pubHashtags').value = p().hashtags;
  persistSession();
  renderTagCount();
  toast(`${tags.length} hashtags from your prompts`);
}

function renderTagCount() {
  const n = parseTags($('pubHashtags').value).length;
  $('pubTagCount').textContent = `${n} tag${n === 1 ? '' : 's'}${n > 30 ? ' · Instagram allows 30' : ''}`;
}

function syncSource() {
  document.querySelectorAll('[data-pub-source]').forEach((b) => b.classList.toggle('active', b.dataset.pubSource === p().source));
}

export function initPublish() {
  const s = p();
  if (!s.startAt) s.startAt = defaultStart();
  $('pubTemplate').value = s.template;
  $('pubHashtags').value = s.hashtags;
  $('pubStart').value = s.startAt;
  $('pubEvery').value = s.everyHours;
  PLATFORMS.forEach(([k]) => {
    const box = $(`pub${k.toUpperCase()}`);
    box.checked = !!s.platforms[k];
    box.addEventListener('change', () => {
      s.platforms[k] = box.checked;
      persistSession();
    });
  });
  document.querySelectorAll('[data-pub-source]').forEach((b) =>
    b.addEventListener('click', () => {
      s.source = b.dataset.pubSource;
      plan = [];
      $('pubList').replaceChildren();
      persistSession();
      syncSource();
      renderCount();
    })
  );
  const bind = (id, key, parse = (v) => v) =>
    $(id).addEventListener('input', () => {
      s[key] = parse($(id).value);
      persistSession();
    });
  bind('pubTemplate', 'template');
  bind('pubStart', 'startAt');
  bind('pubEvery', 'everyHours', Number);
  $('pubHashtags').addEventListener('input', () => {
    s.hashtags = $('pubHashtags').value;
    persistSession();
    renderTagCount();
  });
  $('btnSuggestTags').addEventListener('click', suggest);
  $('btnBuildPlan').addEventListener('click', buildPlan);
  $('btnExportPlan').addEventListener('click', exportPlan);
  $('btnClearPlan').addEventListener('click', () => {
    plan = [];
    s.edits = {};
    $('pubList').replaceChildren();
    persistSession();
    renderCount();
  });
  syncSource();
  renderTagCount();
  renderCount();
}
