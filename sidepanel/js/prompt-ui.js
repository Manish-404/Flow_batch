// "Prompt input" card: highlighted editor, @mention chips/autocomplete, template expansion,
// and the Image/Video · aspect ratio · model · count controls.
import { app, on, persistSession } from './app.js';
import { MODELS, ASPECTS, GEMINI_MODELS, GEMINI_ASPECTS } from './store.js';
import { IconSelect } from './controls.js';
import { $, el, splitPrompts, findMentions, toast } from './utils.js';

const ta = () => $('promptInput');
let aspectSelect;
let modelSelect;
let popupIndex = 0;

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function knownNames() {
  return new Set(app.assets.map((a) => a.name.toLowerCase()));
}

function renderBackdrop() {
  const sep = app.settings.separator.trim();
  const known = knownNames();
  const html = ta()
    .value.split('\n')
    .map((line) => {
      if (line.trim() === sep && sep) return `<mark class="sep">${escapeHtml(line)}</mark>`;
      return escapeHtml(line).replace(/@([A-Za-z0-9_-]+)/g, (full, name) =>
        `<mark class="${known.has(name.toLowerCase()) ? '' : 'bad'}">${full}</mark>`
      );
    })
    .join('\n');
  $('promptBackdrop').innerHTML = `${html}\n `;
  $('promptBackdrop').scrollTop = ta().scrollTop;
}

function renderStats() {
  const prompts = splitPrompts(ta().value, app.settings.separator);
  const known = knownNames();
  const unknown = [...new Set(prompts.flatMap(findMentions).filter((n) => !known.has(n.toLowerCase())))];
  $('promptStats').textContent = `${prompts.length} prompt${prompts.length === 1 ? '' : 's'}`;
  $('promptWarn').textContent = unknown.length ? `Unknown: @${unknown.slice(0, 4).join(', @')}${unknown.length > 4 ? '…' : ''}` : '';
}

function refresh() {
  renderBackdrop();
  renderStats();
}

