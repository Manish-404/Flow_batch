// "Prompt input" card: highlighted editor, @mention chips/autocomplete, template expansion,
// and the Image/Video · aspect ratio · model · count controls.
import { app, on, emit, persistSession } from './app.js';
import { MODELS, ASPECTS, GEMINI_MODELS, GEMINI_ASPECTS, CREDIT_TABLE } from './store.js';
import { IconSelect } from './controls.js';
import { assetIcon } from './assets-ui.js';
import { splitClipNames, addClipsToAssets } from './split-ui.js';
import { estimate, recordFlowInfo, PLANS } from './credits.js';
import { findSiteTab, callAgent } from './site.js';
import { $, el, splitPrompts, findMentions, isVideoAsset, log, toast } from './utils.js';

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
  const warn = $('promptWarn');
  warn.replaceChildren();
  if (!unknown.length) return;
  warn.append(`Unknown: @${unknown.slice(0, 4).join(', @')}${unknown.length > 4 ? '…' : ''}`);
  // Mentions of clips still sitting in Split video: offer to add them as assets.
  const clips = splitClipNames(unknown);
  if (clips.length) {
    const n = clips.length;
    warn.append(
      ' — ',
      el('button', {
        type: 'button',
        class: 'link-btn',
        text: `Add ${n === 1 ? `@${clips[0]}` : `these ${n} clips`} from Split video`,
        title: `Add @${clips.join(', @')} to Upload assets so prompts can use them`,
        onclick: () => addClipsToAssets(clips),
      })
    );
  }
}

function refresh() {
  renderBackdrop();
  renderStats();
  renderCredits();
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
        { class: 'chip', type: 'button', title: `Insert @${a.name}${isVideoAsset(a) ? ' (video clip)' : ''}`, onclick: () => insertAtCaret(`@${a.name} `) },
        assetIcon(a),
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
        assetIcon(a),
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
  // Start and end frames are images; video clips are left out.
  const images = app.assets.filter((a) => !isVideoAsset(a));
  if (images.length < 2) return toast('Add at least 2 images (start and end frames)');
  const prompts = splitPrompts(ta().value, app.settings.separator);
  const template = prompts[0] || '';
  const { pairs, leftover } = framePairs(images);
  if (leftover && !confirm(
    `${images.length} images is an odd number, so the last one (@${leftover.name}) cannot be paired.\n\n` +
      `FlowBatch will generate ${pairs.length} scene(s) with Frames to video (start → end) and 1 scene ` +
      `from @${leftover.name} alone with Ingredients to video.\n\nBuild the prompts this way?`
  )) return;
  if (prompts.length > 1 && !confirm(`Replace all ${prompts.length} prompts with ${pairs.length + (leftover ? 1 : 0)} scene prompts built from the first one?`)) return;

  const blocks = buildPairPrompts(images.map((a) => a.name), template);
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

// ---------- credit estimate (Flow) ----------
const fmtN = (n) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));

function renderCredits() {
  const line = $('creditLine');
  if (!line) return;
  emit('estimateChanged'); // the credits bar at the top shows how many prompts are left
  if (onGemini()) {
    line.hidden = true; // Gemini counts daily uses, not credits
    return;
  }
  const e = estimate(splitPrompts(ta().value, app.settings.separator).length || 1);
  const plan = e.plan.id ? `${PLANS[e.plan.id] || e.plan.id} plan, ${e.plan.source}` : 'plan unknown — using non-Ultra prices';
  const check = el('button', {
    type: 'button',
    class: 'link-btn',
    text: 'Check in Flow',
    title: "Read your plan, the model, length, resolution and Flow's own credit cost from the open Flow tab",
    onclick: checkInFlow,
  });
  line.replaceChildren();
  if (e.unknown) {
    line.append(`💳 Credits: unknown — ${e.unknown}. ${plan}. `, check);
  } else {
    const what = [e.label, e.duration && `${e.duration}s`, e.res].filter(Boolean).join(', ');
    const src = e.source === 'flow' ? 'price read from Flow' : `price list (${CREDIT_TABLE.asOf})`;
    line.append(
      el('b', { text: `💳 ≈ ${fmtN(e.total)} credits` }),
      ` — ${e.prompts} prompt${e.prompts === 1 ? '' : 's'} × x${e.count} × ${fmtN(e.per)} (${what}). ${src} · ${plan}. `,
      check
    );
  }
  line.hidden = false;
}

