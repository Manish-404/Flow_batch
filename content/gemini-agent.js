// FlowBatch — automation agent inside the Gemini tab (gemini.google.com, isolated world).
// It answers the same actions as flow-agent.js, so the side panel drives both sites the same
// way. Gemini is a chat: a result is the media in its reply to the prompt that was just sent.
(() => {
  if (window.__flowBatchAgentLoaded) return;
  window.__flowBatchAgentLoaded = true;
  const FB = self.FB;
  const { $$, sleep, isShown, realClick, labelOf, waitFor, norm, describe, clickables } = FB;

  const shown = (el) => isShown(el) && !FB.isOwn(el);
  const first = (selector, root) => $$(selector, root).find(shown) || null;
  const outermost = (list) => list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
  const innermost = (list) => list.filter((el) => !list.some((o) => o !== el && el.contains(o)));

  // ---------- finders (each can be overridden in Settings → Gemini elements) ----------
  function findPromptBox(sel) {
    return (
      FB.customEl(sel?.promptBox) ||
      first('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"]') ||
      FB.findPromptBox(sel)
    );
  }

  const composerOf = (box) => (box && FB.findComposer(box)) || document.body;

  function findSendButton(sel, box) {
    return (
      FB.customEl(sel?.submitButton) ||
      first('button.send-button:not(.stop), button[aria-label="Send message" i], button[data-test-id="send-button"]') ||
      FB.findSubmitButton(sel, box)
    );
  }

  // While Gemini is answering, its send button turns into a stop button.
  function findStopButton(box) {
    return (
      first('button.send-button.stop, button[aria-label*="stop response" i], button[aria-label*="stop generating" i]') ||
      clickables(composerOf(box)).find((b) => /^stop\b/i.test(norm(b.getAttribute('aria-label')))) ||
      null
    );
  }

  function findUploadButton(sel, box) {
    return (
      FB.customEl(sel?.addImageButton) ||
      first('button[aria-label*="upload file" i], button.upload-card-button, button[aria-label*="add files" i]') ||
      FB.findAddButton(sel, box)
    );
  }

  function findToolsButton(sel, box) {
    return (
      FB.customEl(sel?.toolsButton) ||
      first('button.toolbox-drawer-button, toolbox-drawer button[aria-label*="tools" i], button[aria-label="Tools" i]') ||
      clickables(composerOf(box)).find((b) => /^tools$/i.test(norm(b.innerText)) || /^tools\b/i.test(norm(b.getAttribute('aria-label')))) ||
      null
    );
  }

  const MODEL_TEXT = /^(fast|thinking|pro|flash|gemini\b|\d(\.\d)?\s*(flash|pro)\b)/i;
  function findModelButton(sel, box) {
    return (
      FB.customEl(sel?.modelButton) ||
      first('[data-test-id="bard-mode-menu-button"], bard-mode-switcher button, button[aria-label*="mode picker" i], button[aria-label*="model picker" i]') ||
      clickables(composerOf(box)).find((b) => MODEL_TEXT.test(norm(b.innerText)) && norm(b.innerText).length < 40) ||
      null
    );
  }

  function findNewChatButton(sel) {
    const isNewChat = (el) => /^new chat$/i.test(norm(el.innerText)) || /^new chat$/i.test(norm(el.getAttribute('aria-label')));
    return (
      FB.customEl(sel?.newChatButton) ||
      first('[data-test-id="new-chat-button"] button, [data-test-id="new-chat-button"] a, button[data-test-id="new-chat-button"], a[aria-label="New chat" i], button[aria-label="New chat" i]') ||
      $$('button, a, [role="button"]', document.body).find((b) => shown(b) && isNewChat(b)) ||
      null
    );
  }

  // ---------- the conversation ----------
  const RESPONSE = 'model-response, [data-test-id="model-response"], .model-response';
  const RESPONSE_LOOSE = '[class*="model-response" i], [class*="response-container" i]';
  const QUERY = 'user-query, [data-test-id="user-query"], .user-query, [class*="user-query" i]';

  function responses() {
    let list = $$(RESPONSE).filter((el) => !FB.isOwn(el));
    if (!list.length) list = $$(RESPONSE_LOOSE).filter((el) => !FB.isOwn(el) && !el.closest(QUERY));
    return outermost(list);
  }
  const queries = () => outermost($$(QUERY).filter((el) => !FB.isOwn(el)));

  // Media in the reply: inside the new response blocks, or — if Gemini's markup isn't
  // recognised — anything new on the page after the prompt was sent. Never the prompt box,
  // the user's own message (their uploads show there, often under the same URL they had as
  // attachments), or an overlay.
  function replyMedia(baseline, fresh, box) {
    const comp = box ? composerOf(box) : null;
    const attached = new Set(baseline.attachedKeys || []);
    const all = FB.collectMedia().filter(
      (m) =>
        !attached.has(m.key) &&
        !(comp && comp !== document.body && comp.contains(m.el)) &&
        !m.el.closest(`${QUERY}, .cdk-overlay-container, [role="dialog"]`)
    );
    let list = fresh.length ? all.filter((m) => fresh.some((r) => r.contains(m.el))) : [];
    if (!list.length) {
      const base = new Set(baseline.keys || []);
      const start = fresh[0];
      list = all.filter((m) => !base.has(m.key) && (!start || start.compareDocumentPosition(m.el) & Node.DOCUMENT_POSITION_FOLLOWING));
    }
    const seen = new Set();
    return list.filter((m) => !seen.has(m.key) && seen.add(m.key));
  }

  // A finished image, or a video player — which may load nothing until it is played, so
  // having a source is enough.
  const isReady = (m) => FB.isResultMedia(m) || (m.kind === 'video' && m.dw >= 60 && !/avatar|logo|icon/i.test(m.url));

  // Spinners, skeletons and "Generating your video…" placeholders inside a reply.
  const LOADER =
    '[role="progressbar"], mat-progress-spinner, mat-spinner, mat-progress-bar, [aria-busy="true"], [class*="skeleton" i], [class*="shimmer" i], [class*="spinner" i], [class*="loading" i]';
  const WAIT_TEXT = /^(just a sec|one moment|hang tight|loading|creating your|generating your|making your|rendering your|working on (it|your))\b/i;
  function loadersIn(resp) {
    const spinners = $$(LOADER, resp).filter((el) => shown(el) && !/avatar|loaded/i.test(String(el.className?.baseVal ?? el.className)));
    return spinners.length + FB.collectText(WAIT_TEXT, 120, resp).length;
  }

  function replyText(resp) {
    if (!resp) return '';
    const md = $$('message-content, .markdown, [class*="markdown" i]', resp).find(shown) || resp;
    return norm(md.innerText).slice(0, 400);
  }

  // Replies that mean "no image is coming": refusals and usage limits.
  const REFUSAL = /^(sorry|i['’]m sorry|i can['’]t|i cannot|i['’]m (not able|unable)|i am (not able|unable)|unfortunately|i['’]m just a language model)/i;
  const LIMIT = /(reached (your|the) .{0,40}limit|(daily|usage) limit|limit (for|of) .{0,40}(today|reached)|try again (later|tomorrow)|come back (later|tomorrow)|\bquota\b)/i;

  // Gemini shows a downscaled copy; the same Google image URL with =s0 is the original.
  function fullSizeUrls(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)googleusercontent\.com$/i.test(u.hostname) || u.search) return [];
      const base = url.replace(/=[\w-]*$/, '');
      return [`${base}=s0`, `${base}=s2048`].filter((x) => x !== url);
    } catch {
      return [];
    }
  }

  function toResult(m) {
    const full = m.kind === 'image' ? fullSizeUrls(m.url) : [];
    return { url: full[0] || m.url, altUrls: [...full.slice(1), ...(full.length ? [m.url] : [])], preview: m.url, kind: m.kind, w: m.w, h: m.h };
  }

  // ---------- menus: tools and model ----------
  const closeMenus = async () => {
    if ($$('[role="menu"], [role="listbox"], .cdk-overlay-pane').some(shown)) {
      FB.pressKey(document.activeElement || document.body, 'Escape');
      await sleep(250);
    }
  };

  const menuItems = () =>
    $$('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], .cdk-overlay-container button, [role="menu"] button').filter(shown);

  function menuItem(re) {
    const items = menuItems();
    return items.find((el) => re.test(norm(el.innerText)) && norm(el.innerText).length < 80) || items.find((el) => re.test(labelOf(el))) || null;
  }

  function isChecked(el) {
    if (['aria-checked', 'aria-selected', 'aria-pressed'].some((a) => el.getAttribute(a) === 'true')) return true;
    if (/\b(selected|checked|is-active)\b/i.test(String(el.className))) return true;
    return $$('mat-icon, [class*="icon" i]', el).some((i) => /^(check|done|check_circle)$/i.test(norm(i.getAttribute('fonticon') || i.innerText)));
  }

  const TOOL = {
    image: /^(create|generate|make)\s+(an?\s+)?images?\b|^images?$|^image generation\b|nano banana|^imagen\b/i,
    video: /^(create|generate|make)\s+(an?\s+)?videos?\b|^videos?$|^video generation\b|\bveo\b/i,
  };

  // A chosen tool shows as a chip with a "Deselect …" button next to the prompt box.
  function toolIsOn(mode, box) {
    const word = mode === 'video' ? /\b(videos?|veo)\b/i : /\b(images?|imagen|banana)\b/i;
    const comp = composerOf(box);
    return (
      clickables(comp).some((b) => /\bdeselect\b/i.test(labelOf(b)) && word.test(labelOf(b))) ||
      $$('[class*="deselect" i], [data-test-id*="deselect" i]', comp).some((el) => shown(el) && word.test(labelOf(el)))
    );
  }

  async function chooseTool(mode, selectors, box) {
    const re = TOOL[mode];
    if (!re) return 'skipped';
    if (toolIsOn(mode, box)) return 'already';
    const btn = findToolsButton(selectors, box);
    if (btn) {
      realClick(btn);
      const item = await waitFor(() => menuItem(re), 2500, 150);
      if (item) {
        if (isChecked(item)) {
          await closeMenus();
          return 'already';
        }
        realClick(item);
        await sleep(700);
        await closeMenus();
        return toolIsOn(mode, box) ? 'set' : 'set (chip not seen)';
      }
      await closeMenus();
    }
    // A new chat also offers the tools as suggestion chips ("🍌 Create image").
    const chip = clickables(document.body).find((b) => {
      const t = norm(b.innerText).replace(/^\W+/, '');
      return t.length < 40 && re.test(t);
    });
    if (chip) {
      realClick(chip);
      await sleep(700);
      return toolIsOn(mode, box) ? 'set' : 'set (chip not seen)';
    }
    return btn ? 'option-not-found' : 'not-found';
  }

  async function chooseModel(targetRe, selectors, box) {
    const btn = findModelButton(selectors, box);
    if (!btn) return 'not-found';
    if (targetRe.test(norm(btn.innerText))) return 'already';
    realClick(btn);
    const item = await waitFor(() => menuItem(targetRe), 2500, 150);
    if (!item) {
      await closeMenus();
      return 'option-not-found';
    }
    if (FB.isDisabled(item)) {
      await closeMenus();
      return 'unavailable on this account';
    }
    realClick(item);
    await sleep(600);
    await closeMenus();
    return 'set';
  }

  async function applySettings({ selectors, mode, modelMatch }) {
    const box = findPromptBox(selectors);
    const report = [];
    if (mode) report.push(`tool: ${await chooseTool(mode, selectors, box)}`);
    if (modelMatch) report.push(`model: ${await chooseModel(new RegExp(modelMatch, 'i'), selectors, box)}`);
    return { report };
  }

  // ---------- attachments ----------
  // What shows an attached file next to the prompt box: a thumbnail, a file chip, a remove
  // button, or the file's name. Each is counted, and any that goes up confirms an upload.
  // Chips count innermost-only: the wrapper around them matches too, and appears with them.
  function attachedState(box) {
    const comp = composerOf(box);
    return {
      thumbs: $$('img, video', comp).filter((m) => shown(m) && m.getBoundingClientRect().width >= 24).length,
      chips: innermost($$('uploader-file-preview, [data-test-id*="file-preview" i], [class*="file-preview" i]', comp).filter(shown)).length,
      removers: clickables(comp).filter((b) => /\b(remove|delete)\b/i.test(labelOf(b)) && !/\b(deselect|tool)\b/i.test(labelOf(b))).length,
      text: norm(comp.innerText),
    };
  }

  function countAdded(before, now, files) {
    const named = files.filter((f) => now.text.includes(f.name) && !before.text.includes(f.name)).length;
    return Math.max(0, now.thumbs - before.thumbs, now.chips - before.chips, now.removers - before.removers, named);
  }

  const uploading = (box) =>
    $$('[role="progressbar"], mat-progress-spinner, mat-spinner, mat-progress-bar, [class*="uploading" i]', composerOf(box)).some(shown);

  function uploadMenuItem() {
    const items = menuItems();
    return (
      items.find((i) => /^upload (files?|images?|photos?|media)\b/i.test(norm(i.innerText)) || /upload files?/i.test(norm(i.getAttribute('aria-label')))) ||
      items.find((i) => /\bupload\b|from (your )?(computer|device)|browse/i.test(labelOf(i)) && !/\b(drive|photos|notebook|code)\b/i.test(labelOf(i))) ||
      null
    );
  }

  // Gemini opens its file picker from the + menu; page-hook.js parks that input instead of
  // showing the OS dialog. Only an input captured after our own click counts — one parked by
  // an earlier upload may no longer be wired up. Call with data-flowbatch-capture set.
  async function findUploadInput(selectors, box, kind) {
    const comp = composerOf(box);
    const t0 = Date.now();
    const captured = () => {
      const i = FB.pickFileInput(null, true, kind);
      return i && +i.getAttribute('data-flowbatch-captured') >= t0 ? i : null;
    };
    const add = findUploadButton(selectors, box);
    if (add) {
      realClick(add);
      let input = await waitFor(captured, 1000, 150);
      if (input) return input;
      const item = await waitFor(uploadMenuItem, 2000, 150);
      if (item) {
        realClick(item);
        input = await waitFor(captured, 2500, 150);
        if (input) return input;
      }
      await closeMenus();
    }
    // An input that is already on the page.
    const wants = kind === 'video' ? /video|\*|mp4|webm|mov/i : /image|\*|png|jpe?g|webp/i;
    const inputs = $$('input[type="file"]').filter((i) => !i.disabled && !i.hasAttribute('data-flowbatch-captured') && (!i.accept || wants.test(i.accept)));
    return inputs.find((i) => comp.contains(i)) || inputs[0] || null;
  }

  /**
   * Attach files to the prompt box — all at once when Gemini's input takes `multiple`,
   * otherwise one after another, pasting as a last resort — and wait until each one has
   * shown up or been rejected.
   */
  async function attachList(selectors, files, settleMs) {
    const box = findPromptBox(selectors);
    if (!box) throw new Error('Gemini prompt box not found');
    const kind = files.every((f) => /^video\//i.test(f.type)) ? 'video' : 'image';
    const before = attachedState(box);
    const since = Date.now();
    const baseline = new Set(FB.scanUploadErrors());
    const root = document.documentElement;
    root.dataset.flowbatchCapture = '1';
    let method;
    try {
      let input = await findUploadInput(selectors, box, kind);
      if (input && (input.multiple || files.length === 1)) {
        FB.setInputFiles(input, files);
        method = files.length > 1 ? 'file input, all at once' : 'file input';
      } else if (input) {
        for (const [i, f] of files.entries()) {
          if (i) {
            await sleep(1200);
            input = (await findUploadInput(selectors, box, kind)) || input;
          }
          FB.setInputFiles(input, [f]);
        }
        method = 'file input, one after another';
      } else {
        FB.pasteFiles(box, files);
        method = 'paste';
      }
    } finally {
      delete root.dataset.flowbatchCapture;
    }
    await closeMenus();

    const newErrors = () => [
      ...new Set([...FB.uploadErrors.filter((e) => e.t >= since).map((e) => e.text), ...FB.scanUploadErrors().filter((t) => !baseline.has(t))]),
    ];
    const errorFor = (errs, f) => errs.find((t) => t.toLowerCase().includes(f.name.toLowerCase())) || null;

    let added = 0;
    let errs = [];
    let dropped = method !== 'paste';
    const deadline = Date.now() + settleMs;
    for (;;) {
      await sleep(500);
      added = countAdded(before, attachedState(findPromptBox(selectors) || box), files);
      errs = newErrors();
      const rejected = files.filter((f) => errorFor(errs, f)).length;
      if (added + rejected >= files.length && !uploading(box)) break;
      if (!dropped && added === 0 && Date.now() - since > 4000) {
        FB.dropFiles(composerOf(box), files);
        method = 'drop';
        dropped = true;
      }
      if (Date.now() > deadline) break;
    }
    // One file and one unnamed error: the error is about that file.
    const lone = files.length === 1 && added === 0 && errs.length === 1 ? errs[0] : null;
    const named = new Set();
    const results = files.map((f) => {
      const error = errorFor(errs, f) || lone;
      if (error) named.add(error);
      return { name: f.name, size: f.size, error };
    });
    return {
      method,
      expected: files.length,
      added,
      files: results,
      otherErrors: errs.filter((t) => !named.has(t)),
      dialogClicks: [],
      openDialogs: FB.visibleDialogs().map((d) => norm(d.innerText).slice(0, 140)),
    };
  }

  async function attachImage({ selectors, name, dataUrl, type }) {
    const file = FB.dataUrlToFile(dataUrl, name, type);
    const r = await attachList(selectors, [file], /^video\//i.test(file.type) ? 90000 : 30000);
    return { method: r.method, confirmed: r.added >= 1, slotFound: false, error: r.files[0].error, dialogClicks: [], openDialogs: r.openDialogs };
  }

  const attachFiles = ({ selectors, keys, settleMs = 60000 }) => attachList(selectors, keys.map(FB.takeStaged), settleMs);

  async function clearReferences({ selectors }) {
    const box = findPromptBox(selectors);
    if (!box) return { removed: 0 };
    const comp = composerOf(box);
    let removed = 0;
    for (let i = 0; i < 12; i++) {
      const btn = clickables(comp).find((b) => b !== box && /\b(remove|delete|cancel upload)\b/i.test(labelOf(b)) && !/\b(deselect|tool)\b/i.test(labelOf(b)));
      if (!btn) break;
      realClick(btn);
      removed++;
      await sleep(350);
    }
    return { removed };
  }

  // ---------- chat / prompt / submit / poll ----------
  async function newChat({ selectors }) {
    if (findPromptBox(selectors) && !responses().length && !queries().length) return { method: 'already new' };
    const btn = findNewChatButton(selectors);
    if (btn) {
      realClick(btn);
      const fresh = await waitFor(() => !responses().length && !queries().length && findPromptBox(selectors), 8000, 250);
      if (fresh) return { method: 'button' };
    }
    const path = `${location.pathname.match(/^\/u\/\d+/)?.[0] || ''}/app`;
    setTimeout(() => location.assign(path), 50); // respond before the page unloads
    return { method: 'navigate', url: path };
  }

  function snapshot({ selectors }) {
    const box = findPromptBox(selectors);
    const comp = box ? composerOf(box) : null;
    const media = FB.collectMedia();
    return {
      t: Date.now(),
      responses: responses().length,
      queries: queries().length,
      keys: media.map((m) => m.key),
      attachedKeys: comp && comp !== document.body ? media.filter((m) => comp.contains(m.el)).map((m) => m.key) : [],
      promptText: norm(FB.getText(box)),
    };
  }

  async function submit({ selectors }) {
    const box = findPromptBox(selectors);
    if (!box) throw new Error('Gemini prompt box not found');
    let btn = await waitFor(() => findSendButton(selectors, box), 3000, 250);
    // Uploads keep the send button disabled until they finish.
    const t0 = Date.now();
    while (btn && FB.isDisabled(btn) && Date.now() - t0 < 90000) {
      await sleep(300);
      btn = findSendButton(selectors, box) || btn;
    }
    if (btn && !FB.isDisabled(btn)) {
      const label = labelOf(btn).slice(0, 60); // before the click turns it into "Stop response"
      realClick(btn);
      return { method: 'button', label };
    }
    box.focus();
    FB.pressKey(box, 'Enter');
    return { method: 'enter', note: btn ? 'send button stayed disabled' : 'send button not found' };
  }

  function poll({ selectors, baseline, kind }) {
    const box = findPromptBox(selectors);
    const all = responses();
    const fresh = all.length > baseline.responses ? all.slice(baseline.responses) : [];
    const media = replyMedia(baseline, fresh, box).filter((m) => !kind || m.kind === kind);
    const ready = media.filter(isReady);
    const pending = media.filter((m) => !isReady(m) && !m.loaded).length;
    const generating = !!findStopButton(box);
    const loaders = fresh.reduce((n, r) => n + loadersIn(r), 0);
    const text = replyText(fresh[fresh.length - 1]);
    const failText = fresh.flatMap((r) => FB.collectText(FB.FAIL_TEXT, 300, r))[0] || '';
    const toasts = FB.failureEvents.filter((e) => e.t >= baseline.t);
    return {
      responses: fresh.length,
      sent: fresh.length > 0 || queries().length > baseline.queries || generating,
      newMedia: ready.map(toResult),
      pendingMedia: pending,
      generating,
      loaders,
      done: fresh.length > 0 && !generating && loaders === 0 && pending === 0,
      replyText: text,
      refused: !!text && (REFUSAL.test(text) || LIMIT.test(text)),
      failText: toasts[toasts.length - 1]?.text || failText,
      failed: !!failText || toasts.length > 0,
      promptText: norm(FB.getText(box)),
      dialogText: FB.visibleDialogs().map((d) => norm(d.innerText).slice(0, 160)).join(' | '),
    };
  }

  // ---------- actions ----------
  const finders = (selectors) => {
    const box = findPromptBox(selectors);
    return {
      promptBox: () => box,
      submitButton: () => findSendButton(selectors, box),
      addImageButton: () => findUploadButton(selectors, box),
      toolsButton: () => findToolsButton(selectors, box),
      modelButton: () => findModelButton(selectors, box),
      newChatButton: () => findNewChatButton(selectors),
    };
  };

  const actions = {
    ping: ({ selectors }) => ({
      url: location.href,
      title: document.title,
      site: 'gemini',
      hasPromptBox: !!findPromptBox(selectors),
    }),

    diagnose: ({ selectors }) => {
      const f = finders(selectors);
      const all = responses();
      const last = all[all.length - 1];
      return {
        url: location.href,
        site: 'gemini',
        ...Object.fromEntries(Object.entries(f).map(([k, fn]) => [k, describe(fn())])),
        stopButton: describe(findStopButton(f.promptBox())),
        responses: all.length,
        queries: queries().length,
        lastReply: replyText(last).slice(0, 160),
        mediaInLastReply: last ? replyMedia({ keys: [] }, [last], f.promptBox()).filter(isReady).length : 0,
        fileInputs: $$('input[type="file"]').length,
      };
    },

    waitReady: async ({ selectors, timeoutMs = 30000 }) => {
      const box = await waitFor(() => findPromptBox(selectors), timeoutMs, 400);
      if (!box) throw new Error('Gemini prompt box not found — are you signed in? (Settings → Gemini elements → Pick)');
      return { ok: true };
    },

    newChat,
    applySettings,
    clearReferences,
    attachImage,
    stageChunk: FB.stageChunk,
    attachFiles,
    dropStaged: FB.dropStaged,

    setPrompt: async ({ selectors, text }) => {
      const box = findPromptBox(selectors);
      if (!box) throw new Error('Gemini prompt box not found');
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
      const f = finders(selectors);
      const el = (f[key] || f.promptBox)();
      if (el) FB.flash(el);
      return describe(el);
    },
  };

  FB.serve(actions);
})();
