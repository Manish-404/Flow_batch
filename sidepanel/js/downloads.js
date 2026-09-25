// Saving files into Downloads/<base>/<project>/ and verifying each download finishes.
import { extFromMime, extFromUrl, dataUrlToBlob } from './utils.js';

const waiting = new Map(); // downloadId -> resolve(state)

chrome.downloads.onChanged.addListener((delta) => {
  const done = waiting.get(delta.id);
  if (!done || !delta.state) return;
  if (delta.state.current === 'complete') done('complete');
  else if (delta.state.current === 'interrupted') done(`interrupted${delta.error?.current ? `: ${delta.error.current}` : ''}`);
});

function track(downloadId, cleanup) {
  return new Promise((resolve) => {
    const finish = (state) => {
      waiting.delete(downloadId);
      cleanup?.();
      resolve(state);
    };
    waiting.set(downloadId, finish);
    // In case the download finished before the listener was attached.
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === 'complete') finish('complete');
      else if (item?.state === 'interrupted') finish(`interrupted: ${item.error || ''}`);
    });
  });
}

async function start(url, filename, cleanup) {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  return { id, filename, verified: track(id, cleanup) };
}

/** Save a Blob. `pathNoExt` is relative to Downloads, without extension. */
export async function downloadBlob(blob, pathNoExt, fallbackExt = 'png') {
  const objectUrl = URL.createObjectURL(blob);
  const filename = `${pathNoExt}.${extFromMime(blob.type, fallbackExt)}`;
  return start(objectUrl, filename, () => setTimeout(() => URL.revokeObjectURL(objectUrl), 5000));
}

/** Save a Blob with Chrome's Save As dialog so the user picks the folder. */
export async function downloadBlobAs(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url: objectUrl, filename, conflictAction: 'uniquify', saveAs: true });
    return { id, filename, verified: track(id, () => setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)) };
  } catch (e) {
    URL.revokeObjectURL(objectUrl);
    throw /cancel/i.test(e.message) ? new Error('Cancelled') : e;
  }
}

const isMedia = (blob) => blob.size > 0 && !/text\/html/i.test(blob.type);

/**
 * The bytes behind the first of `urls` that can be read. http(s) URLs are fetched with the
 * extension's host permission; blob: URLs only exist inside the page, so they — and, with
 * `viaPage`, any URL the extension cannot read — are fetched by the tab's agent instead.
 */
export async function fetchMediaBlob(urls, { readViaPage, viaPage = false } = {}) {
  for (const url of urls.filter(Boolean)) {
    if (url.startsWith('data:')) return dataUrlToBlob(url);
    if (!url.startsWith('blob:')) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        const blob = res.ok ? await res.blob() : null;
        if (blob && isMedia(blob)) return blob;
      } catch {
        /* try the next way */
      }
    }
    if (readViaPage && (url.startsWith('blob:') || viaPage)) {
      try {
        const blob = await dataUrlToBlob((await readViaPage(url)).dataUrl);
        if (isMedia(blob)) return blob;
      } catch {
        /* try the next URL */
      }
    }
  }
  return null;
}

/**
 * Save a generated result. `altUrls` are other copies of it (Gemini: the full-size image
 * first, then the one shown on the page); the first that can be read wins, so the real
 * MIME type picks the extension. If none can, Chrome downloads the first http(s) URL itself.
 */
export async function downloadMedia({ url, altUrls = [], kind, pathNoExt, readViaPage, viaPage = false }) {
  const fallbackExt = kind === 'video' ? 'mp4' : 'png';
  const urls = [url, ...altUrls];
  const blob = await fetchMediaBlob(urls, { readViaPage, viaPage });
  if (blob) return downloadBlob(blob, pathNoExt, fallbackExt);
  const direct = urls.find((u) => /^https?:/i.test(u || ''));
  if (!direct) throw new Error('could not read the file from the page');
  return start(direct, `${pathNoExt}.${extFromUrl(direct, fallbackExt)}`);
}
