// Settings view: storage, pacing, behaviour toggles, theme, and Flow element calibration.
import { app, persistSettings } from './app.js';
import { defaultSettings } from './store.js';
import { makeStepper } from './controls.js';
import { findFlowTab, callAgent } from './flow.js';
import { $, el, toast, log } from './utils.js';

const SELECTOR_KEYS = [
  { key: 'promptBox', label: 'Prompt box', hint: 'prompt box' },
  { key: 'submitButton', label: 'Submit / Create button', hint: 'submit (create) button' },
  { key: 'addImageButton', label: 'Add image button', hint: 'add-image (+) button' },
  { key: 'settingsButton', label: 'Generation settings button', hint: 'settings (tune) button' },
  { key: 'startFrameSlot', label: 'Start frame slot (video)', hint: 'start-frame upload slot' },
  { key: 'endFrameSlot', label: 'End frame slot (video)', hint: 'end-frame upload slot' },
];

const steppers = {};

export function applyTheme() {
  document.documentElement.dataset.theme = app.settings.theme;
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === app.settings.theme));
}

async function flowTabOrToast() {
  const tab = await findFlowTab({ open: false });
  if (!tab) toast('Open a Google Flow project tab first');
  return tab;
}

function renderSelectorRows() {
  $('selectorRows').replaceChildren(
    ...SELECTOR_KEYS.map(({ key, label, hint }) => {
      const input = el('input', { class: 'input', placeholder: 'auto-detect', value: app.settings.selectors[key] || '', spellcheck: 'false' });
      input.addEventListener('change', () => {
        app.settings.selectors[key] = input.value.trim();
        persistSettings();
      });
      const pick = async () => {
        const tab = await flowTabOrToast();
        if (!tab) return;
        await chrome.tabs.update(tab.id, { active: true });
        toast(`Click the ${hint} on the Flow page (Esc cancels)`, 4000);
        try {
          const r = await callAgent(tab.id, 'pickElement', { label: hint }, { timeoutMs: 300000 });
          if (!r) return;
          input.value = r.selector;
          app.settings.selectors[key] = r.selector;
          persistSettings();
          toast(`Saved ${label}`);
        } catch (e) {
          toast(e.message, 4000);
        }
      };
      const test = async () => {
        const tab = await flowTabOrToast();
        if (!tab) return;
        await chrome.tabs.update(tab.id, { active: true });
        try {
          if (input.value.trim()) {
            const r = await callAgent(tab.id, 'testSelector', { selector: input.value.trim() });
            toast(r.found ? `Found: ${r.label || 'element'}` : 'Selector matched nothing on this page', 3500);
          } else {
            const r = await callAgent(tab.id, 'highlightAuto', { selectors: app.settings.selectors, key });
            toast(r ? `Auto-detected: ${r.label || r.tag}` : 'Nothing auto-detected — use Pick', 3500);
          }
        } catch (e) {
          toast(e.message, 4000);
        }
      };
      const clear = () => {
        input.value = '';
        app.settings.selectors[key] = '';
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
  $('setMentionMode').value = s.mentionMode;
  document.querySelectorAll('[data-setting]').forEach((i) => (i.checked = !!s[i.dataset.setting]));
  for (const [key, st] of Object.entries(steppers)) st.set(s[key]);
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
  $('setMentionMode').addEventListener('change', (e) => {
    app.settings.mentionMode = e.target.value;
    persistSettings();
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
    const tab = await flowTabOrToast();
    if (!tab) {
      out.textContent = 'No Google Flow tab found.';
      return;
    }
    out.textContent = 'Inspecting…';
    try {
      const r = await callAgent(tab.id, 'diagnose', { selectors: app.settings.selectors });
      out.textContent = JSON.stringify(r, null, 2);
      log(
        `Diagnose: prompt=${!!r.promptBox} submit=${!!r.submitButton} add=${!!r.addImageButton} settings=${!!r.settingsButton} startFrame=${!!r.startFrameSlot} endFrame=${!!r.endFrameSlot}`
      );
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

  fillForm();
}
