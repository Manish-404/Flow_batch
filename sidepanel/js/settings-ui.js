// Settings view: storage, pacing, behaviour toggles, theme, and Flow / Gemini element calibration.
import { app, on, persistSettings } from './app.js';
import { defaultSettings } from './store.js';
import { makeStepper } from './controls.js';
import { SITES, findSiteTab, callAgent } from './site.js';
import { $, el, toast, log } from './utils.js';

// The page elements each site's agent looks for; any of them can be pinned to a CSS selector.
const SELECTOR_KEYS = {
  flow: [
    { key: 'promptBox', label: 'Prompt box', hint: 'prompt box' },
    { key: 'submitButton', label: 'Submit / Create button', hint: 'submit (create) button' },
    { key: 'addImageButton', label: 'Add image button', hint: 'add-image (+) button' },
    { key: 'settingsButton', label: 'Generation settings button', hint: 'settings (tune) button' },
    { key: 'startFrameSlot', label: 'Start frame slot (video)', hint: 'start-frame upload slot' },
    { key: 'endFrameSlot', label: 'End frame slot (video)', hint: 'end-frame upload slot' },
  ],
  gemini: [
    { key: 'promptBox', label: 'Prompt box', hint: 'prompt box' },
    { key: 'submitButton', label: 'Send button', hint: 'send button' },
    { key: 'addImageButton', label: 'Upload (+) button', hint: 'upload (+) button' },
    { key: 'toolsButton', label: 'Tools button', hint: 'Tools button' },
    { key: 'modelButton', label: 'Model picker', hint: 'model picker (Fast / Thinking / Pro)' },
    { key: 'newChatButton', label: 'New chat button', hint: 'New chat button' },
  ],
};

const site = () => (app.session?.site === 'gemini' ? 'gemini' : 'flow');
const siteSelectors = () => SITES[site()].selectors(app.settings);

const steppers = {};

export function applyTheme() {
  document.documentElement.dataset.theme = app.settings.theme;
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === app.settings.theme));
}

async function siteTabOrToast() {
  const tab = await findSiteTab(site(), { open: false });
  if (!tab) toast(site() === 'gemini' ? 'Open Gemini (gemini.google.com) in a tab first' : 'Open a Google Flow project tab first');
  return tab;
}

function renderSiteLabels() {
  const { name } = SITES[site()];
  $('elementsTitle').textContent = `${name} elements`;
  $('elementsHelp').innerHTML =
    site() === 'gemini'
      ? 'FlowBatch finds these automatically. If Gemini’s layout changes and a step fails, open Gemini, press <b>Pick</b> and click the element on the page.'
      : 'FlowBatch finds these automatically. If Flow’s layout changes and a step fails, open a Flow project, press <b>Pick</b> and click the element on the page.';
  $('btnDiagnose').textContent = `Diagnose current ${name} tab`;
  $('diagOutput').hidden = true;
}

function renderSelectorRows() {
  const { name } = SITES[site()];
  const selectors = siteSelectors();
  $('selectorRows').replaceChildren(
    ...SELECTOR_KEYS[site()].map(({ key, label, hint }) => {
      const input = el('input', { class: 'input', placeholder: 'auto-detect', value: selectors[key] || '', spellcheck: 'false' });
      input.addEventListener('change', () => {
        selectors[key] = input.value.trim();
        persistSettings();
      });
      const pick = async () => {
        const tab = await siteTabOrToast();
        if (!tab) return;
        await chrome.tabs.update(tab.id, { active: true });
        toast(`Click the ${hint} on the ${name} page (Esc cancels)`, 4000);
        try {
          const r = await callAgent(tab.id, 'pickElement', { label: hint }, { timeoutMs: 300000 });
          if (!r) return;
          input.value = r.selector;
          selectors[key] = r.selector;
          persistSettings();
          toast(`Saved ${label}`);
        } catch (e) {
          toast(e.message, 4000);
        }
      };
      const test = async () => {
        const tab = await siteTabOrToast();
        if (!tab) return;
        await chrome.tabs.update(tab.id, { active: true });
        try {
          if (input.value.trim()) {
            const r = await callAgent(tab.id, 'testSelector', { selector: input.value.trim() });
            toast(r.found ? `Found: ${r.label || 'element'}` : 'Selector matched nothing on this page', 3500);
          } else {
            const r = await callAgent(tab.id, 'highlightAuto', { selectors, key });
            toast(r ? `Auto-detected: ${r.label || r.tag}` : 'Nothing auto-detected — use Pick', 3500);
          }
        } catch (e) {
          toast(e.message, 4000);
        }
      };
      const clear = () => {
        input.value = '';
        selectors[key] = '';
        persistSettings();
      };
      return el(
        'div',
        { class: 'sel-row' },
        el('span', { class: 'label', text: label }),
        el(
          'div',
          { class: 'row' },
          input,
          el('button', { class: 'btn btn-ghost', text: 'Pick', onclick: pick }),
          el('button', { class: 'btn btn-ghost', text: 'Test', onclick: test }),
          el('button', { class: 'btn btn-ghost', text: '✕', title: 'Back to auto-detect', onclick: clear })
        )
      );
    })
  );
}

