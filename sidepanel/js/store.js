// Persistent settings / session state (chrome.storage.local) and image assets (IndexedDB).

export const DEFAULT_SETTINGS = {
  baseFolder: 'FlowBatch',
  separator: '###',
  flowUrl: 'https://flow.google.com/',
  delaySec: 7,
  timeoutSec: 300,
  retries: 1,
  pollSec: 2,
  autoDownload: true,
  applyFlowSettings: true,
  clearReferences: true,
  autoNewProject: true,
  stopOnFailure: true,
  mentionMode: 'remove',
  plan: 'auto', // Flow subscription for credit estimates: auto (read from Flow) | free | standard | plus | pro | ultra
  learnedCredits: {}, // prices read from Flow itself; they win over CREDIT_TABLE
  theme: 'dark',
  selectors: { promptBox: '', submitButton: '', addImageButton: '', settingsButton: '', startFrameSlot: '', endFrameSlot: '' },
  geminiUrl: 'https://gemini.google.com/app',
  geminiNewChat: true,
  geminiRemoveMark: true, // strip the visible Gemini sparkle from downloaded images
  geminiMark: {}, // the sparkle's pattern, learned from your images (see watermark.js)
  geminiSelectors: { promptBox: '', submitButton: '', addImageButton: '', toolsButton: '', modelButton: '', newChatButton: '' },
};

export const DEFAULT_SESSION = {
  site: 'flow',
  projectName: '',
  promptText: '',
  mode: 'image',
  aspect: '16:9',
  model: 'nano-banana-pro',
  count: 1,
  seqFrames: false,
  gemini: { model: 'keep', aspect: 'keep' },
  queue: [],
  split: { clipSec: 5, start: 0, end: '', prefix: 'clip_', format: 'mp4', quality: 'high', toDownloads: false, v: 2 },
  publish: {
    source: 'results',
    platforms: { ig: true, fb: true, yt: false },
    template: '{summary}\n\n{tags}',
    hashtags: '#anime #animeart #aiart #madewithai',
    startAt: '',
    everyHours: 9,
    edits: {},
  },
  frames: { source: 'video', interval: 1, start: 0, end: '', count: 10, prefix: 'f_', startNum: 1, format: 'png', toAssets: true, toDownloads: false, videoUrl: '', cropToVideo: true },
};

export const MODELS = {
  image: [
    { id: 'keep', label: "Flow's current", sub: "Don't change", icon: '–', match: null },
    { id: 'nano-banana-pro', label: 'Nano Banana Pro', sub: 'Best quality', icon: 'B', match: 'banana\\s*pro' },
    { id: 'nano-banana-2', label: 'Nano Banana 2', sub: 'Fast', icon: 'B', match: 'banana\\s*2(?!\\s*lite)' },
    { id: 'nano-banana-2-lite', label: 'Nano Banana 2 Lite', sub: 'Fastest', icon: 'B', match: 'banana\\s*2\\s*lite' },
    { id: 'imagen-4', label: 'Imagen 4', sub: 'Photoreal', icon: 'I', match: 'imagen\\s*4' },
  ],
  video: [
    { id: 'keep', label: "Flow's current", sub: "Don't change", icon: '–', match: null },
    { id: 'veo-fast', label: 'Veo 3.1 Fast', sub: 'Faster, fewer credits', icon: 'V', match: 'veo.*fast' },
    { id: 'veo-lite', label: 'Veo 3.1 Lite', sub: 'Fewest credits', icon: 'V', match: 'veo.*lite' },
    { id: 'veo-quality', label: 'Veo 3.1 Quality', sub: 'Highest quality', icon: 'V', match: 'veo.*quality' },
    { id: 'omni-flash', label: 'Omni 1.1 Flash', sub: 'Gemini Omni', icon: 'O', match: 'omni' },
  ],
};

export const ASPECTS = {
  image: [
    { id: 'keep', label: "Flow's current", sub: "Don't change", icon: '–' },
    { id: '16:9', label: '16:9', sub: 'Landscape', icon: 'land' },
    { id: '9:16', label: '9:16', sub: 'Portrait', icon: 'port' },
    { id: '1:1', label: '1:1', sub: 'Square', icon: 'sq' },
    { id: '4:3', label: '4:3', sub: 'Landscape', icon: 'land' },
    { id: '3:4', label: '3:4', sub: 'Portrait', icon: 'port' },
  ],
  video: [
    { id: 'keep', label: "Flow's current", sub: "Don't change", icon: '–' },
    { id: '16:9', label: '16:9', sub: 'Landscape', icon: 'land' },
    { id: '9:16', label: '9:16', sub: 'Portrait', icon: 'port' },
  ],
};

// Gemini's model picker in the prompt box — one setting for images and videos (Veo makes the
// videos whichever is picked). `match` is tested against its menu items.
const GEMINI_MODEL_LIST = [
  { id: 'keep', label: 'Unchanged', sub: "Gemini's current", icon: '–', match: null },
  { id: 'fast', label: 'Fast', sub: 'Quickest', icon: 'G', match: '^fast\\b|flash' },
  { id: 'thinking', label: 'Thinking', sub: 'Images: Nano Banana Pro', icon: 'G', match: '^thinking\\b' },
  { id: 'pro', label: 'Pro', sub: 'Most capable', icon: 'G', match: '^(\\d(\\.\\d)?\\s*)?pro\\b' },
];
export const GEMINI_MODELS = { image: GEMINI_MODEL_LIST, video: GEMINI_MODEL_LIST };