async function checkInFlow() {
  if (app.runner?.state === 'running') return toast('Wait for the run to finish — this opens Flow’s settings');
  const tab = await findSiteTab('flow', { open: false });
  if (!tab) return toast('Open your Flow project in a tab first');
  try {
    const r = await callAgent(tab.id, 'pricing', { selectors: app.settings.selectors, open: true }, { timeoutMs: 20000, retries: 1 });
    recordFlowInfo(r);
    const parts = [r.plan && `${PLANS[r.plan] || r.plan} plan`, r.model, r.duration && `${r.duration}s`, r.res, r.credits != null && `${r.credits} credits per prompt`].filter(Boolean);
    const missing = [!r.plan && 'plan', !r.model && 'model', r.credits == null && 'credit cost'].filter(Boolean);
    log(`Flow: ${parts.join(' · ') || 'nothing readable'}${missing.length ? ` — not found: ${missing.join(', ')}` : ''}`, missing.length ? 'warn' : 'ok');
    toast(parts.length ? `Flow: ${parts.join(' · ')}` : 'Could not read the plan or credits from Flow — see the Activity log', 5000);
  } catch (e) {
    toast(`Could not read Flow: ${e.message}`, 5000);
  }
  renderCredits();
  return undefined;
}

// ---------- aspect ratio suggestion ----------
// Width × height of each asset, measured once. null: couldn't be read.
const dims = new Map();

async function measure(a) {
  if (dims.has(a.id)) return dims.get(a.id);
  let d = null;
  try {
    if (isVideoAsset(a)) {
      d = await new Promise((resolve) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        const done = (x) => {
          clearTimeout(timer);
          v.removeAttribute('src');
          resolve(x);
        };
        const timer = setTimeout(() => done(null), 6000);
        v.onloadedmetadata = () => done(v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null);
        v.onerror = () => done(null);
        v.src = a.thumbUrl;
      });
    } else {
      const bmp = await createImageBitmap(a.blob);
      d = { w: bmp.width, h: bmp.height };
      bmp.close();
    }
  } catch {
    d = null;
  }
  dims.set(a.id, d);
  return d;
}

const ORIENT = (id) => {
  const [w, h] = id.split(':').map(Number);
  return w > h ? 'landscape' : w < h ? 'portrait' : 'square';
};

/** The ratio option closest to w × h (compared on a log scale, so 2:1 and 1:2 are equally far from 1:1). */
function nearestRatio(options, w, h) {
  let best = null;
  for (const o of options) {
    if (o.id === 'keep') continue;
    const [a, b] = o.id.split(':').map(Number);
    const dist = Math.abs(Math.log(w / h) - Math.log(a / b));
    if (!best || dist < best.dist) best = { id: o.id, dist };
  }
  return best?.id || null;
}

/**
 * What the @mentioned images and clips suggest: { suggest, counts, total, kinds } or null when no
 * reference can be measured. The suggestion is the ratio most of them are closest to.
 */
