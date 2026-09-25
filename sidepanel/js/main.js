// Side panel entry: loads state, wires the queue / controls / progress / summary / log.
import { app, on, emit, persistSession } from './app.js';
import { loadSettings, loadSession, listAssets } from './store.js';
import { initAssets, addAssets, removeAllAssets } from './assets-ui.js';
import { initPrompt, setMode } from './prompt-ui.js';
import { initFrames } from './frames-ui.js';
import { initSettings, applyTheme } from './settings-ui.js';
import { initZip, openZipPicker } from './zip-ui.js';
import { initPublish } from './publish-ui.js';
import { initSplit } from './split-ui.js';
import { generatedResults } from './results.js';
import { Runner } from './runner.js';
import { SITES, findSiteTab, callAgent } from './site.js';
import { $, el, pad, sanitizeSegment, splitPrompts, findMentions, fmtDuration, log, onLog, logLines, toast } from './utils.js';

let renderQueued = false;
let lastStep = '';

const site = () => (app.session.site === 'gemini' ? 'gemini' : 'flow');
const siteName = () => SITES[site()].name;
// Start → end frame pairs need Flow's "Frames to video"; Gemini has no equivalent.
const sequential = () => site() === 'flow' && app.session.mode === 'video' && app.session.seqFrames;

// ---------------- queue ----------------
function buildQueue() {
  const prompts = splitPrompts(app.session.promptText, app.settings.separator);
  const byName = new Map(app.assets.map((a) => [a.name.toLowerCase(), a.name]));
  const seq = sequential();
  return prompts.map((prompt, i) => {
    const mentioned = findMentions(prompt);
    const mentions = [...new Set(mentioned.map((m) => byName.get(m.toLowerCase())).filter(Boolean))];
    return {
      id: crypto.randomUUID(),
      n: i + 1,
      prompt,
      mentions,
      unknown: [...new Set(mentioned.filter((m) => !byName.has(m.toLowerCase())))],
      // Two images = a start → end pair; a lone image cannot be a pair, so it runs as ingredients.
      videoMode: seq ? (mentions.length >= 2 ? 'frames' : 'ingredients') : null,
      status: 'pending',
      results: [],
      error: '',
      attempts: 0,
    };
  });
}

