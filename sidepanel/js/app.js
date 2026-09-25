// Shared mutable app state for the side panel modules.
import { saveSession, saveSettings } from './store.js';

export const app = {
  settings: null,
  session: null,
  assets: [], // { id, name, type, blob, order, thumbUrl }
  runner: null,
  hooks: { assetsChanged: [], promptChanged: [], settingsChanged: [], videoChanged: [], siteChanged: [] },
};

export const persistSession = () => saveSession(app.session);

let settingsTimer = null;
export function persistSettings() {
  const label = document.getElementById('autosaveState');
  if (label) label.textContent = 'Saving…';
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    await saveSettings(app.settings);
    if (label) label.textContent = 'Autosaved';
    app.hooks.settingsChanged.forEach((fn) => fn());
  }, 300);
}

export const on = (name, fn) => app.hooks[name].push(fn);
export const emit = (name) => app.hooks[name].forEach((fn) => fn());
