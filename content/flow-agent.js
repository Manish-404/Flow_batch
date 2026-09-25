// FlowBatch — automation agent inside the Google Flow tab (isolated world).
// The side panel drives the queue and calls these actions one step at a time.
(() => {
  if (window.__flowBatchAgentLoaded) return;
  window.__flowBatchAgentLoaded = true;
  const FB = self.FB;
  const { $$, sleep, isShown, realClick, labelOf, waitFor, norm, describe } = FB;

  const isProject = () => /\/project\//i.test(location.pathname);

  // ---------- settings (mode / aspect ratio / model / outputs) ----------
  function findControlByLabel(labelRe) {
    // Most specific label first: leaf elements whose own text is the label.
    const labels = $$('label, span, div, p, mat-label, h3, h4')
      .filter((el) => {
        if (!isShown(el) || el.closest('button, [role="combobox"], [role="option"]')) return false;
        const t = norm(el.innerText);
        return t.length > 0 && t.length < 40 && labelRe.test(t);
      })
      .sort((a, b) => a.childElementCount - b.childElementCount || norm(a.innerText).length - norm(b.innerText).length);
    const CTL = 'select, [role="combobox"], mat-select, [aria-haspopup], button';
    for (const lab of labels) {
      const forId = lab.getAttribute('for');
      if (forId && document.getElementById(forId)) return document.getElementById(forId);
      let scope = lab;
      for (let i = 0; i < 3 && scope.parentElement; i++) {
        scope = scope.parentElement;
        const ctls = $$(CTL, scope).filter((c) => isShown(c) && c !== lab && !c.contains(lab) && !lab.contains(c));
        const after = ctls.find((c) => lab.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (after || ctls[0]) return after || ctls[0];
      }
    }
    return null;
  }

  async function chooseSetting({ labelRe, valueRe, targetRe }) {
    // Tabs / toggle groups showing the option directly.
    const direct = $$('[role="tab"], [role="radio"], mat-button-toggle, [aria-pressed]').find(
      (el) => isShown(el) && targetRe.test(norm(el.innerText)) && norm(el.innerText).length < 40
    );
    if (direct) {
      const selected = direct.getAttribute('aria-selected') === 'true' || direct.getAttribute('aria-checked') === 'true' || direct.getAttribute('aria-pressed') === 'true';
      if (!selected) {
        realClick(direct);
        await sleep(400);
      }
      return selected ? 'already' : 'set';
    }

    const controls = $$('select, [role="combobox"], mat-select, [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], button').filter(
      (c) => isShown(c) && !c.closest('[id^="__flowbatch"]')
    );
    const control =
      controls.find((c) => labelRe.test(norm(c.getAttribute('aria-label')))) ||
      findControlByLabel(labelRe) ||
      (valueRe && controls.find((c) => norm(c.innerText).length < 40 && valueRe.test(norm(c.innerText))));
    if (!control) return 'not-found';

    if (control.tagName === 'SELECT') {
      const opt = [...control.options].find((o) => targetRe.test(o.text));
      if (!opt) return 'option-not-found';
      if (control.value === opt.value) return 'already';
      control.value = opt.value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return 'set';
    }
    if (targetRe.test(norm(control.innerText))) return 'already';

    realClick(control);
    const item = await waitFor(() => FB.findOverlayItem(targetRe, { exclude: control }), 2500, 200);
    if (!item) {
      FB.pressKey(document.activeElement || document.body, 'Escape');
      await sleep(300);
      return 'option-not-found';
    }
    realClick(item);
    await sleep(500);
    return 'set';
  }

  const RATIO = {
    '16:9': /16\s*:\s*9|^landscape/i,
    '9:16': /9\s*:\s*16|^portrait/i,
    '1:1': /1\s*:\s*1|^square/i,
    '4:3': /4\s*:\s*3/i,
    '3:4': /3\s*:\s*4/i,
  };

  async function applySettings({ selectors, mode, videoMode, aspect, model, modelMatch, count, hasReferences }) {
    const box = FB.findPromptBox(selectors);
    const report = [];
    const specs = [];
    if (mode) {
      const target =
        mode === 'image'
          ? /create image|^images?$|^image generation$/i
          : videoMode === 'frames'
            ? /frames to video/i
            : videoMode === 'ingredients'
              ? /ingredients to video/i
              : hasReferences
                ? /ingredients to video|frames to video|^videos?$/i
                : /text to video|^videos?$/i;
      specs.push({ name: 'mode', labelRe: /\bmode\b|generation type|^type$/i, valueRe: /(text|frames|ingredients) to video|create image|^images?$|^videos?$/i, targetRe: target });
    }
    if (aspect && RATIO[aspect]) {
      specs.push({ name: 'aspect ratio', labelRe: /aspect\s*ratio|^ratio$|^size$/i, valueRe: /^(\d+\s*:\s*\d+|landscape|portrait|square)\b/i, targetRe: RATIO[aspect] });
    }
    if (model && modelMatch) {
      specs.push({ name: 'model', labelRe: /^model$/i, valueRe: /banana|imagen|veo|gemini/i, targetRe: new RegExp(modelMatch, 'i') });
    }
    if (count) {
      specs.push({ name: 'outputs', labelRe: /outputs? per prompt|number of (outputs|images|videos)|^outputs?$|^count$|variations/i, valueRe: /^x\s?[1-4]$/i, targetRe: new RegExp(`^(x\\s?)?${count}(\\s*(outputs?|images?|videos?))?$`, 'i') });
    }

    let settingsOpened = false;
    for (const spec of specs) {
      let status = await chooseSetting(spec);
      if (status === 'not-found' && !settingsOpened) {
        const btn = FB.findSettingsButton(selectors, box);
        if (btn) {
          realClick(btn);
          settingsOpened = true;
          await sleep(700);
          status = await chooseSetting(spec);
        }
      }
      report.push(`${spec.name}: ${status}`);
    }
    // While the settings are open, Flow shows what a generation costs.
    const priced = { credits: readCredits(), model: readModelLabel(), ...readSummary(box), plan: detectPlan() };
    if (settingsOpened) {
      FB.pressKey(document.activeElement || document.body, 'Escape');
      await sleep(300);
    }
    return { report, priced };
  }

  // ---------- references ----------
  // A reference shows up as an <img> thumbnail, or a <video> for an uploaded clip.
  function composerThumbCount(composer) {
    const scope = composer || document.body;
    return $$('img, video', scope).filter((i) => isShown(i) && !i.closest('[id^="__flowbatch"]')).length;
  }

  async function clearReferences({ selectors }) {
    const box = FB.findPromptBox(selectors);
    const composer = FB.findComposer(box);
    if (!composer) return { removed: 0 };
    const nearImg = (b) => {
      let el = b;
      for (let i = 0; i < 3 && el; i++) {
        el = el.parentElement;
        if (el?.querySelector('img')) return true;
      }
      return false;
    };
    let removed = 0;
    for (let i = 0; i < 15; i++) {
      const btn = $$('button, [role="button"]', composer).find(
        (b) => isShown(b) && /\b(close|cancel|clear|remove|delete)\b/i.test(labelOf(b)) && nearImg(b)
      );
      if (!btn) break;
      realClick(btn);
      removed++;
      await sleep(450);
    }
    return { removed };
  }

  async function confirmUploadDialogs() {
    const confirmRe = /^(crop (and|&) save|save|done|add|insert|use( image)?|select|confirm|continue|ok|apply|upload)$/i;
    const clicked = [];
    for (let i = 0; i < 3; i++) {
      const dialog = FB.visibleDialogs()[0];
      if (!dialog) break;
      const btn = $$('button, [role="button"]', dialog).find((b) => isShown(b) && !FB.isDisabled(b) && confirmRe.test(norm(b.innerText)));
      if (!btn) break;
      clicked.push(norm(btn.innerText));
      realClick(btn);
      await sleep(900);
    }
    return clicked;
  }

  // "Frames to video" has a start-frame and an end-frame drop target; open the one asked for.
  async function openFrameSlot(which, selectors, box, composer) {
    const target = FB.findFrameSlot(which, selectors, box);
    if (!target) return null;
    if (target.tagName === 'INPUT') return target;
    realClick(target);
    let input = await waitFor(() => FB.pickFileInput(composer, true), 1800, 150);
    if (!input) {
      const item = FB.findOverlayItem(/upload|from (your )?(computer|device)|browse|choose file|add (an )?image/i);
      if (item) {
        realClick(item);
        input = await waitFor(() => FB.pickFileInput(composer, true), 2000, 150);
      }
    }
    return input;
  }

  /**
   * Flow's file input for this kind of media: one already on the page, or the one its add
   * button opens (page-hook.js parks it instead of showing the OS picker). Call with
   * data-flowbatch-capture set.
   */
  async function findUploadInput(selectors, box, composer, kind) {
    let input = FB.pickFileInput(composer, false, kind);
    if (input) return input;
    const add = FB.findAddButton(selectors, box);
    if (!add) return null;
    realClick(add);
    input = await waitFor(() => FB.pickFileInput(composer, true, kind), 1500, 150);
    if (input) return input;
    const item =
      FB.findOverlayItem(/upload|from (your )?(computer|device)|browse|choose file|add (an )?(image|video|media)/i) ||
      FB.visibleDialogs()
        .map((d) => FB.findButtonByText(/upload|browse|choose file|from (your )?(computer|device)/i, d))
        .find(Boolean);
    if (!item) return null;
    realClick(item);
    return waitFor(() => FB.pickFileInput(composer, true, kind), 2000, 150);
  }

  // Named for its first job; it attaches any media file, and a video/* file looks for an
  // input that accepts video.
  async function attachImage({ selectors, name, dataUrl, type, slot }) {
    const file = FB.dataUrlToFile(dataUrl, name, type);
    const kind = /^video\//i.test(file.type) ? 'video' : 'image';
    const box = FB.findPromptBox(selectors);
    if (!box) throw new Error('Prompt box not found on the Flow page');
    const composer = FB.findComposer(box);
    const before = composerThumbCount(composer);
    const root = document.documentElement;
    root.dataset.flowbatchCapture = '1';
    let method = null;
    let slotFound = false;
    try {
      let input = slot ? await openFrameSlot(slot, selectors, box, composer) : null;
      slotFound = !!input;
      if (!input) input = await findUploadInput(selectors, box, composer, kind);
      if (input) {
        FB.setInputFiles(input, [file]);
        method = 'file-input';
      } else {
        FB.pasteFiles(box, [file]);
        method = 'paste';
      }
    } finally {
      delete root.dataset.flowbatchCapture;
    }

    await sleep(1200);
    const dialogClicks = await confirmUploadDialogs();

    let confirmed = await waitFor(
      () => composerThumbCount(FB.findComposer(FB.findPromptBox(selectors))) > before,
      method === 'paste' ? 5000 : 30000,
      400
    );
    if (!confirmed && method === 'paste') {
      FB.dropFiles(composer || box, [file]);
      method = 'drop';
      await sleep(1000);
      await confirmUploadDialogs();
      confirmed = await waitFor(() => composerThumbCount(FB.findComposer(FB.findPromptBox(selectors))) > before, 20000, 400);
    }
    // Let upload spinners settle.
    await waitFor(() => {
      const c = FB.findComposer(FB.findPromptBox(selectors));
      return c && !$$('[role="progressbar"], mat-spinner, mat-progress-spinner', c).some(isShown);
    }, 30000, 500);
    if ($$('[role="menu"], [role="listbox"]').some(isShown)) FB.pressKey(document.body, 'Escape');
    const dialogs = FB.visibleDialogs().map((d) => norm(d.innerText).slice(0, 140));
    return { method, confirmed: !!confirmed, slotFound, dialogClicks, openDialogs: dialogs };
  }

  // ---------- files Flow already has ----------
  // Where a file picker shows up: dialogs, menus, listboxes and popover layers.
  const PICKER =
    '[role="dialog"], [role="menu"], [role="listbox"], mat-dialog-container, dialog[open], .cdk-overlay-pane, [popover], [class*="popover" i], [class*="picker" i], [class*="drawer" i]';
  const PICKER_ITEM = 'img, video, [role="option"], [role="gridcell"], [role="menuitem"], [role="listitem"], li, figure, button, [role="button"], [title], [aria-label]';
  const CLICKABLE = 'button, [role="button"], [role="option"], [role="gridcell"], [role="menuitem"], li, figure, [tabindex]';

  const openPickers = () => $$(PICKER).filter((p) => isShown(p) && !FB.isOwn(p));

  /** The item in a newly opened picker named like one of `names` (label, alt text, title or caption). */
  function findPickerItem(names, known, composer) {
    const re = new RegExp(`(^|[^A-Za-z0-9_-])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_-])`, 'i');
    const hits = [];
    for (const p of openPickers()) {
      if (known.has(p) || (composer && p.contains(composer))) continue;
      for (const el of $$(PICKER_ITEM, p)) {
        if (isShown(el) && re.test(`${el.getAttribute('alt') || ''} ${labelOf(el)}`)) hits.push(el);
      }
    }
    // The smallest match is the item itself, not the grid around it.
    const item = hits.find((el) => !hits.some((o) => o !== el && el.contains(o)));
    return item ? item.closest(CLICKABLE) || item : null;
  }

  async function closePickers() {
    for (let i = 0; i < 2 && (FB.visibleDialogs().length || $$('[role="menu"], [role="listbox"], .cdk-overlay-pane').some(isShown)); i++) {
      FB.pressKey(document.activeElement || document.body, 'Escape');
      await sleep(300);
    }
  }

  /**
   * Add a file Flow already has — uploaded earlier — from the picker its add button (or a frame
   * slot) opens, found by name, instead of uploading it again. Nothing is uploaded here: when no
   * item matches, the picker is closed and `found: false` comes back.
   */
  async function attachExisting({ selectors, names, slot }) {
    const box = FB.findPromptBox(selectors);
    if (!box) throw new Error('Prompt box not found on the Flow page');
    const composer = FB.findComposer(box);
    const before = composerThumbCount(composer);
    const slotTarget = slot ? FB.findFrameSlot(slot, selectors, box) : null;
    const opener = (slotTarget && slotTarget.tagName !== 'INPUT' ? slotTarget : null) || FB.findAddButton(selectors, box);
    if (!opener) return { found: false, slotFound: false };
    const known = new Set(openPickers()); // pickers open before our click are not the file picker
    const find = () => findPickerItem(names, known, composer);
    const root = document.documentElement;
    root.dataset.flowbatchCapture = '1'; // a file dialog the click opens is parked, not shown
    let item = null;
    try {
      realClick(opener);
      item = await waitFor(find, 2500, 200);
      if (!item) {
        // Some pickers list past files under a tab or menu entry.
        const tab = FB.findOverlayItem(/^(library|uploads?|your (uploads|files|media)|recent|assets|media|my (files|media|uploads))\b/i);
        if (tab) {
          realClick(tab);
          item = await waitFor(find, 2500, 200);
        }
      }
      if (!item) {
        const search = openPickers()
          .filter((p) => !known.has(p))
          .flatMap((p) => $$('input[type="search"], input[placeholder*="search" i], input[aria-label*="search" i]', p))
          .find(isShown);
        if (search) {
          await FB.setText(search, names[0]);
          item = await waitFor(find, 3000, 250);
        }
      }
      if (item) realClick(item);
    } finally {
      delete root.dataset.flowbatchCapture;
    }
    if (!item) {
      await closePickers();
      return { found: false, slotFound: !!slotTarget };
    }
    const label = norm(`${item.getAttribute('alt') || ''} ${labelOf(item)}`).slice(0, 80);
    await sleep(900);
    const dialogClicks = await confirmUploadDialogs();
    const confirmed = await waitFor(() => composerThumbCount(FB.findComposer(FB.findPromptBox(selectors))) > before, 15000, 400);
    if ($$('[role="menu"], [role="listbox"]').some(isShown)) FB.pressKey(document.body, 'Escape');
    return { found: true, confirmed: !!confirmed, slotFound: !!slotTarget, label, dialogClicks, openDialogs: FB.visibleDialogs().map((d) => norm(d.innerText).slice(0, 140)) };
  }

  // ---------- batch uploads ----------
  /**
   * Hand every staged file (FB.stageChunk) to Flow in one go — all at once when its input
   * takes `multiple`, otherwise back to back — then watch the page until each one has either
   * shown up or been rejected by name (e.g. "Unsupported file type: clip_004.webm").
   */
  async function attachFiles({ selectors, keys, settleMs = 60000 }) {
    const files = keys.map(FB.takeStaged);
    const box = FB.findPromptBox(selectors);
    if (!box) throw new Error('Prompt box not found on the Flow page');
    const composer = FB.findComposer(box);
    const kind = files.every((f) => /^video\//i.test(f.type)) ? 'video' : 'image';
    const before = composerThumbCount(composer);
    const since = Date.now();
    // Text already on the page (help copy listing file types, old toasts) is not a new error.
    const baseline = new Set(FB.scanUploadErrors());
    const root = document.documentElement;
    root.dataset.flowbatchCapture = '1';
    let method;
    try {
      let input = await findUploadInput(selectors, box, composer, kind);
      if (input && (input.multiple || files.length === 1)) {
        FB.setInputFiles(input, files);
        method = files.length > 1 ? 'file input, all at once' : 'file input';
      } else if (input) {
        for (const [i, f] of files.entries()) {
          if (i) {
            await sleep(1200);
            input = (await findUploadInput(selectors, box, composer, kind)) || input;
          }
          FB.setInputFiles(input, [f]);
        }
        method = 'file input, one after another (Flow takes one file per pick)';
      } else {
        FB.pasteFiles(box, files);
        method = 'paste';
      }
    } finally {
      delete root.dataset.flowbatchCapture;
    }

    await sleep(1200);
    const dialogClicks = await confirmUploadDialogs();

    const newErrors = () => [
      ...new Set([
        ...FB.uploadErrors.filter((e) => e.t >= since).map((e) => e.text),
        ...FB.scanUploadErrors().filter((t) => !baseline.has(t)),
      ]),
    ];
    const errorFor = (errs, f) => errs.find((t) => t.toLowerCase().includes(f.name.toLowerCase())) || null;

    let added = 0;
    let errs = [];
    const deadline = Date.now() + settleMs;
    for (;;) {
      await sleep(600);
      const c = FB.findComposer(FB.findPromptBox(selectors));
      added = Math.max(0, composerThumbCount(c) - before);
      errs = newErrors();
      const rejected = files.filter((f) => errorFor(errs, f)).length;
      const busy = !!c && $$('[role="progressbar"], mat-spinner, mat-progress-spinner', c).some(isShown);
      if (added + rejected >= files.length && !busy) break;
      if (Date.now() > deadline) break;
    }
    if ($$('[role="menu"], [role="listbox"]').some(isShown)) FB.pressKey(document.body, 'Escape');

    const named = new Set();
    const results = files.map((f) => {
      const error = errorFor(errs, f);
      if (error) named.add(error);
      return { name: f.name, size: f.size, error };
    });
    return {
      method,
      expected: files.length,
      added,
      files: results,
      otherErrors: errs.filter((t) => !named.has(t)),
      dialogClicks,
      openDialogs: FB.visibleDialogs().map((d) => norm(d.innerText).slice(0, 140)),
    };
  }

  // ---------- prompt / submit / poll ----------
  function snapshot({ selectors }) {
    const box = FB.findPromptBox(selectors);
    return {
      t: Date.now(),
      keys: FB.collectMedia().map((m) => m.key),
      busy: FB.countBusy(),
      fail: FB.scanFailures().count,
      promptText: norm(FB.getText(box)),
    };
  }

  async function submit({ selectors }) {
    const box = FB.findPromptBox(selectors);
    if (!box) throw new Error('Prompt box not found');
    let btn = FB.findSubmitButton(selectors, box);
    const t0 = Date.now();
    while (btn && FB.isDisabled(btn) && Date.now() - t0 < 8000) {
      await sleep(250);
      btn = FB.findSubmitButton(selectors, box) || btn;
    }
    if (btn && !FB.isDisabled(btn)) {
      realClick(btn);
      return { method: 'button', label: labelOf(btn).slice(0, 60) };
    }
    box.focus();
    FB.pressKey(box, 'Enter');
    return { method: 'enter', note: btn ? 'submit button stayed disabled' : 'submit button not found' };
  }

  function poll({ selectors, baseline, kind }) {
    const base = new Set(baseline.keys);
    const fresh = [];
    const seen = new Set();
    for (const m of FB.collectMedia()) {
      if (base.has(m.key) || seen.has(m.key)) continue;
      if (kind && m.kind !== kind) continue;
      seen.add(m.key);
      fresh.push(m);
    }
    const ready = fresh.filter(FB.isResultMedia);
    const failures = FB.scanFailures();
    const toasts = FB.failureEvents.filter((e) => e.t >= baseline.t);
    const box = FB.findPromptBox(selectors);
    return {
      newMedia: ready.map(({ url, kind: k, w, h }) => ({ url, kind: k, w, h })),
      pendingMedia: fresh.filter((m) => !m.loaded).length,
      busyDelta: FB.countBusy() - baseline.busy,
      failDelta: failures.count - baseline.fail,
      failText: toasts[toasts.length - 1]?.text || failures.sample,
      toastFailure: toasts.length > 0,
      promptText: norm(FB.getText(box)),
      dialogText: FB.visibleDialogs().map((d) => norm(d.innerText).slice(0, 160)).join(' | '),
    };
  }

  // ---------- plan and credits ----------
  // The plan badge in Flow's header ("PRO", "ULTRA", …).
  const PLAN = /^(?:google\s+)?(?:ai\s+)?(free|standard|plus|pro|ultra)(?:\s+plan)?$/i;
  function detectPlan() {
    const badge = $$('span, div, a, button, p, b, strong').find(
      (el) => el.childElementCount === 0 && isShown(el) && !FB.isOwn(el) && el.getBoundingClientRect().top < 140 && PLAN.test(norm(el.textContent))
    );
    return badge ? norm(badge.textContent).match(PLAN)[1].toLowerCase() : null;
  }

  // "Generating will use 10 credits" — shown while the generation settings are open.
  function readCredits() {
    for (const t of FB.collectText(/\d[\d,]*\s+credits?\b/i, 160)) {
      const m = t.match(/\b(?:will use|uses?|costs?|cost of)\s+(\d[\d,]*)\s+credits?\b/i);
      if (m) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  }

  // The model picker's current value, e.g. "Omni 1.1 Flash" or "Veo 3.1 - Fast".
  function readModelLabel() {
    const t = $$('[role="combobox"], mat-select, [aria-haspopup], button, select')
      .filter((c) => isShown(c) && !FB.isOwn(c))
      .map((c) => norm(c.tagName === 'SELECT' ? c.selectedOptions[0]?.text : c.innerText))
      .find((x) => x && x.length < 40 && /\b(veo|omni|banana|imagen)\b/i.test(x));
    return t ? t.replace(/\s*(arrow_drop_down|expand_more)\s*$/i, '') : null;
  }

  // The summary chip beside the send button: "Video · 720p · 6s x1".
  function summaryChip(box) {
    return FB.clickables(FB.findComposer(box) || document.body).find((b) => /\b\d{3,4}p\b|\b\d{1,2}\s?s\b.*x\s?[1-4]/i.test(norm(b.innerText))) || null;
  }
  function readSummary(box) {
    const t = norm(summaryChip(box)?.innerText);
    return {
      mode: /\bvideo\b/i.test(t) ? 'video' : /\bimage/i.test(t) ? 'image' : null,
      res: t.match(/\b(\d{3,4}p)\b/i)?.[1] || null,
      duration: Number(t.match(/\b(\d{1,2})\s?s\b/i)?.[1]) || null,
      count: Number(t.match(/\bx\s?([1-4])\b/i)?.[1]) || null,
    };
  }

  // The credits left on the account ("12,340 AI credits", "Credits: 1.2K remaining"), ignoring
  // what a generation costs ("Generating will use 10 credits").
  const COST_WORDS = /\b(will use|uses?|costs?|per (generation|video|image|prompt)|generating)\b/i;
  const toNumber = (n, k) => Math.round(Number(n.replace(/,/g, '')) * (k ? 1000 : 1));
  function readBalance() {
    for (const t of FB.collectText(/credit/i, 120)) {
      if (COST_WORDS.test(t)) continue;
      const m =
        t.match(/(\d[\d,]*(?:\.\d+)?)\s*([kK])?\s*(?:ai\s+)?credits?\b/i) ||
        t.match(/credits?\s*(?:left|remaining|available|balance)?\s*[:\-–]?\s*(\d[\d,]*(?:\.\d+)?)\s*([kK])?\b/i);
      if (m) return toNumber(m[1], m[2]);
    }
    return null;
  }

  /**
   * Credits left. Read from the page as it is; with `open`, when that finds nothing, the plan badge,
   * a credits button or Flow's account menu is opened in turn, read and closed.
   */
  async function balance({ open = false } = {}) {
    let credits = readBalance();
    let via = credits != null ? 'page' : null;
    if (credits == null && open) {
      const header = (el) => el.getBoundingClientRect().top < 140;
      const badge = $$('span, div, button, a').find((el) => el.childElementCount === 0 && isShown(el) && header(el) && PLAN.test(norm(el.textContent)));
      const tries = [
        badge?.closest('button, [role="button"], a:not([href^="http"])') || badge,
        ...$$('button, [role="button"]').filter((b) => isShown(b) && /credit/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''} ${norm(b.innerText)}`)),
        ...$$('button, [role="button"]').filter((b) => isShown(b) && header(b) && /account|profile|avatar/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`)),
      ].filter((b, i, a) => b && !FB.isOwn(b) && a.indexOf(b) === i);
      for (const b of tries.slice(0, 3)) {
        realClick(b);
        credits = (await waitFor(() => (readBalance() != null ? { n: readBalance() } : null), 2000, 200))?.n ?? null;
        FB.pressKey(document.activeElement || document.body, 'Escape');
        await sleep(300);
        if (credits != null) {
          via = 'menu';
          break;
        }
      }
    }
    return { credits, plan: detectPlan(), via };
  }

  /**
   * Plan, model, length, resolution and Flow's own credit cost. The cost only shows while the
   * generation settings are open, so with `open` they are opened, read and closed again.
   */
  async function pricing({ selectors, open = true }) {
    const box = FB.findPromptBox(selectors);
    const read = () => ({ ...readSummary(box), credits: readCredits(), model: readModelLabel() });
    let info = read();
    let opened = false;
    if (open && (info.credits == null || !info.model)) {
      const btn = FB.findSettingsButton(selectors, box) || summaryChip(box);
      if (btn) {
        realClick(btn);
        opened = true;
        await waitFor(() => readCredits() != null, 2500, 200);
        const now = read();
        info = { ...info, ...Object.fromEntries(Object.entries(now).filter(([, v]) => v != null)) };
        FB.pressKey(document.activeElement || document.body, 'Escape');
        await sleep(300);
      }
    }
    return { ...info, plan: detectPlan(), opened };
  }

  // ---------- actions ----------
  const actions = {
    ping: ({ selectors }) => ({
      url: location.href,
      title: document.title,
      isProject: isProject(),
      hasPromptBox: !!FB.findPromptBox(selectors),
      credits: readBalance(),
      plan: detectPlan(),
    }),

    diagnose: ({ selectors }) => {
      const box = FB.findPromptBox(selectors);
      return {
        url: location.href,
        isProject: isProject(),
        promptBox: describe(box),
        submitButton: describe(FB.findSubmitButton(selectors, box)),
        addImageButton: describe(FB.findAddButton(selectors, box)),
        settingsButton: describe(FB.findSettingsButton(selectors, box)),
        startFrameSlot: describe(FB.findFrameSlot('start', selectors, box)),
        endFrameSlot: describe(FB.findFrameSlot('end', selectors, box)),
        fileInputs: $$('input[type="file"]').length,
        media: FB.collectMedia().filter(FB.isResultMedia).length,
        busy: FB.countBusy(),
      };
    },

    clickNewProject: async () => {
      const btn = await waitFor(
        () => $$('button, [role="button"], a').find((b) => isShown(b) && /new project/i.test(labelOf(b))),
        8000
      );
      if (!btn) throw new Error('"New project" button not found — open Flow home page');
      setTimeout(() => realClick(btn), 50); // respond before a possible navigation
      return { clicked: true };
    },

    waitReady: async ({ selectors, timeoutMs = 30000 }) => {
      const box = await waitFor(() => FB.findPromptBox(selectors), timeoutMs, 400);
      if (!box) throw new Error('Flow prompt box not found (use Settings → Flow elements → Pick)');
      return { ok: true };
    },

    applySettings,
    clearReferences,
    attachImage,
    attachExisting,
    pricing,
    balance,

    // Which of `names` the page shows (its project grid labels uploads by file name), ignoring
    // the prompt box, where a name may just have been typed.
    findNames: ({ selectors, names }) => {
      const box = FB.findPromptBox(selectors);
      const text = $$('img, video, [title], [aria-label], span, p, figcaption, div')
        .filter((el) => isShown(el) && !FB.isOwn(el) && !(box && (box.contains(el) || el.contains(box))) && el.childElementCount <= 3)
        .map((el) => [el.getAttribute('alt'), el.getAttribute('title'), el.getAttribute('aria-label'), el.childElementCount ? '' : el.textContent].filter(Boolean).join(' '))
        .join('\n');
      const found = names.filter((n) => new RegExp(`(^|[^A-Za-z0-9_-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i').test(text));
      return { found };
    },
    stageChunk: FB.stageChunk,
    attachFiles,
    dropStaged: FB.dropStaged,

    setPrompt: async ({ selectors, text }) => {
      const box = FB.findPromptBox(selectors);
      if (!box) throw new Error('Prompt box not found');
      const exact = await FB.setText(box, text);
      return { exact, length: FB.getText(box).length };
    },

    snapshot,
    submit,
    poll,
    fetchAsDataUrl: FB.fetchAsDataUrl,

    pickElement: async ({ label }) => FB.pickElement(label),

    testSelector: ({ selector }) => {
      const el = FB.customEl(selector);
      if (el) FB.flash(el);
      return { found: !!el, label: el ? labelOf(el).slice(0, 80) : '' };
    },

    highlightAuto: ({ selectors, key }) => {
      const box = FB.findPromptBox(selectors);
      const finders = {
        promptBox: () => box,
        submitButton: () => FB.findSubmitButton(selectors, box),
        addImageButton: () => FB.findAddButton(selectors, box),
        settingsButton: () => FB.findSettingsButton(selectors, box),
        startFrameSlot: () => FB.findFrameSlot('start', selectors, box),
        endFrameSlot: () => FB.findFrameSlot('end', selectors, box),
      };
      const el = (finders[key] || finders.settingsButton)();
      if (el) FB.flash(el);
      return describe(el);
    },
  };

  FB.serve(actions);
})();
