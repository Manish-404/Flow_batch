// FlowBatch — automation agent inside the Google Flow tab (isolated world).
// The side panel drives the queue and calls these actions one step at a time.
(() => {
  if (window.__flowBatchAgentLoaded) return;
  window.__flowBatchAgentLoaded = true;
  const FB = self.FB;
  const { $$, sleep, isShown, realClick, labelOf } = FB;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  async function waitFor(fn, timeoutMs, stepMs = 300) {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(stepMs);
    }
  }

  const isProject = () => /\/project\//i.test(location.pathname);

  function describe(el) {
    if (!el) return null;
    return { tag: el.tagName.toLowerCase(), label: labelOf(el).slice(0, 80), selector: FB.uniqueSelector(el) };
  }

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
    if (settingsOpened) {
      FB.pressKey(document.activeElement || document.body, 'Escape');
      await sleep(300);
    }
    return { report };
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
      if (!input) input = FB.pickFileInput(composer, false, kind);
      if (!input) {
        const add = FB.findAddButton(selectors, box);
        if (add) {
          realClick(add);
          input = await waitFor(() => FB.pickFileInput(composer, true, kind), 1500, 150);
          if (!input) {
            const item = FB.findOverlayItem(/upload|from (your )?(computer|device)|browse|choose file|add (an )?(image|video|media)/i) ||
              FB.visibleDialogs().map((d) => FB.findButtonByText(/upload|browse|choose file|from (your )?(computer|device)/i, d)).find(Boolean);
            if (item) {
              realClick(item);
              input = await waitFor(() => FB.pickFileInput(composer, true, kind), 2000, 150);
            }
          }
        }
      }
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

  async function fetchAsDataUrl({ url }) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    return { dataUrl, mime: blob.type };
  }

  // ---------- actions ----------
  const actions = {
    ping: ({ selectors }) => ({
      url: location.href,
      title: document.title,
      isProject: isProject(),
      hasPromptBox: !!FB.findPromptBox(selectors),
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

    setPrompt: async ({ selectors, text }) => {
      const box = FB.findPromptBox(selectors);
      if (!box) throw new Error('Prompt box not found');
      const exact = await FB.setText(box, text);
      return { exact, length: FB.getText(box).length };
    },

    snapshot,
    submit,
    poll,
    fetchAsDataUrl,

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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.channel !== 'flowbatch') return undefined;
    const fn = actions[msg.action];
    if (!fn) {
      sendResponse({ ok: false, error: `Unknown action ${msg.action}` });
      return undefined;
    }
    Promise.resolve()
      .then(() => fn(msg.payload || {}))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
})();