function insertAtCaret(text) {
  const t = ta();
  t.focus();
  if (!document.execCommand('insertText', false, text)) {
    t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function insertSeparator() {
  const t = ta();
  const before = t.value.slice(0, t.selectionStart);
  const lead = before.length && !before.endsWith('\n') ? '\n' : '';
  insertAtCaret(`${lead}${app.settings.separator}\n`);
}

function renderChips() {
  $('mentionChips').replaceChildren(
    ...app.assets.map((a) =>
      el(
        'button',
        { class: 'chip', type: 'button', title: `Insert @${a.name}`, onclick: () => insertAtCaret(`@${a.name} `) },
        el('img', { src: a.thumbUrl, alt: '' }),
        el('span', { text: a.name }),
        el('span', { class: 'at', text: `@${a.name}` })
      )
    )
  );
}

// ---------- @mention autocomplete ----------
function mentionQuery() {
  const t = ta();
  if (t.selectionStart !== t.selectionEnd) return null;
  const m = t.value.slice(0, t.selectionStart).match(/(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]*)$/);
  return m ? m[2] : null;
}

function popupMatches() {
  const q = mentionQuery();
  if (q == null || !app.assets.length) return [];
  return app.assets.filter((a) => a.name.toLowerCase().startsWith(q.toLowerCase())).slice(0, 30);
}

function renderPopup() {
  const popup = $('mentionPopup');
  const matches = popupMatches();
  if (!matches.length) {
    popup.hidden = true;
    return;
  }
  popupIndex = Math.min(popupIndex, matches.length - 1);
  popup.replaceChildren(
    ...matches.map((a, i) =>
      el(
        'button',
        {
          type: 'button',
          class: i === popupIndex ? 'active' : '',
          onmousedown: (e) => {
            e.preventDefault();
            acceptMention(a.name);
          },
        },
        el('img', { src: a.thumbUrl, alt: '' }),
        el('span', { text: `@${a.name}` })
      )
    )
  );
  popup.hidden = false;
  popup.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function acceptMention(name) {
  const q = mentionQuery() ?? '';
  const t = ta();
  t.setSelectionRange(t.selectionStart - q.length, t.selectionStart);
  insertAtCaret(`${name} `);
  $('mentionPopup').hidden = true;
}

// ---------- template → one prompt per asset ----------
function expandPerAsset() {
  if (!app.assets.length) return toast('Add assets (or extract frames) first');
  const prompts = splitPrompts(ta().value, app.settings.separator);
  const template = prompts[0];
  if (!template) return toast('Write one prompt with {asset} or a single @mention first');
  const placeholder = /\{\{?\s*asset\s*\}?\}/gi;
  let build;
  if (placeholder.test(template)) {
    build = (name) => template.replace(placeholder, `@${name}`);
  } else {
    const names = [...new Set(findMentions(template).map((n) => n.toLowerCase()))];
    if (names.length !== 1) return toast('Use {asset} in the first prompt, or exactly one @mention');
    const re = new RegExp(`@${names[0].replace(/-/g, '\\-')}(?![A-Za-z0-9_-])`, 'gi');
    build = (name) => template.replace(re, `@${name}`);
  }
  if (prompts.length > 1 && !confirm(`Replace all ${prompts.length} prompts with ${app.assets.length} prompts built from the first one?`)) return;
  const sep = app.settings.separator;
  const t = ta();
  t.focus();
  t.select();
  insertAtCaret(app.assets.map((a) => build(a.name)).join(`\n${sep}\n`));
  toast(`Created ${app.assets.length} prompts`);
}

// ---------- template → one prompt per start → end pair ----------
/** Disjoint consecutive pairs; an odd final image is left over and runs as Ingredients to video. */
export function framePairs(assets) {
  const pairs = [];
  for (let i = 0; i + 1 < assets.length; i += 2) pairs.push([assets[i], assets[i + 1]]);
  return { pairs, leftover: assets.length % 2 ? assets[assets.length - 1] : null };
}

/**
 * One prompt per scene from a template. `{start}` / `{end}` mark where the mentions go;
 * without them the mentions are prefixed. The unpaired last image gets `{end}` dropped.
 */
export function buildPairPrompts(names, template) {
  const hasSlots = /\{\{?\s*(start|end)\s*\}?\}/i.test(template);
  const build = (start, end) => {
    const body = hasSlots
      ? template.replace(/\{\{?\s*start\s*\}?\}/gi, `@${start}`).replace(/\{\{?\s*end\s*\}?\}/gi, end ? `@${end}` : '')
      : `${end ? `@${start} @${end}` : `@${start}`}${template ? ` ${template}` : ''}`;
    // Dropping {end} can leave a gap or a dangling space before punctuation.
    return body
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,.;:!?)])/g, '$1')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  };
  const { pairs, leftover } = framePairs(names);
  const blocks = pairs.map(([a, b]) => build(a, b));
  if (leftover) blocks.push(build(leftover, null));
  return blocks;
}

function expandPerPair() {
  if (app.assets.length < 2) return toast('Add at least 2 images (start and end frames)');
  const prompts = splitPrompts(ta().value, app.settings.separator);
  const template = prompts[0] || '';
  const { pairs, leftover } = framePairs(app.assets);
  if (leftover && !confirm(
    `${app.assets.length} images is an odd number, so the last one (@${leftover.name}) cannot be paired.\n\n` +
      `FlowBatch will generate ${pairs.length} scene(s) with Frames to video (start → end) and 1 scene ` +
      `from @${leftover.name} alone with Ingredients to video.\n\nBuild the prompts this way?`
  )) return;
  if (prompts.length > 1 && !confirm(`Replace all ${prompts.length} prompts with ${pairs.length + (leftover ? 1 : 0)} scene prompts built from the first one?`)) return;

  const blocks = buildPairPrompts(app.assets.map((a) => a.name), template);
  const t = ta();
  t.focus();
  t.select();
  insertAtCaret(blocks.join(`\n${app.settings.separator}\n`));
  app.session.seqFrames = true;
  $('seqFrames').checked = true;
  persistSession();
  toast(`Created ${blocks.length} scene prompts${leftover ? ' (last one uses ingredients)' : ''}`);
  return undefined;
}

