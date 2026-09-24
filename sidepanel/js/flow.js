// Finding the Google Flow tab and talking to the content-script agent inside it.
import { sleep, blobToDataUrl } from './utils.js';

export function isFlowUrl(url) {
  return /^https:\/\/([a-z0-9-]+\.)?flow\.google\.com\//i.test(url || '') || /^https:\/\/labs\.google\/fx\//i.test(url || '');
}

let pinnedTabId = null;
export const pinTab = (id) => (pinnedTabId = id);
export const unpinTab = () => (pinnedTabId = null);

export async function findFlowTab({ open = false, flowUrl } = {}) {
  if (pinnedTabId != null) {
    try {
      const t = await chrome.tabs.get(pinnedTabId);
      if (isFlowUrl(t.url || t.pendingUrl)) return t;
    } catch {
      /* tab closed */
    }
    pinnedTabId = null;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isFlowUrl(active.url)) return active;
  const tabs = (await chrome.tabs.query({})).filter((t) => isFlowUrl(t.url));
  if (tabs.length) return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (!open) return null;
  const created = await chrome.tabs.create({ url: flowUrl || 'https://flow.google.com/', active: true });
  await waitTabComplete(created.id, 30000);
  return chrome.tabs.get(created.id);
}

export async function waitTabComplete(tabId, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return true;
    } catch {
      return false;
    }
    await sleep(400);
  }
  return false;
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page-hook.js'], world: 'MAIN' });
  } catch {
    /* ignore */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/dom.js', 'content/flow-agent.js'] });
  } catch {
    /* ignore */
  }
}

const NOT_CONNECTED = /Receiving end does not exist|Could not establish connection/i;

/**
 * Call an agent action in the Flow tab.
 * `retry` re-sends after a page reload only when the message never reached the page,
 * so non-idempotent steps (submit) are never sent twice.
 */
export async function callAgent(tabId, action, payload = {}, { timeoutMs = 120000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await Promise.race([
        chrome.tabs.sendMessage(tabId, { channel: 'flowbatch', action, payload }),
        sleep(timeoutMs).then(() => {
          throw new Error(`Flow tab did not answer "${action}" within ${Math.round(timeoutMs / 1000)}s`);
        }),
      ]);
      if (!res) throw new Error('Could not establish connection (empty response)');
      if (!res.ok) {
        const e = new Error(res.error || 'Agent error');
        e.remote = true;
        throw e;
      }
      return res.data;
    } catch (e) {
      lastErr = e;
      if (e.remote || !NOT_CONNECTED.test(e.message) || attempt === retries) throw e;
      await waitTabComplete(tabId, 15000);
      await inject(tabId);
      await sleep(700 + attempt * 600);
    }
  }
  throw lastErr;
}

// Bytes per message. As base64 that is ~8 MB, well inside the extension messaging limit.
const CHUNK_BYTES = 6 * 1024 * 1024;

/**
 * Stream files into the Flow tab in chunks, ready for the agent's `attachFiles`.
 * files: [{ blob, name, type }] — returns one key per file, in order.
 */
export async function stageFiles(tabId, files, { onProgress, signal } = {}) {
  const total = files.reduce((n, f) => n + f.blob.size, 0) || 1;
  const keys = [];
  let sent = 0;
  for (const f of files) {
    const key = crypto.randomUUID();
    keys.push(key);
    const parts = Math.max(1, Math.ceil(f.blob.size / CHUNK_BYTES));
    for (let i = 0; i < parts; i++) {
      if (signal?.aborted) {
        await callAgent(tabId, 'dropStaged', { keys }, { timeoutMs: 10000, retries: 0 }).catch(() => {});
        throw new Error('Cancelled');
      }
      const slice = f.blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      const data = (await blobToDataUrl(slice)).split(',')[1] || '';
      // Staging a chunk is idempotent, so a retry after a dropped connection is safe.
      await callAgent(tabId, 'stageChunk', { key, index: i, total: parts, data, name: f.name, type: f.type }, { timeoutMs: 60000, retries: 1 });
      sent += slice.size;
      onProgress?.(sent / total, sent, total);
    }
  }
  return keys;
}