function fillForm() {
  const s = app.settings;
  $('setBaseFolder').value = s.baseFolder;
  $('setSeparator').value = s.separator;
  $('setFlowUrl').value = s.flowUrl;
  $('setGeminiUrl').value = s.geminiUrl;
  $('setMentionMode').value = s.mentionMode;
  $('setPlan').value = s.plan || 'auto';
  document.querySelectorAll('[data-setting]').forEach((i) => (i.checked = !!s[i.dataset.setting]));
  for (const [key, st] of Object.entries(steppers)) st.set(s[key]);
  renderSiteLabels();
  renderSelectorRows();
  applyTheme();
}

export function initSettings() {
  $('btnSettings').addEventListener('click', () => {
    $('view-main').hidden = true;
    $('view-settings').hidden = false;
    window.scrollTo(0, 0);
  });
  $('btnBack').addEventListener('click', () => {
    $('view-settings').hidden = true;
    $('view-main').hidden = false;
  });
  document.querySelectorAll('[data-theme-set]').forEach((b) =>
    b.addEventListener('click', () => {
      app.settings.theme = b.dataset.themeSet;
      applyTheme();
      persistSettings();
    })
  );

  $('setBaseFolder').addEventListener('input', (e) => {
    app.settings.baseFolder = e.target.value.trim() || 'FlowBatch';
    persistSettings();
  });
  $('setSeparator').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (!v || v.includes('@')) {
      $('autosaveState').textContent = 'Separator must be non-empty and cannot contain @';
      return;
    }
    app.settings.separator = v;
    persistSettings();
  });
  $('setFlowUrl').addEventListener('change', (e) => {
    app.settings.flowUrl = e.target.value.trim() || 'https://flow.google.com/';
    persistSettings();
  });
  $('setGeminiUrl').addEventListener('change', (e) => {
    app.settings.geminiUrl = e.target.value.trim() || 'https://gemini.google.com/app';
    persistSettings();
  });
  $('setMentionMode').addEventListener('change', (e) => {
    app.settings.mentionMode = e.target.value;
    persistSettings();
  });
  $('setPlan').addEventListener('change', (e) => {
    app.settings.plan = e.target.value;
    persistSettings();
  });
  $('btnForgetPrices').addEventListener('click', () => {
    const n = Object.keys(app.settings.learnedCredits || {}).length;
    app.settings.learnedCredits = {};
    persistSettings();
    toast(n ? `Forgot ${n} remembered price${n === 1 ? '' : 's'} — the built-in list is used until Flow shows them again` : 'No remembered prices');
  });
  document.querySelectorAll('[data-setting]').forEach((i) =>
    i.addEventListener('change', () => {
      app.settings[i.dataset.setting] = i.checked;
      persistSettings();
    })
  );
  document.querySelectorAll('.stepper').forEach((root) => {
    const key = root.dataset.key;
    steppers[key] = makeStepper(root, {
      value: app.settings[key],
      min: Number(root.dataset.min),
      max: Number(root.dataset.max),
      step: Number(root.dataset.step),
      onChange: (v) => {
        app.settings[key] = v;
        persistSettings();
      },
    });
  });

  $('btnDiagnose').addEventListener('click', async () => {
    const out = $('diagOutput');
    out.hidden = false;
    const tab = await siteTabOrToast();
    if (!tab) {
      out.textContent = `No ${SITES[site()].fullName} tab found.`;
      return;
    }
    out.textContent = 'Inspecting…';
    try {
      const r = await callAgent(tab.id, 'diagnose', { selectors: siteSelectors() });
      out.textContent = JSON.stringify(r, null, 2);
      const found = SELECTOR_KEYS[site()].map(({ key }) => `${key}=${!!r[key]}`).join(' ');
      log(`Diagnose ${SITES[site()].name}: ${found}${site() === 'gemini' ? ` replies=${r.responses} media=${r.mediaInLastReply}` : ''}`);
    } catch (e) {
      out.textContent = `Error: ${e.message}`;
    }
  });

  $('btnReset').addEventListener('click', () => {
    if (!confirm('Reset all settings (including picked Flow elements) to defaults?')) return;
    app.settings = defaultSettings();
    fillForm();
    persistSettings();
    toast('Settings reset');
  });

  on('siteChanged', () => {
    renderSiteLabels();
    renderSelectorRows();
  });
  fillForm();
}
