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

/**
 * Save a generated result from Flow.
 * blob:/data: URLs are read through the page (they only exist there); http(s) URLs are
 * fetched with the extension's host permission so the real MIME type picks the extension.
 */
export async function downloadMedia({ url, kind, pathNoExt, readViaPage }) {
  const fallbackExt = kind === 'video' ? 'mp4' : 'png';
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const dataUrl = url.startsWith('data:') ? url : (await readViaPage(url)).dataUrl;
    return downloadBlob(await dataUrlToBlob(dataUrl), pathNoExt, fallbackExt);
  }
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.size || /text\/html/i.test(blob.type)) throw new Error('not media');
    return await downloadBlob(blob, pathNoExt, fallbackExt);
  } catch {
    return start(url, `${pathNoExt}.${extFromUrl(url, fallbackExt)}`);
  }
}
