// Anonymous usage counts — which features are used, how often, and roughly where (see the README's
// "Usage stats and privacy"). Sent to FlowBatch's own stats endpoint (analytics/, a Cloudflare
// Worker). What is sent: a random install ID made here, the extension version, and event counts
// such as { e: 'result', d: 'gemini-video', n: 2 }. Never: prompts, file or asset names, URLs,
// error text, or anything from the pages. Cloudflare adds the country code; no IP is stored.
// Settings → "Share anonymous usage counts" turns it off and drops anything not yet sent.
import { app } from './app.js';

/** The deployed endpoint (analytics/README.md). Nothing is recorded or sent while this is empty. */
export const STATS_URL = '';

const QUEUE_KEY = 'telemetryQueue';
const ID_KEY = 'telemetryId';
const NOTICE_KEY = 'telemetryNoticeSeen';
const FLUSH_MS = 60 * 1000;
const NEW_SESSION_AFTER_MS = 30 * 60 * 1000;
const MAX_BATCH = 50;
const MAX_QUEUED = 200; // distinct event/detail pairs kept while offline

const queue = new Map(); // "event|detail" → n
let lastActivity = 0;
let saveTimer = null;
let sending = false;

export const telemetryOn = () => !!STATS_URL && app.settings?.shareUsage !== false;

const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);

function add(e, d, n) {
  const key = `${e}|${clean(d)}`;
  if (!queue.has(key) && queue.size >= MAX_QUEUED) return;
  queue.set(key, Math.min(500, (queue.get(key) || 0) + Math.max(1, Math.floor(n) || 1)));
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ [QUEUE_KEY]: [...queue] }).catch(() => {}), 500);
}

/** Count one use of a feature. `detail` is a short token (site, kind or source), never user data. */
export function track(event, detail = '', n = 1) {
  if (!telemetryOn()) return;
  const now = Date.now();
  // A panel left open for hours is several sessions: a new one starts after 30 idle minutes.
  if (event !== 'session' && lastActivity && now - lastActivity > NEW_SESSION_AFTER_MS) add('session', '', 1);
  lastActivity = now;
  add(event, detail, n);
  save();
}

async function installId() {
  const got = await chrome.storage.local.get(ID_KEY);
  if (got[ID_KEY]) return got[ID_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [ID_KEY]: id });
  return id;
}

/** Send what's queued. `keepalive` lets the last batch leave while the panel closes. */
export async function flush({ keepalive = false } = {}) {
  if (!telemetryOn() || sending || !queue.size) return;
  sending = true;
  const batch = [...queue].slice(0, MAX_BATCH);
  try {
    const res = await fetch(`${STATS_URL}/e`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive,
      body: JSON.stringify({
        uid: await installId(),
        v: chrome.runtime.getManifest().version,
        events: batch.map(([key, n]) => {
          const [e, d] = key.split('|');
          return d ? { e, d, n } : { e, n };
        }),
      }),
    });
    // Sent (or refused as malformed, which retrying won't fix): take the batch off the queue.
    if (res.ok || (res.status >= 400 && res.status < 500)) {
      batch.forEach(([key, n]) => {
        const left = (queue.get(key) || 0) - n;
        if (left > 0) queue.set(key, left);
        else queue.delete(key);
      });
      save();
    }
  } catch {
    /* offline — keep the queue for the next try */
  } finally {
    sending = false;
  }
}

/** Switched off in Settings: forget anything not yet sent. */
export function dropQueued() {
  queue.clear();
  chrome.storage.local.remove(QUEUE_KEY).catch(() => {});
}

/** The one-time notice under the header, shown once when counting is on. */
async function showNotice({ onTurnOff }) {
  const box = document.getElementById('usageNotice');
  if (!box || !telemetryOn()) return;
  const seen = (await chrome.storage.local.get(NOTICE_KEY))[NOTICE_KEY];
  if (seen) return;
  const done = () => {
    box.hidden = true;
    chrome.storage.local.set({ [NOTICE_KEY]: Date.now() }).catch(() => {});
  };
  document.getElementById('btnUsageOk').onclick = done;
  document.getElementById('btnUsageOff').onclick = () => {
    done();
    onTurnOff();
  };
  box.hidden = false;
}

/** Call once at boot, after settings are loaded. */
export async function initTelemetry({ onTurnOff }) {
  if (!STATS_URL) return;
  const stored = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY];
  if (Array.isArray(stored)) for (const [key, n] of stored) if (typeof key === 'string' && n > 0) queue.set(key, (queue.get(key) || 0) + n);
  track('session');
  showNotice({ onTurnOff });
  setTimeout(() => flush(), 5000);
  setInterval(() => flush(), FLUSH_MS);
  addEventListener('pagehide', () => flush({ keepalive: true }));
}
