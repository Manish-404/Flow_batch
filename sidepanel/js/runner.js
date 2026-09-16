// Queue orchestration: one prompt at a time — attach references, type, submit,
// wait until Flow finishes (or fails), download, then move on.
import { MODELS } from './store.js';
import { findFlowTab, callAgent, pinTab, unpinTab, waitTabComplete } from './flow.js';
import { downloadMedia } from './downloads.js';
import { sleep, log, pad, slug, sanitizeSegment, promptForFlow, blobToDataUrl, dataUrlToBlob } from './utils.js';

class StopError extends Error {
  constructor() {
    super('Stopped');
    this.name = 'StopError';
  }
}

export class Runner {
  /**
   * ctx: { getSettings(), getSession(), getAssets(), onUpdate(), onState(), onStep(text), onFinished() }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.state = 'idle'; // idle | running | paused
    this.pauseRequested = false;
    this.stopRequested = false;
    this.tabId = null;
    this.startedAt = 0;
    this.itemDurations = [];
    this.appliedVideoMode = null;
  }

  get settings() {
    return this.ctx.getSettings();
  }
  get session() {
    return this.ctx.getSession();
  }

  call(action, payload = {}, opts) {
    return callAgent(this.tabId, action, { selectors: this.settings.selectors, ...payload }, opts);
  }

  pause() {
    if (this.state === 'running') {
      this.pauseRequested = true;
      log('Pause requested — the current prompt will finish first');
      this.ctx.onState();
    }
  }

  stop() {
    if (this.state === 'paused') {
      this.state = 'idle';
      unpinTab();
      this.ctx.onState();
      this.ctx.onFinished();
      return;
    }
    if (this.state === 'running') {
      this.stopRequested = true;
      log('Stopping…', 'warn');
      this.ctx.onState();
    }
  }

  async wait(ms, label) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.stopRequested) throw new StopError();
      if (label) this.ctx.onStep(`${label} (${Math.ceil((until - Date.now()) / 1000)}s)`);
      await sleep(Math.min(250, until - Date.now()));
    }
  }

  async start() {
    if (this.state === 'running') return;
    this.state = 'running';
    this.pauseRequested = false;
    this.stopRequested = false;
    this.startedAt = Date.now();
    this.itemDurations = [];
    this.appliedVideoMode = null;
    this.ctx.onState();

    try {
      const tab = await findFlowTab({ open: true, flowUrl: this.settings.flowUrl });
      this.tabId = tab.id;
      pinTab(tab.id);
      log(`Using Flow tab: ${tab.title || tab.url}`);
      await this.ensureProject(false);
      if (this.settings.applyFlowSettings) await this.applyFlowSettings();

      let consecutiveFails = 0;
      for (;;) {
        if (this.stopRequested || this.pauseRequested) break;
        const item = this.session.queue.find((q) => q.status === 'pending');
        if (!item) break;
        const ok = await this.runItem(item);
        if (this.stopRequested) break;
        consecutiveFails = ok ? 0 : consecutiveFails + 1;
        if (this.settings.stopOnFailure && consecutiveFails >= 3) {
          log('3 failures in a row — queue stopped. Check the Flow tab and the log.', 'error');
          break;
        }
        const more = this.session.queue.some((q) => q.status === 'pending');
        if (more && !this.pauseRequested) await this.wait(this.settings.delaySec * 1000, 'Waiting before next prompt');
      }
    } catch (e) {
      if (!(e instanceof StopError)) log(e.message, 'error');
    } finally {
      for (const q of this.session.queue) if (q.status === 'running') q.status = 'pending';
      const pending = this.session.queue.some((q) => q.status === 'pending');
      this.state = this.pauseRequested && !this.stopRequested && pending ? 'paused' : 'idle';
      if (this.state === 'paused') log('Paused');
      if (this.stopRequested) log('Stopped', 'warn');
      this.pauseRequested = false;
      this.stopRequested = false;
      this.ctx.onStep('');
      this.ctx.onUpdate();
      this.ctx.onState();
      if (this.state === 'idle') {
        unpinTab();
        this.ctx.onFinished();
      }
    }
  }

  // ---------- project / settings ----------
  async ensureProject(forceNew) {
    const s = this.settings;
    let info = await this.call('ping', {}, { timeoutMs: 20000 });
    if (!forceNew && info.isProject) return info;
    if (!forceNew && !s.autoNewProject) {
      if (info.hasPromptBox) {
        log('No Flow project detected in the URL — using the prompt box on this page', 'warn');
        return info;
      }
      throw new Error('Open a Flow project first, or enable "Create a Flow project automatically" in Settings');
    }

    this.ctx.onStep('Creating a new Flow project');
    log('Creating a new Flow project…');
    try {
      await this.call('clickNewProject', {}, { timeoutMs: 15000 });
    } catch {
      await chrome.tabs.update(this.tabId, { url: s.flowUrl });
      await waitTabComplete(this.tabId, 30000);
      await sleep(2500);
      await this.call('clickNewProject', {}, { timeoutMs: 20000 });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (this.stopRequested) throw new StopError();
      await sleep(1200);
      try {
        info = await this.call('ping', {}, { timeoutMs: 8000, retries: 1 });
        if (info.isProject && info.hasPromptBox) {
          log(`Project ready: ${info.url}`, 'ok');
          await sleep(1500);
          return info;
        }
      } catch {
        /* page is navigating */
      }
    }
    throw new Error('Flow project did not open within 60s');
  }

  async applyFlowSettings() {
    const { mode, aspect, model, count, queue, seqFrames } = this.session;
    const m = MODELS[mode].find((x) => x.id === model);
    // With sequential frames the mode changes per scene, so leave it to applyVideoMode().
    const perItemMode = mode === 'video' && seqFrames && queue.some((q) => q.videoMode);
    this.ctx.onStep('Applying Flow settings');
    try {
      const r = await this.call(
        'applySettings',
        {
          mode: perItemMode ? null : mode,
          aspect: aspect === 'keep' ? null : aspect,
          model: m?.match ? m.label : null,
          modelMatch: m?.match || null,
          count,
          hasReferences: queue.some((q) => q.mentions.length),
        },
        { timeoutMs: 60000, retries: 1 }
      );
      const missing = r.report.some((x) => /not-found/.test(x));
      log(`Flow settings → ${r.report.join(' · ')}`, missing ? 'warn' : 'info');
      if (missing) log('Some settings could not be found — set them manually in Flow if needed', 'warn');
    } catch (e) {
      log(`Could not apply Flow settings: ${e.message}`, 'warn');
    }
  }

  /** Switch Flow between "Frames to video" and "Ingredients to video" only when it changes. */
  async applyVideoMode(item, step) {
    if (this.session.mode !== 'video' || !item.videoMode) return;
    if (this.appliedVideoMode === item.videoMode) return;
    step(`Switching Flow to ${item.videoMode} to video`);
    try {
      const r = await this.call(
        'applySettings',
        { mode: 'video', videoMode: item.videoMode, aspect: null, model: null, count: null },
        { timeoutMs: 60000, retries: 1 }
      );
      const status = r.report.join(' · ');
      const ok = /: (set|already)/.test(status);
      log(`#${pad(item.n, 2)} video mode → ${item.videoMode} (${status})`, ok ? 'info' : 'warn');
      if (ok) this.appliedVideoMode = item.videoMode;
      else log(`Could not find the "${item.videoMode} to video" option — set it by hand in Flow`, 'warn');
    } catch (e) {
      log(`Could not switch video mode: ${e.message}`, 'warn');
    }
  }

  // ---------- one queue item ----------
  async runItem(item) {
    const s = this.settings;
    const t0 = Date.now();
    item.status = 'running';
    item.error = '';
    item.results = [];
    this.ctx.onUpdate();
    const attempts = s.retries + 1;
    for (let a = 1; a <= attempts; a++) {
      if (this.stopRequested) break;
      item.attempts = a;
      try {
        const media = await this.generate(item);
        item.results = media.map((m) => ({ url: m.url, kind: m.kind, w: m.w, h: m.h }));
        item.status = 'success';
        item.error = '';
        this.itemDurations.push(Date.now() - t0);
        log(`#${pad(item.n, 2)} done — ${media.length} result(s) in ${Math.round((Date.now() - t0) / 1000)}s`, 'ok');
        this.ctx.onUpdate();
        if (s.autoDownload) await this.downloadResults(item);
        return true;
      } catch (e) {
        if (e instanceof StopError || this.stopRequested) break;
        item.error = e.message;
        log(`#${pad(item.n, 2)} attempt ${a}/${attempts} failed: ${e.message}`, 'error');
        this.ctx.onUpdate();
        if (a < attempts) {
          try {
            await this.wait(5000, 'Retrying');
          } catch {
            break;
          }
        }
      }
    }
    item.status = this.stopRequested ? 'pending' : 'failed';
    this.ctx.onUpdate();
    return false;
  }

  async generate(item) {
    const s = this.settings;
    const tag = `#${pad(item.n, 2)}`;
    const step = (t) => this.ctx.onStep(`${tag} · ${t}`);
    const assets = this.ctx.getAssets();
    const byName = new Map(assets.map((a) => [a.name.toLowerCase(), a]));

    step('Waiting for Flow prompt box');
    await this.call('waitReady', { timeoutMs: 30000 }, { timeoutMs: 40000 });

    await this.applyVideoMode(item, step);

    if (s.clearReferences) {
      const r = await this.call('clearReferences', {}, { timeoutMs: 20000 });
      if (r.removed) log(`${tag} removed ${r.removed} previous reference(s)`);
    }

    // A frames-to-video scene needs its two images in the start and end slots, in that order.
    const slots = item.videoMode === 'frames' ? ['start', 'end'] : [];
    for (const [i, name] of item.mentions.entries()) {
      if (this.stopRequested) throw new StopError();
      const asset = byName.get(name.toLowerCase());
      if (!asset) continue;
      const slot = slots[i] || null;
      step(`Uploading @${asset.name}${slot ? ` → ${slot} frame` : ''}`);
      const dataUrl = await blobToDataUrl(asset.blob);
      const r = await this.call('attachImage', { name: asset.name, dataUrl, type: asset.type, slot }, { timeoutMs: 120000, retries: 0 });
      const where = slot ? ` as ${r.slotFound ? `${slot} frame` : `${slot} frame (slot not found — used upload order)`}` : '';
      log(`${tag} attached @${asset.name}${where} via ${r.method}${r.confirmed ? '' : ' (thumbnail not confirmed)'}${r.dialogClicks?.length ? ` · clicked ${r.dialogClicks.join(', ')}` : ''}`, r.confirmed ? 'info' : 'warn');
      if (r.openDialogs?.length) log(`${tag} dialog still open: ${r.openDialogs.join(' | ')}`, 'warn');
    }

    step('Typing prompt');
    const text = promptForFlow(item.prompt, assets.map((a) => a.name), s.mentionMode);
    const typed = await this.call('setPrompt', { text }, { timeoutMs: 20000 });
    if (!typed.exact) log(`${tag} prompt text may not match exactly (editor reformatted it)`, 'warn');
    await sleep(400);

    const baseline = await this.call('snapshot', {}, { timeoutMs: 20000 });
    if (this.stopRequested) throw new StopError();
    step('Submitting');
    const sub = await this.call('submit', {}, { timeoutMs: 20000, retries: 0 });
    log(`${tag} submitted via ${sub.method}${sub.label ? ` (“${sub.label}”)` : ''}${sub.note ? ` — ${sub.note}` : ''}`);

    return this.waitForResult(item, baseline, step);
  }

  async waitForResult(item, baseline, step) {
    const s = this.settings;
    const kind = this.session.mode === 'video' ? 'video' : 'image';
    const expected = Number(this.session.count) || 1;
    const t0 = Date.now();
    const timeout = s.timeoutSec * 1000;
    let stable = 0;
    let fullPolls = 0;
    let failPolls = 0;
    let lastCount = -1;
    let accepted = false;
    let lastDialog = '';
    await this.wait(2500);

    for (;;) {
      await this.wait(s.pollSec * 1000);
      const elapsed = Date.now() - t0;
      let r;
      try {
        r = await this.call('poll', { baseline, kind }, { timeoutMs: 20000, retries: 2 });
      } catch (e) {
        log(`Poll error: ${e.message}`, 'warn');
        if (elapsed > timeout) throw new Error(`Timed out after ${s.timeoutSec}s`);
        continue;
      }
      const n = r.newMedia.length;
      if (!accepted && (r.busyDelta > 0 || n || r.pendingMedia || r.promptText !== baseline.promptText)) {
        accepted = true;
        log(`#${pad(item.n, 2)} generation started`);
      }
      if (r.dialogText && r.dialogText !== lastDialog) {
        lastDialog = r.dialogText;
        log(`Dialog on Flow page: ${r.dialogText}`, 'warn');
      }
      step(`Generating… ${Math.round(elapsed / 1000)}s${n ? ` · ${Math.min(n, expected)}/${expected} ready` : ''}${r.busyDelta > 0 ? ' · in progress' : ''}`);

      const idle = r.busyDelta <= 0 && r.pendingMedia === 0;
      if (n >= expected) {
        fullPolls++;
        if ((idle && fullPolls >= 2) || fullPolls >= 8) return r.newMedia.slice(0, expected);
      } else fullPolls = 0;

      if (n > 0 && n < expected && idle) {
        stable = n === lastCount ? stable + 1 : 0;
        if (stable >= 6) {
          log(`#${pad(item.n, 2)} got ${n} of ${expected} outputs`, 'warn');
          return r.newMedia;
        }
      } else stable = 0;
      lastCount = n;

      if (n === 0 && (r.failDelta > 0 || r.toastFailure)) {
        failPolls++;
        if (failPolls >= 2 && r.busyDelta <= 0) throw new Error(`Flow reported: ${r.failText || 'generation failed'}`);
      } else failPolls = 0;

      if (elapsed > timeout) {
        if (n > 0) return r.newMedia.slice(0, expected);
        throw new Error(`Timed out after ${s.timeoutSec}s${accepted ? '' : ' — submission was not detected on the page'}`);
      }
    }
  }

  folder() {
    const s = this.settings;
    return `${sanitizeSegment(s.baseFolder, 'FlowBatch')}/${sanitizeSegment(this.session.projectName, 'Untitled')}`;
  }

  async downloadResults(item) {
    const base = item.mentions.length ? item.mentions.join('_') : slug(item.prompt);
    for (let k = 0; k < item.results.length; k++) {
      const res = item.results[k];
      const pathNoExt = `${this.folder()}/${pad(item.n)}_${sanitizeSegment(base)}${item.results.length > 1 ? `_${k + 1}` : ''}`;
      try {
        const d = await downloadMedia({
          url: res.url,
          kind: res.kind,
          pathNoExt,
          readViaPage: (url) => this.call('fetchAsDataUrl', { url }, { timeoutMs: 90000 }),
        });
        res.filename = d.filename;
        res.download = 'in_progress';
        this.ctx.onUpdate();
        d.verified.then((state) => {
          res.download = state;
          if (state !== 'complete') log(`Download ${d.filename}: ${state}`, 'error');
          this.ctx.onUpdate();
        });
      } catch (e) {
        res.download = `failed: ${e.message}`;
        log(`Download failed for #${pad(item.n, 2)}: ${e.message}`, 'error');
      }
    }
    this.ctx.onUpdate();
  }

  /**
   * Bytes of one generated result, for zipping or re-importing as an asset.
   * blob:/data: URLs only exist inside the Flow page, so those are read through the tab.
   */
  async resultBlob(res) {
    if (res.url.startsWith('data:')) return dataUrlToBlob(res.url);
    if (!res.url.startsWith('blob:')) {
      try {
        const r = await fetch(res.url, { credentials: 'include' });
        if (r.ok) {
          const blob = await r.blob();
          if (blob.size && !/text\/html/i.test(blob.type)) return blob;
        }
      } catch {
        /* fall through to the page */
      }
    }
    if (this.tabId == null) {
      const tab = await findFlowTab({ open: false });
      if (!tab) throw new Error('Open the Flow tab that produced these results');
      this.tabId = tab.id;
    }
    const { dataUrl } = await this.call('fetchAsDataUrl', { url: res.url }, { timeoutMs: 90000 });
    return dataUrlToBlob(dataUrl);
  }

  async downloadItem(item) {
    const tab = await findFlowTab({ open: false });
    if (tab) this.tabId = tab.id;
    await this.downloadResults(item);
  }

  async newProject() {
    const tab = await findFlowTab({ open: true, flowUrl: this.settings.flowUrl });
    this.tabId = tab.id;
    await chrome.tabs.update(tab.id, { active: true });
    const info = await this.call('ping', {}, { timeoutMs: 15000 });
    if (info.isProject) {
      await chrome.tabs.update(tab.id, { url: this.settings.flowUrl });
      await waitTabComplete(tab.id, 30000);
      await sleep(2500);
    }
    await this.ensureProject(true);
  }

  eta() {
    const pending = this.session.queue.filter((q) => q.status === 'pending' || q.status === 'running').length;
    if (!this.itemDurations.length || !pending) return null;
    const avg = this.itemDurations.reduce((a, b) => a + b, 0) / this.itemDurations.length;
    return pending * (avg + this.settings.delaySec * 1000);
  }
}
