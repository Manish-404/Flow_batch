// Queue orchestration: one prompt at a time — attach references, type, submit,
// wait until Flow or Gemini finishes (or fails), download, then move on.
import { MODELS, GEMINI_MODELS } from './store.js';
import { SITES, findSiteTab, callAgent, stageFiles, pinTab, unpinTab, waitTabComplete } from './site.js';
import { downloadMedia, fetchMediaBlob } from './downloads.js';
import { recordFlowInfo, spendOne } from './credits.js';
import { sleep, log, pad, slug, sanitizeSegment, promptForFlow, blobToDataUrl, isVideoAsset, assetFileName, geminiChatId } from './utils.js';

/** "@clip_001" → "clip_001.mp4" for files already in the Gemini chat, so the prompt can point at them. */
const nameChatFiles = (prompt, assets) =>
  assets.reduce((p, a) => p.replace(new RegExp(`@${a.name}(?![A-Za-z0-9_-])`, 'gi'), a.onSite.gemini.file || assetFileName(a)), prompt);

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
    this.site = 'flow'; // the site of the current run
    this.tabId = null;
    this.startedAt = 0;
    this.itemDurations = [];
    this.appliedVideoMode = null;
    this.geminiApplied = false; // tool and model chosen in the current Gemini chat
  }

  get settings() {
    return this.ctx.getSettings();
  }
  get session() {
    return this.ctx.getSession();
  }
  get siteName() {
    return SITES[this.site].name;
  }

  call(action, payload = {}, opts) {
    return callAgent(this.tabId, action, { selectors: SITES[this.site].selectors(this.settings), ...payload }, opts);
  }

  useTab(site, tabId) {
    this.site = site;
    this.tabId = tabId;
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
    this.geminiApplied = false;
    this.site = this.session.site === 'gemini' ? 'gemini' : 'flow';
    this.ctx.onState();

    try {
      const tab = await findSiteTab(this.site, { open: true, settings: this.settings });
      this.useTab(this.site, tab.id);
      pinTab(this.site, tab.id);
      log(`Using ${this.siteName} tab: ${tab.title || tab.url}`);
      if (this.site === 'gemini') {
        await this.call('waitReady', { timeoutMs: 30000 }, { timeoutMs: 40000 });
      } else {
        await this.ensureProject(false);
        if (this.settings.applyFlowSettings) await this.applyFlowSettings();
      }

      let consecutiveFails = 0;
      for (;;) {
        if (this.stopRequested || this.pauseRequested) break;
        const item = this.session.queue.find((q) => q.status === 'pending');
        if (!item) break;
        const ok = await this.runItem(item);
        if (this.stopRequested) break;
        consecutiveFails = ok ? 0 : consecutiveFails + 1;
        if (this.settings.stopOnFailure && consecutiveFails >= 3) {
          log(`3 failures in a row — queue stopped. Check the ${this.siteName} tab and the log.`, 'error');
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

  // ---------- Flow project / settings ----------
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
      if (r.priced) {
        recordFlowInfo(r.priced);
        if (r.priced.credits != null) log(`Flow: ${r.priced.credits} credits per prompt${r.priced.model ? ` (${r.priced.model}${r.priced.duration ? `, ${r.priced.duration}s` : ''})` : ''}${r.priced.plan ? ` · ${r.priced.plan} plan` : ''}`);
      }
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

  // ---------- Gemini chat / settings ----------
  /** Start a fresh chat so earlier images and replies don't steer the next result. */
  async openGeminiChat() {
    const r = await this.call('newChat', {}, { timeoutMs: 20000, retries: 1 });
    if (r.method === 'navigate') {
      await sleep(1000);
      await waitTabComplete(this.tabId, 30000);
      await sleep(1500);
    }
    await this.call('waitReady', { timeoutMs: 30000 }, { timeoutMs: 40000 });
    this.geminiApplied = false;
    return r;
  }

  /** Pick the Create images / Create videos tool and the model — once per chat. */
  async applyGeminiSettings(tag, step) {
    if (!this.settings.applyFlowSettings || this.geminiApplied) return;
    this.geminiApplied = true;
    const { mode, gemini } = this.session;
    const m = GEMINI_MODELS[mode].find((x) => x.id === gemini?.model);
    step(`Choosing Gemini's ${mode === 'video' ? 'video' : 'image'} tool`);
    try {
      const r = await this.call('applySettings', { mode, modelMatch: m?.match || null }, { timeoutMs: 30000, retries: 1 });
      const missing = r.report.some((x) => /not-found|unavailable/.test(x));
      log(`${tag} Gemini → ${r.report.join(' · ')}`, missing ? 'warn' : 'info');
      if (missing) log('Pick the tool or model in Gemini by hand, or calibrate it in Settings → Gemini elements', 'warn');
    } catch (e) {
      log(`Could not choose the Gemini tool: ${e.message}`, 'warn');
    }
  }

  // ---------- assets already on the site ----------
  /**
   * An asset marked as already uploaded (Upload assets → ☁) is not uploaded again. Flow: it is
   * picked by name from the file picker Flow's add button opens, and uploaded after all if it
   * isn't there. Gemini: it is in the chat it was marked in, so the prompt names its file —
   * only while that chat is open and each prompt doesn't start a new one.
   * Returns true when the asset needs no upload.
   */
  async reuseUpload(asset, { tag, step, slot, inChat }) {
    const mark = asset.onSite?.[this.site];
    if (!mark) return false;
    const file = mark.file || assetFileName(asset);
    if (this.site === 'gemini') {
      if (this.settings.geminiNewChat) {
        log(`${tag} @${asset.name} is marked as in Gemini, but each prompt starts a new chat — uploading it`, 'warn');
        return false;
      }
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      if (mark.chat && mark.chat !== geminiChatId(tab?.url)) {
        log(`${tag} @${asset.name} is marked as in another Gemini chat — uploading it`, 'warn');
        return false;
      }
      inChat.push(asset);
      log(`${tag} @${asset.name} is already in this Gemini chat — named as ${file} in the prompt, not uploaded`);
      return true;
    }
    step(`Picking @${asset.name} from Flow${slot ? ` → ${slot} frame` : ''}`);
    try {
      const names = [...new Set([asset.name, file.replace(/\.[a-z0-9]{2,4}$/i, '')])];
      const r = await this.call('attachExisting', { names, slot }, { timeoutMs: 60000, retries: 0 });
      if (r.found) {
        log(
          `${tag} picked @${asset.name} from Flow (“${r.label}”)${slot && !r.slotFound ? ` — ${slot} frame slot not found` : ''}` +
            `${r.confirmed ? '' : ' (thumbnail not confirmed)'} — not uploaded again`,
          r.confirmed ? 'info' : 'warn'
        );
        if (r.openDialogs?.length) log(`${tag} dialog still open: ${r.openDialogs.join(' | ')}`, 'warn');
        return true;
      }
      log(`${tag} @${asset.name} is marked as in Flow but wasn't found in Flow's file picker — uploading it`, 'warn');
    } catch (e) {
      log(`${tag} could not pick @${asset.name} from Flow (${e.message}) — uploading it`, 'warn');
    }
    return false;
  }

  /** A clip is too big for one message: stream it into the tab in chunks, then attach it. */
  async attachVideo(asset, onProgress) {
    const [key] = await stageFiles(this.tabId, [{ blob: asset.blob, name: assetFileName(asset), type: asset.type }], { onProgress });
    const settleMs = Math.min(300000, 45000 + (asset.blob.size / 1048576) * 2000);
    const r = await this.call('attachFiles', { keys: [key], settleMs }, { timeoutMs: settleMs + 60000, retries: 0 });
    return { method: r.method, confirmed: r.added >= 1, slotFound: false, error: r.files[0]?.error || null, dialogClicks: r.dialogClicks, openDialogs: r.openDialogs };
  }

  // ---------- one queue item ----------
  async runItem(item) {
    const s = this.settings;
    const t0 = Date.now();
    item.status = 'running';
    item.error = '';
    item.results = [];
    item.site = this.site;
    this.ctx.onUpdate();
    const attempts = s.retries + 1;
    for (let a = 1; a <= attempts; a++) {
      if (this.stopRequested) break;
      item.attempts = a;
      try {
        const media = await this.generate(item);
        item.results = media.map((m) => ({
          url: m.url,
          altUrls: m.altUrls || [],
          preview: m.preview || null,
          kind: m.kind,
          w: m.w,
          h: m.h,
          site: this.site,
        }));
        item.status = 'success';
        item.error = '';
        if (this.site === 'flow') spendOne(); // until Flow shows the real balance
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
    const gemini = this.site === 'gemini';
    const tag = `#${pad(item.n, 2)}`;
    const step = (t) => this.ctx.onStep(`${tag} · ${t}`);
    const assets = this.ctx.getAssets();
    const byName = new Map(assets.map((a) => [a.name.toLowerCase(), a]));

    if (gemini && s.geminiNewChat) {
      step('Opening a new Gemini chat');
      await this.openGeminiChat();
    }
    step(`Waiting for ${this.siteName} prompt box`);
    await this.call('waitReady', { timeoutMs: 30000 }, { timeoutMs: 40000 });

    if (gemini) await this.applyGeminiSettings(tag, step);
    else await this.applyVideoMode(item, step);

    if (s.clearReferences) {
      const r = await this.call('clearReferences', {}, { timeoutMs: 20000 });
      if (r.removed) log(`${tag} removed ${r.removed} previous reference(s)`);
    }

    // A Flow frames-to-video scene needs its two images in the start and end slots, in that order.
    const slots = !gemini && item.videoMode === 'frames' ? ['start', 'end'] : [];
    const inChat = []; // Gemini already has these in the open chat; the prompt names them instead
    for (const [i, name] of item.mentions.entries()) {
      if (this.stopRequested) throw new StopError();
      const asset = byName.get(name.toLowerCase());
      if (!asset) continue;
      const video = isVideoAsset(asset);
      const slot = video ? null : slots[i] || null; // a clip can't be a start or end frame
      if (await this.reuseUpload(asset, { tag, step, slot, inChat })) continue;
      step(`Uploading @${asset.name}${slot ? ` → ${slot} frame` : ''}`);
      const r = video
        ? await this.attachVideo(asset, (p) => step(`Uploading @${asset.name} · ${Math.round(p * 100)}%`))
        : await this.call('attachImage', { name: asset.name, dataUrl: await blobToDataUrl(asset.blob), type: asset.type, slot }, { timeoutMs: 120000, retries: 0 });
      const where = slot ? ` as ${r.slotFound ? `${slot} frame` : `${slot} frame (slot not found — used upload order)`}` : '';
      log(
        `${tag} attached @${asset.name}${where} via ${r.method}${r.confirmed ? '' : ' (thumbnail not confirmed)'}${r.error ? ` — ${r.error}` : ''}${r.dialogClicks?.length ? ` · clicked ${r.dialogClicks.join(', ')}` : ''}`,
        r.confirmed && !r.error ? 'info' : 'warn'
      );
      if (r.openDialogs?.length) log(`${tag} dialog still open: ${r.openDialogs.join(' | ')}`, 'warn');
    }

    step('Typing prompt');
    let text = promptForFlow(nameChatFiles(item.prompt, inChat), assets.map((a) => a.name), s.mentionMode);
    // Gemini has no ratio control; a chosen ratio goes into the prompt.
    const ratio = this.session.gemini?.aspect;
    if (gemini && ratio && ratio !== 'keep') text += `\n\nAspect ratio: ${ratio}.`;
    const typed = await this.call('setPrompt', { text }, { timeoutMs: 20000 });
    if (!typed.exact) log(`${tag} prompt text may not match exactly (editor reformatted it)`, 'warn');
    await sleep(400);

    const baseline = await this.call('snapshot', {}, { timeoutMs: 20000 });
    if (this.stopRequested) throw new StopError();
    step('Submitting');
    // Gemini holds the send button until uploads finish, so its submit can take a while.
    const sub = await this.call('submit', {}, { timeoutMs: gemini ? 120000 : 20000, retries: 0 });
    log(`${tag} submitted via ${sub.method}${sub.label ? ` (“${sub.label}”)` : ''}${sub.note ? ` — ${sub.note}` : ''}`);

    return gemini ? this.waitForGemini(item, baseline, step) : this.waitForResult(item, baseline, step);
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

  /**
   * Wait for Gemini's reply. It is done when the stop button is gone and nothing in the reply
   * is still loading; a finished reply without media is a failure, reported with Gemini's own
   * words. Veo shows its video well after the text, so a video reply gets a long grace period.
   */
  async waitForGemini(item, baseline, step) {
    const s = this.settings;
    const tag = `#${pad(item.n, 2)}`;
    const kind = this.session.mode === 'video' ? 'video' : 'image';
    const noun = kind === 'video' ? 'a video' : 'an image';
    const grace = kind === 'video' ? 150000 : 12000;
    const t0 = Date.now();
    const timeout = s.timeoutSec * 1000;
    let accepted = false;
    let mediaPolls = 0;
    let donePolls = 0;
    let doneSince = 0;
    let lastDialog = '';
    let last = null;
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
      last = r;
      const n = r.newMedia.length;
      if (!accepted && (r.sent || n || r.promptText !== baseline.promptText)) {
        accepted = true;
        log(`${tag} Gemini is answering`);
      }
      if (r.dialogText && r.dialogText !== lastDialog) {
        lastDialog = r.dialogText;
        log(`Dialog on Gemini page: ${r.dialogText}`, 'warn');
      }
      const working = r.generating || r.loaders > 0 || r.pendingMedia > 0;
      step(`Generating… ${Math.round(elapsed / 1000)}s${n ? ` · ${n} ready` : ''}${working ? ' · in progress' : ''}`);

      if (n > 0) {
        mediaPolls++;
        if ((r.done && mediaPolls >= 2) || mediaPolls >= 10) return r.newMedia;
        continue;
      }
      mediaPolls = 0;

      if (r.done) {
        donePolls++;
        doneSince ||= Date.now();
        const said = r.replyText ? `: “${r.replyText.slice(0, 220)}”` : '';
        if ((r.refused || r.failed) && donePolls >= 2) throw new Error(`Gemini replied without ${noun}${said || ` — ${r.failText}`}`);
        if (donePolls >= 2 && Date.now() - doneSince >= grace) throw new Error(`Gemini replied without ${noun}${said}`);
      } else {
        donePolls = 0;
        doneSince = 0;
      }

      if (elapsed > timeout) {
        const said = last?.replyText ? ` · Gemini said: “${last.replyText.slice(0, 160)}”` : '';
        throw new Error(`Timed out after ${s.timeoutSec}s${accepted ? '' : ' — the prompt was not seen on the page'}${said}`);
      }
    }
  }

  folder() {
    const s = this.settings;
    return `${sanitizeSegment(s.baseFolder, 'FlowBatch')}/${sanitizeSegment(this.session.projectName, 'Untitled')}`;
  }

  /** `tabId`: the tab that produced the item, for URLs only it can read. */
  async downloadResults(item, tabId = this.tabId) {
    const base = item.mentions.length ? item.mentions.join('_') : slug(item.prompt);
    for (let k = 0; k < item.results.length; k++) {
      const res = item.results[k];
      const pathNoExt = `${this.folder()}/${pad(item.n)}_${sanitizeSegment(base)}${item.results.length > 1 ? `_${k + 1}` : ''}`;
      try {
        const d = await downloadMedia({
          url: res.url,
          altUrls: res.altUrls,
          kind: res.kind,
          pathNoExt,
          readViaPage: (url) => callAgent(tabId, 'fetchAsDataUrl', { url }, { timeoutMs: 90000 }),
          viaPage: res.site === 'gemini',
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
   * blob:/data: URLs only exist inside the page, so those are read through the tab of the
   * site that made the result (while a queue runs, that is its pinned tab).
   */
  async resultBlob(res) {
    const site = res.site || 'flow';
    const readViaPage = async (url) => {
      const tab = await findSiteTab(site, { open: false });
      if (!tab) throw new Error(`no ${SITES[site].name} tab`);
      return callAgent(tab.id, 'fetchAsDataUrl', { url }, { timeoutMs: 90000 });
    };
    const blob = await fetchMediaBlob([res.url, ...(res.altUrls || [])], { readViaPage, viaPage: true });
    if (!blob) throw new Error(`Could not read a result — keep the ${SITES[site].name} tab that produced it open`);
    return blob;
  }

  /** "Download again" — also works while another queue runs, without touching its tab. */
  async downloadItem(item) {
    const tab = await findSiteTab(item.site || 'flow', { open: false });
    await this.downloadResults(item, tab?.id ?? null);
  }

  async newProject() {
    const tab = await findSiteTab('flow', { open: true, settings: this.settings });
    this.useTab('flow', tab.id);
    await chrome.tabs.update(tab.id, { active: true });
    const info = await this.call('ping', {}, { timeoutMs: 15000 });
    if (info.isProject) {
      await chrome.tabs.update(tab.id, { url: this.settings.flowUrl });
      await waitTabComplete(tab.id, 30000);
      await sleep(2500);
    }
    await this.ensureProject(true);
  }

  async newChat() {
    const tab = await findSiteTab('gemini', { open: true, settings: this.settings });
    this.useTab('gemini', tab.id);
    await chrome.tabs.update(tab.id, { active: true });
    await this.openGeminiChat();
  }

  eta() {
    const pending = this.session.queue.filter((q) => q.status === 'pending' || q.status === 'running').length;
    if (!this.itemDurations.length || !pending) return null;
    const avg = this.itemDurations.reduce((a, b) => a + b, 0) / this.itemDurations.length;
    return pending * (avg + this.settings.delaySec * 1000);
  }
}
