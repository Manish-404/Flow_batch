// FlowBatch — DOM helpers and element finders for the Google Flow page (isolated world).
// Flow's markup changes often, so every finder is heuristic, and each can be overridden
// with a CSS selector picked in Settings -> Flow elements.
(() => {
  if (self.FB) return;
  const FB = (self.FB = {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  FB.sleep = sleep;

  const OWN = '[id^="__flowbatch"]';

  // ---------- querying (incl. open shadow roots) ----------
  let shadowCache = { at: 0, roots: [] };
  function shadowRoots() {
    const now = Date.now();
    if (now - shadowCache.at < 4000) return shadowCache.roots;
    const roots = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    shadowCache = { at: now, roots };
    return roots;
  }

  function $$(selector, root) {
    try {
      if (root) return [...root.querySelectorAll(selector)];
      const out = [...document.querySelectorAll(selector)];
      for (const r of shadowRoots()) out.push(...r.querySelectorAll(selector));
      return out;
    } catch {
      return [];
    }
  }
  FB.$$ = $$;

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.02;
  }
  FB.isShown = isShown;

  const isOwn = (el) => !!el.closest?.(OWN);
  const isDisabled = (el) => !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
  FB.isDisabled = isDisabled;

  function labelOf(el) {
    if (!el) return '';
    const parts = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-tooltip'),
      el.getAttribute('mattooltip'),
      el.getAttribute('placeholder'),
    ];
    const describedBy = el.getAttribute('aria-describedby');
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) parts.push(document.getElementById(id)?.textContent);
    }
    parts.push((el.innerText || el.textContent || '').slice(0, 200));
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  FB.labelOf = labelOf;

  function customEl(selector) {
    if (!selector) return null;
    return $$(selector).find((el) => isShown(el)) || null;
  }
  FB.customEl = customEl;

  // ---------- interaction ----------
  function realClick(el) {
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
      view: window,
    };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', ptr));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...ptr, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
  }
  FB.realClick = realClick;

  function pressKey(el, key, extra = {}) {
    const code = key === 'Enter' ? 'Enter' : key === 'Escape' ? 'Escape' : key;
    const keyCode = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0;
    const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, ...extra };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  FB.pressKey = pressKey;

  function getText(el) {
    if (!el) return '';
    if ('value' in el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return el.value;
    return el.innerText || el.textContent || '';
  }
  FB.getText = getText;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  async function setText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.select?.();
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text);
      } catch {
        ok = false;
      }
      if (!ok || el.value !== text) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable editors (Lexical / ProseMirror / Slate)
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text);
      } catch {
        ok = false;
      }
      if (!ok || norm(getText(el)) !== norm(text)) {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await sleep(150);
        if (norm(getText(el)) !== norm(text)) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
      }
    }
    await sleep(200);
    return norm(getText(el)) === norm(text);
  }
  FB.setText = setText;

  // ---------- finders ----------
  function findPromptBox(sel) {
    const custom = customEl(sel?.promptBox);
    if (custom) return custom;
    const legacy = document.getElementById('PINHOLE_TEXT_AREA_ELEMENT_ID');
    if (legacy && isShown(legacy)) return legacy;

    const cands = $$('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]').filter(
      (el) => isShown(el) && !isOwn(el) && !el.disabled && !el.readOnly
    );
    let best = null;
    let bestScore = -Infinity;
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const hint = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-placeholder')]
        .filter(Boolean)
        .join(' ');
      let s = 0;
      if (el.tagName === 'TEXTAREA') s += 3;
      if (el.isContentEditable) s += 2;
      if (/prompt|describe|create|imagine|what.*(want|make|create|see)|generate|type|ask|idea/i.test(hint)) s += 4;
      if (/search|rename|title|name|comment/i.test(hint)) s -= 6;
      s += Math.min(r.width, 1200) / 300;
      if (r.top > innerHeight * 0.35) s += 1.5;
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    return best;
  }
  FB.findPromptBox = findPromptBox;

  // The block around the prompt box that holds its toolbar (add / settings / submit buttons).
  function findComposer(box) {
    if (!box) return null;
    let el = box;
    let composer = box.parentElement || box;
    const maxH = Math.max(340, innerHeight * 0.6);
    for (let i = 0; i < 9 && el.parentElement && el.parentElement !== document.body; i++) {
      el = el.parentElement;
      const r = el.getBoundingClientRect();
      const n = el.querySelectorAll('button, [role="button"]').length;
      if (r.height > maxH || n > 40) break;
      if (n >= 1) composer = el;
    }
    return composer;
  }
  FB.findComposer = findComposer;

  const clickables = (root) =>
    $$('button, [role="button"], a[role="menuitem"], [role="menuitem"]', root).filter((b) => isShown(b) && !isOwn(b));

  function findSubmitButton(sel, box) {
    const custom = customEl(sel?.submitButton);
    if (custom) return custom;
    const composer = findComposer(box) || document.body;
    const br = box?.getBoundingClientRect();
    let best = null;
    let bestScore = -Infinity;
    for (const b of clickables(composer)) {
      if (b === box || b.contains(box)) continue;
      const aria = norm(b.getAttribute('aria-label') || b.getAttribute('title'));
      const inner = norm(b.innerText);
      const label = labelOf(b);
      let s = 0;
      if (/^(arrow_forward|arrow_upward|send|north|arrow_right_alt)$/i.test(inner)) s += 6;
      if (/^(create|generate|send|submit|send prompt|run|go)$/i.test(aria) || /^(create|generate|send|submit)$/i.test(inner)) s += 6;
      else if (/\b(arrow_forward|arrow_upward|send|submit|generate|create)\b/i.test(label)) s += 2.5;
      if (/\b(add|add_2|attach|upload|tune|settings|close|cancel|delete|remove|mic|more_vert|more_horiz|expand|crop|edit|download|help|menu|agent)\b/i.test(label) && s < 6) s -= 4;
      if (b.type === 'submit') s += 2;
      if (br) {
        const r = b.getBoundingClientRect();
        if (r.right >= br.right - 90) s += 1.5;
        if (r.left > br.left + br.width * 0.55) s += 1;
      }
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    return bestScore >= 3 ? best : null;
  }
  FB.findSubmitButton = findSubmitButton;

  function findAddButton(sel, box) {
    const custom = customEl(sel?.addImageButton);
    if (custom) return custom;
    const composer = findComposer(box) || document.body;
    let best = null;
    let bestScore = 0;
    for (const b of clickables(composer)) {
      const inner = norm(b.innerText);
      const label = labelOf(b);
      let s = 0;
      if (/^(add|add_2|add_circle|add_photo_alternate|image|attach_file|upload|\+)$/i.test(inner)) s += 5;
      if (/\b(add (image|media|reference|ingredient|asset|file)s?|upload|attach|ingredient|reference image)\b/i.test(label)) s += 5;
      else if (/\badd\b/i.test(label)) s += 2;
      if (/\b(project|scene|clip|send|submit|arrow_forward)\b/i.test(label)) s -= 5;
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    return bestScore >= 2 ? best : null;
  }
  FB.findAddButton = findAddButton;

  // "Frames to video" shows two upload targets — a start frame and an end frame. Prefer a
  // control whose own label names the slot; otherwise find the label text and take the
  // nearest clickable (or file input) in its block.
  function findFrameSlot(which, sel, box) {
    const custom = customEl(which === 'start' ? sel?.startFrameSlot : sel?.endFrameSlot);
    if (custom) return custom;
    const want = which === 'start' ? /\b(start|first|beginning)\b/i : /\b(end|last|final)\b/i;
    const avoid = which === 'start' ? /\b(end|last|final)\b/i : /\b(start|first|beginning)\b/i;
    const scope = findComposer(box) || document.body;

    const direct = clickables(scope).find((b) => {
      const l = labelOf(b);
      return l.length < 80 && want.test(l) && !avoid.test(l) && /\b(frame|image|upload|add|drop|photo)\b/i.test(l);
    });
    if (direct) return direct;

    const labels = $$('span, div, p, label, h3, h4', scope).filter((el) => {
      if (!isShown(el) || isOwn(el) || el.childElementCount > 3) return false;
      const t = norm(el.innerText);
      return t.length > 0 && t.length < 40 && want.test(t) && !avoid.test(t);
    });
    for (const lab of labels) {
      let block = lab;
      for (let i = 0; i < 4 && block.parentElement && block.parentElement !== document.body; i++) {
        block = block.parentElement;
        if (avoid.test(norm(block.innerText))) break; // grew into the other slot
        const input = $$('input[type="file"]', block).find((f) => !f.disabled);
        if (input) return input;
        const btn = clickables(block).find((b) => !avoid.test(labelOf(b)));
        if (btn) return btn;
      }
    }
    return null;
  }
  FB.findFrameSlot = findFrameSlot;

  function findSettingsButton(sel, box) {
    const custom = customEl(sel?.settingsButton);
    if (custom) return custom;
    const composer = findComposer(box) || document.body;
    return (
      clickables(composer).find((b) => /^(tune|settings|sliders|page_info)$/i.test(norm(b.innerText))) ||
      clickables(composer).find((b) => /\b(settings|options|tune|configure)\b/i.test(labelOf(b))) ||
      null
    );
  }
  FB.findSettingsButton = findSettingsButton;

  // Menu items / options inside overlays (Material cdk-overlay, Radix portals, listboxes).
  function findOverlayItem(re, { exclude } = {}) {
    const items = $$(
      '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="radio"], mat-option, .mat-mdc-option, [role="listbox"] li, [role="menu"] button, .cdk-overlay-container button'
    ).filter((el) => isShown(el) && !isOwn(el) && el !== exclude);
    const exact = items.find((el) => re.test(norm(el.innerText)) && norm(el.innerText).length < 60);
    return exact || items.find((el) => re.test(labelOf(el))) || null;
  }
  FB.findOverlayItem = findOverlayItem;

  function findButtonByText(re, root) {
    return clickables(root).find((b) => re.test(norm(b.innerText)) || re.test(norm(b.getAttribute('aria-label')))) || null;
  }
  FB.findButtonByText = findButtonByText;

  function visibleDialogs() {
    return $$('[role="dialog"], [role="alertdialog"], mat-dialog-container, dialog[open]').filter((d) => isShown(d) && !isOwn(d));
  }
  FB.visibleDialogs = visibleDialogs;

  // ---------- file inputs ----------
  function pickFileInput(composer, preferCaptured, kind = 'image') {
    const inputs = $$('input[type="file"]').filter((i) => !i.disabled);
    if (!inputs.length) return null;
    const captured = inputs
      .filter((i) => i.hasAttribute('data-flowbatch-captured'))
      .sort((a, b) => +b.getAttribute('data-flowbatch-captured') - +a.getAttribute('data-flowbatch-captured'));
    if (preferCaptured && captured[0]) return captured[0];
    const wants = kind === 'video' ? /video|\*|mp4|webm|mov/i : /image|\*|png|jpe?g|webp/i;
    const accepts = (i) => !i.accept || wants.test(i.accept);
    const inComposer = composer ? inputs.filter((i) => composer.contains(i) && accepts(i)) : [];
    return captured[0] || inComposer[0] || inputs.find(accepts) || null;
  }
  FB.pickFileInput = pickFileInput;

  function setInputFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  FB.setInputFiles = setInputFiles;

  function pasteFiles(target, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    target.focus?.();
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  FB.pasteFiles = pasteFiles;

  function dropFiles(target, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    const r = target.getBoundingClientRect();
    const init = { dataTransfer: dt, bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, init));
  }
  FB.dropFiles = dropFiles;

  function dataUrlToFile(dataUrl, name, type) {
    const [head, b64] = dataUrl.split(',');
    const mime = type || head.match(/data:([^;]+)/)?.[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const filename = /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.${ext}`;
    return new File([bytes], filename, { type: mime });
  }
  FB.dataUrlToFile = dataUrlToFile;

  // ---------- media / progress / failure detection ----------
  const VOLATILE_PARAMS = /^(x-goog-.*|expires|signature|googleaccessid|key-pair-id|policy|sig|se|st|sp|sv|token|authuser)$/i;

  function mediaKey(url) {
    if (!url) return '';
    if (url.startsWith('data:')) return `data:${url.length}:${url.slice(-48)}`;
    if (url.startsWith('blob:')) return url;
    try {
      const u = new URL(url, location.href);
      for (const k of [...u.searchParams.keys()]) if (VOLATILE_PARAMS.test(k)) u.searchParams.delete(k);
      let path = u.pathname;
      if (/googleusercontent\.com$/.test(u.hostname)) path = path.replace(/=[a-z0-9-]+$/i, '');
      return `${u.origin}${path}?${u.searchParams.toString()}`;
    } catch {
      return url;
    }
  }

  function collectMedia() {
    const items = [];
    let order = 0;
    for (const el of $$('img, video')) {
      if (isOwn(el)) continue;
      const isImg = el.tagName === 'IMG';
      const url = isImg ? el.currentSrc || el.src : el.currentSrc || el.src || el.querySelector('source')?.src;
      if (!url || url.startsWith('chrome-extension:')) continue;
      const r = el.getBoundingClientRect();
      items.push({
        key: mediaKey(url),
        url,
        kind: isImg ? 'image' : 'video',
        loaded: isImg ? el.complete && el.naturalWidth > 0 : el.readyState >= 1 || !!el.poster,
        w: isImg ? el.naturalWidth : el.videoWidth,
        h: isImg ? el.naturalHeight : el.videoHeight,
        dw: r.width,
        dh: r.height,
        order: order++,
      });
    }
    return items;
  }
  FB.collectMedia = collectMedia;

  FB.isResultMedia = (m) => {
    if (!m.loaded) return false;
    if (/\/a\/|avatar|profile|logo|favicon|icon|\.svg(\?|$)/i.test(m.url)) return false;
    if (m.dw < 60 && m.dh < 60) return false;
    if (m.kind === 'image') return Math.max(m.w, m.h) >= 200;
    return true;
  };

  function scanText(re, maxLen) {
    let count = 0;
    let sample = '';
    if (!document.body) return { count, sample };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node.nodeValue.trim();
      if (!t || t.length > maxLen || !re.test(t)) continue;
      const p = node.parentElement;
      if (!p || p.closest('textarea, [contenteditable="true"], script, style, noscript, ' + OWN) || !isShown(p)) continue;
      count++;
      if (!sample) sample = t;
    }
    return { count, sample };
  }

  const BUSY_TEXT = /^(\d{1,3}\s?%|generating\b.*|creating\b.*|in queue\b.*|queued\b.*|processing\b.*|rendering\b.*|uploading\b.*)$/i;
  const FAIL_TEXT =
    /(generation failed|failed to (generate|create|upload)|couldn['’]t (generate|create|upload)|could not (generate|create|upload)|something went wrong|unable to (generate|create)|not able to generate|violat(es|ed|ion)|against our (policies|guidelines)|content polic|try again later|rate limit|quota|limit reached|too many requests|an error occurred|^failed$|^error$)/i;
  FB.FAIL_TEXT = FAIL_TEXT;

  FB.countBusy = () => {
    let n = $$('[role="progressbar"], progress, [aria-busy="true"], mat-spinner, mat-progress-spinner').filter(
      (el) => isShown(el) && !isOwn(el)
    ).length;
    n += scanText(BUSY_TEXT, 60).count;
    return n;
  };

  FB.scanFailures = () => scanText(FAIL_TEXT, 220);

  // Toasts can vanish between polls, so record them as they appear.
  FB.failureEvents = [];
  const LIVE = '[role="alert"], [role="status"], [role="alertdialog"], [aria-live], [class*="toast" i], [class*="snackbar" i]';
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        const el = node.nodeType === 1 ? node : node.parentElement;
        if (!el || isOwn(el) || !el.closest(LIVE)) continue;
        const t = norm(node.textContent);
        if (t && t.length < 300 && FAIL_TEXT.test(t)) {
          FB.failureEvents.push({ t: Date.now(), text: t });
          if (FB.failureEvents.length > 50) FB.failureEvents.shift();
        }
      }
    }
  });
  const startObserver = () => observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) startObserver();

  // ---------- selector generation (element picker) ----------
  function cssEscape(s) {
    return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function uniqueSelector(el) {
    const unique = (s) => {
      try {
        return document.querySelectorAll(s).length === 1;
      } catch {
        return false;
      }
    };
    if (el.id && !/\d{3,}|^[a-f0-9-]{16,}$|:/.test(el.id) && unique(`#${cssEscape(el.id)}`)) return `#${cssEscape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    for (const attr of ['data-testid', 'data-test-id', 'aria-label', 'placeholder', 'name', 'title']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 80) {
        const s = `${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`;
        if (unique(s)) return s;
      }
    }
    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && !/\d{3,}|:/.test(cur.id)) {
        path.unshift(`#${cssEscape(cur.id)}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      path.unshift(part);
      const s = path.join(' > ');
      if (unique(s)) return s;
      cur = parent;
    }
    return path.join(' > ');
  }
  FB.uniqueSelector = uniqueSelector;

  function flash(el, color = '#6366f1') {
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.id = '__flowbatch_flash';
    Object.assign(box.style, {
      position: 'fixed',
      left: `${r.left - 4}px`,
      top: `${r.top - 4}px`,
      width: `${r.width + 8}px`,
      height: `${r.height + 8}px`,
      border: `3px solid ${color}`,
      borderRadius: '10px',
      boxShadow: `0 0 0 9999px rgba(0,0,0,.25)`,
      zIndex: 2147483647,
      pointerEvents: 'none',
      transition: 'opacity .4s',
    });
    document.documentElement.appendChild(box);
    setTimeout(() => (box.style.opacity = '0'), 1400);
    setTimeout(() => box.remove(), 1900);
  }
  FB.flash = flash;

  FB.pickElement = (label) =>
    new Promise((resolve) => {
      const hl = document.createElement('div');
      hl.id = '__flowbatch_pick_hl';
      Object.assign(hl.style, {
        position: 'fixed',
        border: '2px solid #6366f1',
        background: 'rgba(99,102,241,.15)',
        borderRadius: '6px',
        zIndex: 2147483646,
        pointerEvents: 'none',
      });
      const tip = document.createElement('div');
      tip.id = '__flowbatch_pick_tip';
      tip.textContent = `FlowBatch: click the ${label}  ·  Esc to cancel`;
      Object.assign(tip.style, {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#111827',
        color: '#fff',
        font: '600 13px system-ui, sans-serif',
        padding: '8px 14px',
        borderRadius: '999px',
        zIndex: 2147483647,
        boxShadow: '0 6px 20px rgba(0,0,0,.35)',
        pointerEvents: 'none',
      });
      document.documentElement.append(hl, tip);
      let current = null;
      const move = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || isOwn(el)) return;
        current = el.closest('button, [role="button"], textarea, [contenteditable="true"], [role="textbox"], input') || el;
        const r = current.getBoundingClientRect();
        Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      };
      const stop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };
      const finish = (value) => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('pointerdown', stop, true);
        document.removeEventListener('mousedown', stop, true);
        document.removeEventListener('keydown', key, true);
        hl.remove();
        tip.remove();
        resolve(value);
      };
      const click = (e) => {
        stop(e);
        if (!current) return;
        const selector = uniqueSelector(current);
        flash(current, '#22c55e');
        finish({ selector, label: labelOf(current).slice(0, 80) });
      };
      const key = (e) => {
        if (e.key === 'Escape') {
          stop(e);
          finish(null);
        }
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('pointerdown', stop, true);
      document.addEventListener('mousedown', stop, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
    });
})();