// Gemini has no aspect-ratio control, so a chosen ratio is added to the prompt as text.
const ADDED = 'Added to the prompt';
export const GEMINI_ASPECTS = {
  image: [
    { id: 'keep', label: 'Not set', sub: 'Gemini decides', icon: '–' },
    { id: '16:9', label: '16:9', sub: ADDED, icon: 'land' },
    { id: '9:16', label: '9:16', sub: ADDED, icon: 'port' },
    { id: '1:1', label: '1:1', sub: ADDED, icon: 'sq' },
    { id: '4:3', label: '4:3', sub: ADDED, icon: 'land' },
    { id: '3:4', label: '3:4', sub: ADDED, icon: 'port' },
  ],
  video: [
    { id: 'keep', label: 'Not set', sub: 'Gemini decides', icon: '–' },
    { id: '16:9', label: '16:9', sub: ADDED, icon: 'land' },
    { id: '9:16', label: '9:16', sub: ADDED, icon: 'port' },
  ],
};

// Flow credits per generated video (one output), from Google's price list as of Sep 2026.
// `ultra`: the Google AI Ultra price; `base`: every other plan. An object when the price depends on
// the length (seconds). Prices Flow shows itself ("Generating will use N credits") are learned
// into settings.learnedCredits and win over this table, so a price change is picked up on its own.
export const CREDIT_TABLE = {
  asOf: 'Sep 2026',
  'veo-lite': { base: 10, ultra: 5 },
  'veo-fast': { base: 20, ultra: 10 },
  'veo-quality': { base: 100, ultra: 100 },
  'omni-flash': { base: { 4: 15, 6: 20, 8: 25, 10: 30 } },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...clone(DEFAULT_SETTINGS), ...(settings || {}) };
  merged.selectors = { ...DEFAULT_SETTINGS.selectors, ...(settings?.selectors || {}) };
  merged.geminiSelectors = { ...DEFAULT_SETTINGS.geminiSelectors, ...(settings?.geminiSelectors || {}) };
  merged.learnedCredits = { ...(settings?.learnedCredits || {}) };
  merged.geminiMark = { ...(settings?.geminiMark || {}) };
  return merged;
}
export const saveSettings = (settings) => chrome.storage.local.set({ settings });
export const defaultSettings = () => clone(DEFAULT_SETTINGS);

export async function loadSession() {
  const { session } = await chrome.storage.local.get('session');
  const merged = { ...clone(DEFAULT_SESSION), ...(session || {}) };
  merged.frames = { ...DEFAULT_SESSION.frames, ...(session?.frames || {}) };
  merged.split = { ...DEFAULT_SESSION.split, ...(session?.split || {}) };
  // Clips used to default to WebM, which Flow rejects. Move sessions saved before v2 to MP4 once;
  // a WebM choice made after that sticks.
  if (session?.split && !session.split.v) merged.split = { ...merged.split, format: 'mp4', v: 2 };
  merged.gemini = { ...DEFAULT_SESSION.gemini, ...(session?.gemini || {}) };
  merged.publish = { ...DEFAULT_SESSION.publish, ...(session?.publish || {}) };
  merged.publish.platforms = { ...DEFAULT_SESSION.publish.platforms, ...(session?.publish?.platforms || {}) };
  // A queue item left "running" by a closed panel is pending again.
  merged.queue = (merged.queue || []).map((q) => (q.status === 'running' ? { ...q, status: 'pending' } : q));
  return merged;
}
let saveTimer = null;
export function saveSession(session) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ session }), 250);
}

// ---------------- IndexedDB assets ----------------
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('flowbatch', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('assets', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// If IndexedDB is unavailable (corrupt profile, blocked storage) keep assets in memory
// for this panel session instead of failing to start.
const memory = new Map();
const memoryStore = {
  getAll: () => ({ result: [...memory.values()] }),
  put: (a) => ({ result: memory.set(a.id, a) && a.id }),
  delete: (id) => ({ result: memory.delete(id) }),
  clear: () => ({ result: memory.clear() }),
};
export let assetsPersistent = true;

async function tx(mode, fn) {
  let d;
  try {
    d = await db();
  } catch (e) {
    if (assetsPersistent) console.warn('[FlowBatch] IndexedDB unavailable, assets kept in memory:', e);
    assetsPersistent = false;
    return fn(memoryStore).result;
  }
  return new Promise((resolve, reject) => {
    const t = d.transaction('assets', mode);
    const store = t.objectStore('assets');
    const out = fn(store);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export async function listAssets() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => a.order - b.order);
}
export const putAsset = (asset) => tx('readwrite', (s) => s.put(asset));
export const deleteAsset = (id) => tx('readwrite', (s) => s.delete(id));
export const clearAssets = () => tx('readwrite', (s) => s.clear());