async function ratioAdvice() {
  const names = new Set(findMentions(app.session.promptText || '').map((n) => n.toLowerCase()));
  const refs = app.assets.filter((a) => names.has(a.name.toLowerCase()));
  if (!refs.length) return null;
  const options = (onGemini() ? GEMINI_ASPECTS : ASPECTS)[app.session.mode];
  const counts = new Map();
  let total = 0;
  for (const a of refs) {
    const d = await measure(a);
    if (!d) continue;
    const r = nearestRatio(options, d.w, d.h);
    if (!r) continue;
    counts.set(r, (counts.get(r) || 0) + 1);
    total++;
  }
  if (!total) return null;
  // Most common ratio wins; on a tie, the one already chosen.
  const chosen = choice().aspect;
  const suggest = [...counts.entries()].sort((x, y) => y[1] - x[1] || (y[0] === chosen) - (x[0] === chosen))[0][0];
  const clips = refs.filter(isVideoAsset).length;
  const kinds = clips === refs.length ? 'clip' : clips ? 'reference' : 'image';
  return { suggest, counts, total, kinds, unread: refs.length - total };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeRefs(adv) {
  const unread = adv.unread ? ` (${adv.unread} couldn't be read)` : '';
  return describeMeasured(adv) + unread;
}

function describeMeasured(adv) {
  if (adv.counts.size === 1) return `your ${adv.total === 1 ? adv.kinds : plural(adv.total, adv.kinds)} ${adv.total === 1 ? 'is' : 'are'} ${adv.suggest} (${ORIENT(adv.suggest)})`;
  const mix = [...adv.counts.entries()].sort((x, y) => y[1] - x[1]).map(([r, n]) => `${n} × ${r}`).join(', ');
  return `your ${plural(adv.total, adv.kinds)} mix ratios (${mix}); most are ${adv.suggest}`;
}

function useRatio(id) {
  choice().aspect = aspectSelect.setOptions((onGemini() ? GEMINI_ASPECTS : ASPECTS)[app.session.mode], id);
  persistSession();
  renderAspectHint();
  toast(`Aspect ratio set to ${id}`);
}

let hintRun = 0;
async function renderAspectHint() {
  const run = ++hintRun;
  const adv = await ratioAdvice();
  if (run !== hintRun) return; // a newer render started while measuring
  const hint = $('aspectHint');
  const chosen = choice().aspect;
  if (!adv) {
    hint.hidden = true;
    return;
  }
  const refs = describeRefs(adv);
  const button = el('button', { type: 'button', class: 'link-btn', text: `Use ${adv.suggest}`, onclick: () => useRatio(adv.suggest) });
  let cls;
  hint.replaceChildren();
  if (chosen === adv.suggest) {
    cls = 'ok';
    hint.append(`✓ ${chosen} matches — ${refs}.`);
  } else if (chosen === 'keep') {
    cls = 'info';
    hint.append(`💡 Suggested: ${adv.suggest} — ${refs}. `, button);
  } else {
    cls = 'bad';
    hint.append(`⚠ ${chosen} is selected, but ${refs}. The result may be cropped or letterboxed. `, button);
  }
  hint.className = `aspect-hint ${cls}`;
  hint.hidden = false;
}

let hintTimer = null;
const scheduleAspectHint = () => {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(renderAspectHint, 300);
};

/** For Start: a warning when the chosen ratio doesn't match the @mentioned references, else null. */
export async function aspectMismatch() {
  const adv = await ratioAdvice();
  const chosen = choice().aspect;
  if (!adv || chosen === adv.suggest) return null;
  const refs = describeRefs(adv);
  return chosen === 'keep'
    ? `No aspect ratio is chosen (the ${onGemini() ? 'Gemini' : 'Flow'} default is used), but ${refs}.\n\nSuggested: ${adv.suggest}.`
    : `Aspect ratio ${chosen} is selected, but ${refs}.\n\nResults may be cropped or letterboxed. Suggested: ${adv.suggest}.`;
}

export function setMode(mode) {
  app.session.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  applyVisibility();
  const c = choice();
  c.aspect = aspectSelect.setOptions((onGemini() ? GEMINI_ASPECTS : ASPECTS)[mode], c.aspect);
  c.model = modelSelect.setOptions((onGemini() ? GEMINI_MODELS : MODELS)[mode], c.model);
  persistSession();
  scheduleAspectHint();
  renderCredits();
}

function setCount(n) {
  app.session.count = n;
  document.querySelectorAll('#countSeg [data-count]').forEach((b) => b.classList.toggle('active', Number(b.dataset.count) === n));
  persistSession();
  renderCredits();
}

export function initPrompt() {
  const t = ta();
  t.value = app.session.promptText || '';
  t.addEventListener('input', () => {
    app.session.promptText = t.value;
    persistSession();
    refresh();
    renderPopup();
    scheduleAspectHint();
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
      renderAspectHint();
    },
  });
  modelSelect = new IconSelect($('modelSelect'), {
    iconClass: 'model',
    onChange: (v) => {
      choice().model = v;
      persistSession();
      renderCredits();
    },
  });
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('#countSeg [data-count]').forEach((b) => b.addEventListener('click', () => setCount(Number(b.dataset.count))));
  setMode(app.session.mode || 'image');
  setCount(Number(app.session.count) || 1);

  on('assetsChanged', () => {
    dims.clear(); // a replaced file can change size
    renderChips();
    refresh();
    scheduleAspectHint();
  });
  on('clipsChanged', renderStats);
  on('creditsChanged', renderCredits);
  on('promptChanged', () => {
    t.value = app.session.promptText;
    refresh();
    scheduleAspectHint();
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