// ---------- generation options ----------
// Flow and Gemini keep separate ratio / model choices; `choice()` is the one for the current site.
const onGemini = () => app.session.site === 'gemini';
const choice = () => (onGemini() ? app.session.gemini : app.session);

/** Mark-up hooks: data-video-mode (video only), data-flow-only, data-gemini-only. */
function applyVisibility() {
  const video = app.session.mode === 'video';
  const gemini = onGemini();
  document.querySelectorAll('[data-video-mode], [data-flow-only], [data-gemini-only]').forEach((n) => {
    n.hidden =
      (n.hasAttribute('data-video-mode') && !video) ||
      (n.hasAttribute('data-flow-only') && gemini) ||
      (n.hasAttribute('data-gemini-only') && !gemini);
  });
}

export function setMode(mode) {
  app.session.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  applyVisibility();
  const c = choice();
  c.aspect = aspectSelect.setOptions((onGemini() ? GEMINI_ASPECTS : ASPECTS)[mode], c.aspect);
  c.model = modelSelect.setOptions((onGemini() ? GEMINI_MODELS : MODELS)[mode], c.model);
  persistSession();
}

function setCount(n) {
  app.session.count = n;
  document.querySelectorAll('#countSeg [data-count]').forEach((b) => b.classList.toggle('active', Number(b.dataset.count) === n));
  persistSession();
}

export function initPrompt() {
  const t = ta();
  t.value = app.session.promptText || '';
  t.addEventListener('input', () => {
    app.session.promptText = t.value;
    persistSession();
    refresh();
    renderPopup();
  });
  t.addEventListener('scroll', () => ($('promptBackdrop').scrollTop = t.scrollTop));
  t.addEventListener('click', renderPopup);
  t.addEventListener('blur', () => setTimeout(() => ($('mentionPopup').hidden = true), 150));
  t.addEventListener('keydown', (e) => {
    const popup = $('mentionPopup');
    if (!popup.hidden) {
      const matches = popupMatches();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        popupIndex = (popupIndex + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        return renderPopup();
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        return matches[popupIndex] && acceptMention(matches[popupIndex].name);
      }
      if (e.key === 'Escape') {
        popup.hidden = true;
        return undefined;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      insertSeparator();
    }
    return undefined;
  });
  new ResizeObserver(() => ($('promptBackdrop').scrollTop = t.scrollTop)).observe(t);
  $('btnInsertSep').addEventListener('click', insertSeparator);
  $('btnPerAsset').addEventListener('click', expandPerAsset);
  $('btnPerPair').addEventListener('click', expandPerPair);
  $('seqFrames').checked = !!app.session.seqFrames;
  $('seqFrames').addEventListener('change', (e) => {
    app.session.seqFrames = e.target.checked;
    persistSession();
  });

  aspectSelect = new IconSelect($('aspectSelect'), {
    onChange: (v) => {
      choice().aspect = v;
      persistSession();
    },
  });
  modelSelect = new IconSelect($('modelSelect'), {
    iconClass: 'model',
    onChange: (v) => {
      choice().model = v;
      persistSession();
    },
  });
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('#countSeg [data-count]').forEach((b) => b.addEventListener('click', () => setCount(Number(b.dataset.count))));
  setMode(app.session.mode || 'image');
  setCount(Number(app.session.count) || 1);

  on('assetsChanged', () => {
    renderChips();
    refresh();
  });
  on('promptChanged', () => {
    t.value = app.session.promptText;
    refresh();
  });
  on('settingsChanged', () => {
    $('sepHint').textContent = app.settings.separator;
    refresh();
  });
  on('siteChanged', () => setMode(app.session.mode));
  $('sepHint').textContent = app.settings.separator;
  renderChips();
  refresh();
}