/** Required heads-up: odd image counts leave one scene that can't use start/end frames. */
function confirmSequentialPlan() {
  if (!sequential()) return true;
  const q = app.session.queue;
  const framePairs = q.filter((i) => i.videoMode === 'frames').length;
  const single = q.filter((i) => i.videoMode === 'ingredients');
  if (!framePairs && !single.length) return true;
  const lines = [
    `Sequential frames is on for ${q.length} scene(s):`,
    ``,
    `• ${framePairs} scene(s) use Frames to video — first @mention is the start frame, second is the end frame.`,
  ];
  if (single.length) {
    lines.push(
      ``,
      `• ${single.length} scene(s) have only one image, so they cannot use start/end frames.`,
      `  FlowBatch will switch Flow to Ingredients to video for those: ${single
        .slice(0, 6)
        .map((i) => `#${pad(i.n, 2)} @${i.mentions[0] || '(none)'}`)
        .join(', ')}${single.length > 6 ? `, +${single.length - 6} more` : ''}.`
    );
  }
  lines.push(``, `Start generating?`);
  return confirm(lines.join('\n'));
}

function statusIcon(status) {
  return el('span', { class: `st ${status}`, text: status === 'success' ? '✓' : status === 'failed' ? '✕' : status === 'pending' ? '•' : '' });
}

function queueRow(item) {
  const runner = app.runner;
  const idle = runner.state !== 'running';
  const actions = el('div', { class: 'q-actions' });
  if (item.status === 'failed' && idle) {
    actions.append(
      el('button', {
        title: 'Retry this prompt',
        text: '↻',
        onclick: () => {
          item.status = 'pending';
          item.error = '';
          scheduleRender();
          startRun(true);
        },
      })
    );
  }
  if (item.status === 'success' && item.results.length) {
    actions.append(
      el('button', {
        title: 'Download again',
        text: '⤓',
        onclick: async () => {
          await runner.downloadItem(item);
          toast('Download started');
        },
      })
    );
  }
  actions.append(statusIcon(item.status));

  const mode =
    app.session.mode !== 'video' ? 'IMG' : item.videoMode === 'frames' ? 'FRM' : item.videoMode === 'ingredients' ? 'ING' : 'VID';
  const row = el(
    'div',
    { class: `q-row ${item.status}`, title: item.prompt.slice(0, 600) },
    el('span', { class: 'q-idx', text: pad(item.n, 2) }),
    el('span', { class: 'q-tag', text: mode }),
    el('span', { class: 'q-text', text: item.prompt.replace(/\s+/g, ' ') }),
    actions
  );
  if (item.unknown?.length) row.append(el('div', { class: 'q-err', text: `Unknown mention: @${item.unknown.join(', @')} (sent as plain text)` }));
  if (item.error && item.status !== 'success') row.append(el('div', { class: 'q-err', text: `${item.error}${item.attempts > 1 ? ` · ${item.attempts} attempts` : ''}` }));
  if (item.results?.length) {
    const thumbs = el('div', { class: 'q-results' });
    for (const r of item.results) {
      const src = r.preview || r.url; // Gemini: the on-page copy, lighter than full size
      if (r.kind !== 'image' || src.startsWith('blob:')) continue;
      const img = el('img', { src, alt: '', loading: 'lazy', title: r.filename ? `${r.filename} · ${r.download || ''}` : '' });
      img.onerror = () => img.remove();
      thumbs.append(img);
    }
    if (thumbs.childElementCount) row.append(thumbs);
  }
  return row;
}

function renderQueue() {
  const q = app.session.queue;
  $('queueCount').textContent = q.length;
  const list = $('queueList');
  if (!q.length) {
    list.replaceChildren(el('div', { class: 'empty muted', text: 'Prompts appear here when you press Start.' }));
    return;
  }
  const scroll = list.scrollTop;
  list.replaceChildren(...q.map(queueRow));
  list.scrollTop = scroll;
  const running = list.querySelector('.q-row.running');
  if (running && app.runner.state === 'running') running.scrollIntoView({ block: 'nearest' });
}

// ---------------- progress / summary ----------------
function counts() {
  const q = app.session.queue;
  const success = q.filter((i) => i.status === 'success').length;
  const failed = q.filter((i) => i.status === 'failed').length;
  const files = q.flatMap((i) => i.results || []).filter((r) => r.filename);
  return {
    total: q.length,
    success,
    failed,
    done: success + failed,
    pending: q.filter((i) => i.status === 'pending' || i.status === 'running').length,
    files: files.length,
    verified: files.filter((r) => r.download === 'complete').length,
  };
}

function renderProgress() {
  const c = counts();
  const r = app.runner;
  $('progressBar').style.width = c.total ? `${(c.done / c.total) * 100}%` : '0%';
  $('progressText').textContent = `${c.success} / ${c.total}${c.failed ? ` (FAILED ${c.failed})` : ''}`;
  const parts = [];
  if (r.state !== 'idle' && r.startedAt) parts.push(`elapsed ${fmtDuration(Date.now() - r.startedAt)}`);
  const eta = r.state === 'running' ? r.eta() : null;
  if (eta) parts.push(`ETA ${fmtDuration(eta)}`);
  if (r.state === 'paused') parts.push('paused');
  $('progressMeta').textContent = parts.join(' · ');
  $('currentStep').textContent = lastStep;
}

function renderSummary() {
  const c = counts();
  const show = app.runner.state === 'idle' && c.total > 0 && c.pending === 0 && c.done > 0;
  $('summaryCard').hidden = !show;
  if (!show) return;
  const all = c.failed === 0;
  const none = c.success === 0;
  $('summaryIcon').textContent = all ? '✅' : none ? '⛔' : '⚠️';
  $('summaryTitle').textContent = all ? 'Completed' : none ? 'Failed' : 'Partially completed';
  $('summaryCounts').innerHTML = `<b class="ok">${c.success}</b> SUCCESS / <b class="bad">${c.failed}</b> FAILED`;
  $('summaryDownloads').textContent = app.settings.autoDownload
    ? `DOWNLOAD VERIFICATION ${c.verified === c.files ? 'COMPLETE' : 'IN PROGRESS'} ${c.verified}/${c.files}`
    : 'Auto-download is off';
  $('btnRegenerate').hidden = c.failed === 0;
  $('btnRegenerate').textContent = `Regenerate failed ${app.session.mode === 'video' ? 'videos' : 'images'}`;
  const images = generatedResults().filter((r) => r.kind === 'image').length;
  $('btnZipResults').hidden = c.success === 0;
  $('btnResultsToAssets').hidden = images < 2;
  $('btnResultsToAssets').textContent = `🎬 Use these ${images} images for video`;
}

function renderControls() {
  const state = app.runner.state;
  $('btnStart').disabled = state === 'running';
  $('btnStartText').textContent = state === 'running' ? 'Running…' : state === 'paused' ? 'Resume' : 'Start';
  $('btnPause').disabled = state !== 'running' || app.runner.pauseRequested;
  $('btnStop').disabled = state === 'idle';
  $('btnNewProject').disabled = state === 'running';
  // A run (or a paused one) belongs to the site it started on.
  document.querySelectorAll('[data-site]').forEach((b) => (b.disabled = state !== 'idle'));
}

function renderAll() {
  renderQueued = false;
  renderQueue();
  renderProgress();
  renderSummary();
  renderControls();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(renderAll);
}

// ---------------- actions ----------------
async function startRun(keepQueue = false) {
  const runner = app.runner;
  if (runner.state === 'running') return;
  if (runner.state === 'paused' || keepQueue) {
    runner.start();
    return;
  }
  const prompts = splitPrompts(app.session.promptText, app.settings.separator);
  if (!prompts.length) return toast('Enter at least one prompt');

  const q = app.session.queue;
  const same = q.length === prompts.length && q.every((item, i) => item.prompt === prompts[i]);
  if (same && q.some((i) => i.status === 'pending')) {
    log('Continuing the existing queue');
    // The Sequential frames switch (or the site) may have changed since the queue was built.
    const seq = sequential();
    q.forEach((i) => (i.videoMode = seq ? (i.mentions.length >= 2 ? 'frames' : 'ingredients') : null));
  } else {
    if (same && q.length && !confirm('Every prompt in the queue has already run. Run them all again?')) return;
    app.session.queue = buildQueue();
    log(`Queue built: ${app.session.queue.length} prompt(s)`);
  }
  if (!confirmSequentialPlan()) {
    log('Start cancelled at the sequential-frames confirmation', 'warn');
    scheduleRender();
    return;
  }
  if (!app.session.projectName.trim()) {
    const d = new Date();
    app.session.projectName = `${siteName()}_${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}_${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}`;
    $('projectName').value = app.session.projectName;
  }
  persistSession();
  scheduleRender();
  runner.start();
}

/** Flow: a new project. Gemini: a new chat. Both clear the work queue. */
async function newProject() {
  if (app.runner.state === 'running') return;
  const gemini = site() === 'gemini';
  const what = gemini ? 'a new Gemini chat' : 'a new project';
  const hasWork = app.session.queue.length > 0;
  if (hasWork && !confirm(`Start ${what}? The work queue will be cleared (assets and prompts are kept).`)) return;
  if (app.runner.state === 'paused') app.runner.stop();
  app.session.queue = [];
  app.session.projectName = '';
  $('projectName').value = '';
  lastStep = '';
  persistSession();
  scheduleRender();
  try {
    lastStep = gemini ? 'Opening a new Gemini chat…' : 'Opening a new Flow project…';
    scheduleRender();
    if (gemini) await app.runner.newChat();
    else await app.runner.newProject();
    toast(gemini ? 'New Gemini chat ready' : 'New Flow project ready');
  } catch (e) {
    log(`${gemini ? 'New chat' : 'New project'}: ${e.message}`, 'warn');
    toast(e.message, 4000);
  } finally {
    lastStep = '';
    scheduleRender();
  }
}

// ---------------- generated results ----------------
// Results remember the site that made them: "the Gemini tab, so keep it" / "the Flow and Gemini tabs, so keep them".
function resultTabs(results) {
  const names = [...new Set(results.map((r) => SITES[r.res.site || 'flow'].name))];
  return names.length > 1 ? `the ${names.join(' and ')} tabs, so keep them` : `the ${names[0]} tab, so keep it`;
}

function zipResults() {
  const results = generatedResults();
  if (!results.length) return toast('No generated results yet');
  return openZipPicker({
    title: 'Generated results → ZIP',
    note: `Untick anything you do not want in the archive. Files are read from ${resultTabs(results)} open.`,
    filename: `${sanitizeSegment(app.session.projectName, 'flowbatch')}_results`,
    items: results.map((r) => ({ ...r, getBlob: () => app.runner.resultBlob(r.res) })),
  });
}

/** Import the generated images back as assets so they can drive a video run. */
async function resultsToAssets() {
  const images = generatedResults().filter((r) => r.kind === 'image');
  if (!images.length) return toast('No generated images yet');
  if (
    !confirm(
      `Replace the current ${app.assets.length} asset(s) with the ${images.length} generated image(s) as pic_001…?\n\n` +
        `They are downloaded from ${resultTabs(images)} open until the import finishes.`
    )
  )
    return;
  lastStep = `Importing ${images.length} generated image(s)…`;
  scheduleRender();
  const items = [];
  try {
    for (let i = 0; i < images.length; i++) {
      lastStep = `Importing generated image ${i + 1}/${images.length}…`;
      renderProgress();
      items.push({ blob: await app.runner.resultBlob(images[i].res), name: `pic_${pad(i + 1)}` });
    }
  } catch (e) {
    log(`Import failed: ${e.message}`, 'error');
    toast(e.message, 4000);
    lastStep = '';
    scheduleRender();
    return;
  }
  await removeAllAssets();
  await addAssets(items);
  app.session.mode = 'video';
  app.session.seqFrames = true;
  setMode('video');
  $('seqFrames').checked = true;
  persistSession();
  lastStep = '';
  scheduleRender();
  if (site() === 'gemini') {
    // Start → end pairs need Flow; in Gemini each image becomes its own video.
    log(`Imported ${items.length} generated image(s) as pic_001… and switched to Video`, 'ok');
    toast(`Imported ${items.length} image(s) — now press “One prompt per asset”`);
  } else {
    log(`Imported ${items.length} generated image(s) as pic_001… and switched to Video · sequential frames`, 'ok');
    toast(`Imported ${items.length} image(s) — now press “One prompt per frame pair”`);
  }
  return undefined;
}

// ---------------- site switch / connection pill ----------------
function renderSite() {
  const gemini = site() === 'gemini';
  document.querySelectorAll('[data-site]').forEach((b) => b.classList.toggle('active', b.dataset.site === site()));
  $('btnOpenFlow').textContent = `Open ${siteName()}`;
  $('btnNewProject').textContent = gemini ? 'New chat' : 'New project';
  $('btnSummaryNew').textContent = gemini ? 'New chat' : 'New project';
}

function setSite(next) {
  if (app.runner.state !== 'idle' || next === site()) return;
  app.session.site = next;
  persistSession();
  renderSite();
  emit('siteChanged');
  $('connPill').className = 'pill';
  $('connText').textContent = `Checking ${siteName()} tab…`;
  refreshConnection();
  scheduleRender();
  log(`Target: ${SITES[next].fullName}`);
}

let connSeq = 0;
async function refreshConnection() {
  const seq = ++connSeq;
  const current = site();
  const name = siteName();
  const pill = $('connPill');
  const show = (cls, text) => {
    if (seq !== connSeq) return; // the site was switched meanwhile
    pill.className = `pill ${cls}`;
    $('connText').textContent = text;
  };
  try {
    const tab = await findSiteTab(current, { open: false });
    if (seq !== connSeq) return;
    if (!tab) {
      show('bad', `No ${SITES[current].fullName} tab open`);
      $('btnOpenFlow').hidden = false;
      return;
    }
    $('btnOpenFlow').hidden = true;
    const info = await callAgent(tab.id, 'ping', { selectors: SITES[current].selectors(app.settings) }, { timeoutMs: 4000, retries: 1 });
    if (current === 'gemini') {
      if (info.hasPromptBox) show('ok', 'Gemini connected');
      else show('warn', 'Gemini open — prompt box not found (signed in?)');
    } else if (info.isProject && info.hasPromptBox) show('ok', 'Flow project connected');
    else show('warn', info.isProject ? 'Flow project — prompt box not found' : 'Flow open — no project yet');
  } catch {
    show('warn', `${name} tab found — reload it once`);
  }
}

// ---------------- log ----------------
function appendLog(entry) {
  const list = $('logList');
  const time = entry.t.toLocaleTimeString([], { hour12: false });
  list.append(el('li', { class: entry.level }, el('time', { text: time }), entry.message));
  while (list.childElementCount > 800) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
  $('logCount').textContent = `${logLines.length}`;
  if (entry.level === 'error') $('logCard').open = true;
}

// ---------------- boot ----------------
async function boot() {
  app.settings = await loadSettings();
  app.session = await loadSession();
  applyTheme();
  app.assets = (await listAssets()).map((a) => ({ ...a, thumbUrl: URL.createObjectURL(a.blob) }));

  app.runner = new Runner({
    getSettings: () => app.settings,
    getSession: () => app.session,
    getAssets: () => app.assets,
    onUpdate: () => {
      persistSession();
      scheduleRender();
    },
    onState: scheduleRender,
    onStep: (text) => {
      lastStep = text;
      renderProgress();
    },
    onFinished: () => {
      const c = counts();
      if (c.done) log(`Finished: ${c.success} success, ${c.failed} failed`, c.failed ? 'warn' : 'ok');
      scheduleRender();
    },
  });

  onLog(appendLog);
  initSettings();
  initZip();
  initAssets();
  initPrompt();
  initFrames();
  initSplit();
  initPublish();

  $('projectName').value = app.session.projectName;
  $('projectName').addEventListener('input', (e) => {
    app.session.projectName = e.target.value;
    persistSession();
  });
  $('btnStart').addEventListener('click', () => startRun(false));
  $('btnPause').addEventListener('click', () => app.runner.pause());
  $('btnStop').addEventListener('click', () => app.runner.stop());
  $('btnNewProject').addEventListener('click', newProject);
  $('btnSummaryNew').addEventListener('click', newProject);
  $('btnRegenerate').addEventListener('click', () => {
    app.session.queue.forEach((i) => {
      if (i.status === 'failed') {
        i.status = 'pending';
        i.error = '';
      }
    });
    persistSession();
    startRun(true);
  });
  $('btnZipResults').addEventListener('click', zipResults);
  $('btnResultsToAssets').addEventListener('click', resultsToAssets);
  $('btnOpenFolder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
  $('btnOpenFlow').addEventListener('click', () => chrome.tabs.create({ url: SITES[site()].home(app.settings) }));
  document.querySelectorAll('[data-site]').forEach((b) => b.addEventListener('click', () => setSite(b.dataset.site)));
  renderSite();
  $('btnCopyLog').addEventListener('click', async () => {
    await navigator.clipboard.writeText(logLines.map((l) => `${l.t.toISOString()} [${l.level}] ${l.message}`).join('\n'));
    toast('Log copied');
  });
  $('btnClearLog').addEventListener('click', () => {
    logLines.length = 0;
    $('logList').replaceChildren();
    $('logCount').textContent = '';
  });
  on('settingsChanged', scheduleRender);

  renderAll();
  refreshConnection();
  setInterval(() => {
    if (app.runner.state !== 'running') refreshConnection();
    if (app.runner.state !== 'idle') renderProgress();
  }, 3000);
  chrome.tabs.onActivated.addListener(() => app.runner.state !== 'running' && refreshConnection());
  log('FlowBatch ready');
}

boot().catch((e) => {
  console.error(e);
  document.body.prepend(el('pre', { class: 'diag', text: `FlowBatch failed to start: ${e.stack || e.message}` }));
});
