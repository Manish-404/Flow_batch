// Frame extraction: sample a local video every N seconds, or screenshot the Flow tab on a timer.
import { sleep } from './utils.js';

export const MAX_FRAMES = 1000;

// Recorder-made WebM files often report duration = Infinity until the end is seeked once.
export async function resolveDuration(video) {
  if (Number.isFinite(video.duration)) return video.duration;
  await new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('durationchange', check);
      resolve();
    };
    const check = () => Number.isFinite(video.duration) && done();
    video.addEventListener('durationchange', check);
    setTimeout(done, 8000);
    video.currentTime = 1e7;
  });
  video.currentTime = 0;
  return Number.isFinite(video.duration) ? video.duration : 0;
}

export function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = async () => {
      const duration = await resolveDuration(v);
      resolve({ duration, width: v.videoWidth, height: v.videoHeight });
      URL.revokeObjectURL(url);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Chrome cannot decode this video (try MP4/H.264 or WebM)'));
    };
    v.src = url;
  });
}

export function frameTimes(duration, { interval, start, end }) {
  const step = Math.max(0.04, Number(interval) || 1);
  const s = Math.min(Math.max(0, Number(start) || 0), duration);
  const e = end === '' || end == null ? duration : Math.min(Number(end), duration);
  const last = Math.max(0, duration - 0.04);
  const times = [];
  for (let i = 0; times.length < MAX_FRAMES; i++) {
    const t = s + i * step;
    if (t > e + 1e-6) break;
    times.push(Math.min(t, last));
  }
  return times;
}

export function seek(video, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    setTimeout(finish, 6000);
    video.currentTime = t;
  });
}

const toBlob = (canvas, mime) => new Promise((r) => canvas.toBlob(r, mime, 0.95));

export async function extractVideoFrames(file, opts, { onFrame, onProgress, signal }) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Chrome cannot decode this video (try MP4/H.264 or WebM)'));
      video.src = url;
    });
    const times = frameTimes(await resolveDuration(video), opts);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    const mime = opts.format === 'jpg' ? 'image/jpeg' : 'image/png';
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) break;
      await seek(video, times[i]);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await toBlob(canvas, mime);
      await onFrame({ index: i, time: times[i], blob });
      onProgress?.((i + 1) / times.length);
    }
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Load a direct link to a video file (your own CDN, Drive, S3, …) as if it had been
 * picked from disk. A page URL comes back as text/html and is rejected — this reads
 * media files, it does not scrape pages or streams.
 */
export async function fetchVideoFile(url) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error('Enter an http(s) link to a video file');
  let res;
  try {
    res = await fetch(clean, { credentials: 'omit' });
  } catch (e) {
    throw new Error(`Could not fetch that URL (${e.message}). It may block cross-origin requests.`);
  }
  if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  const looksLikeFile = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(clean);
  if (!/^video\//i.test(mime) && !looksLikeFile) {
    throw new Error(`That link returned ${mime || 'no media type'} — paste a direct link to a video file, not a page`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('That link returned an empty file');
  const name = decodeURIComponent(clean.split(/[?#]/)[0].split('/').pop() || '') || 'video.mp4';
  return new File([blob], name, { type: /^video\//i.test(blob.type) ? blob.type : 'video/mp4' });
}

/** Where the biggest <video> on a tab sits, so the capture can be cropped to it. */
async function probeTabVideo(tabId) {
  try {
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const shown = [...document.querySelectorAll('video')].filter((v) => {
          const r = v.getBoundingClientRect();
          return r.width > 40 && r.height > 40;
        });
        if (!shown.length) return null;
        const area = (v) => {
          const r = v.getBoundingClientRect();
          return r.width * r.height;
        };
        const v = shown.sort((a, b) => area(b) - area(a))[0];
        v.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 250));
        const r = v.getBoundingClientRect();
        return {
          x: r.left, y: r.top, w: r.width, h: r.height,
          viewW: innerWidth, viewH: innerHeight,
          vw: v.videoWidth, vh: v.videoHeight,
          paused: v.paused, duration: v.duration,
        };
      },
    });
    return hit?.result || null;
  } catch {
    return null; // restricted page, or no host access
  }
}

function waitForVideoReady(video, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The tab stream never produced a frame')), timeoutMs);
    const done = () => {
      if (!video.videoWidth) return;
      clearTimeout(t);
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('playing', done);
      resolve();
    };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('playing', done);
  });
}

/**
 * Grab frames from a live tab-capture stream at the chosen interval. This records what the
 * browser is already rendering (like a screen recorder) — the tab plays in real time while
 * it runs, so N frames at S seconds apart takes N x S seconds.
 */
export async function captureTabStream({ tabId, interval, count, format, cropToVideo }, { onFrame, onProgress, onStream, onNote, signal }) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  const stop = () => {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  try {
    await video.play();
    await waitForVideoReady(video);
    onStream?.(stream);

    let crop = { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
    if (cropToVideo) {
      const info = await probeTabVideo(tabId);
      if (info && info.viewW && info.viewH) {
        const sx = video.videoWidth / info.viewW;
        const sy = video.videoHeight / info.viewH;
        const x = Math.max(0, Math.round(info.x * sx));
        const y = Math.max(0, Math.round(info.y * sy));
        const w = Math.min(video.videoWidth - x, Math.round(info.w * sx));
        const h = Math.min(video.videoHeight - y, Math.round(info.h * sy));
        if (w > 20 && h > 20) {
          crop = { x, y, w, h };
          if (info.paused) onNote?.('The video on that tab is paused — press play so the frames differ');
        } else onNote?.('Video element found but off-screen — capturing the whole tab');
      } else onNote?.('No <video> found on that tab — capturing the whole tab');
    }

    const canvas = document.createElement('canvas');
    canvas.width = crop.w;
    canvas.height = crop.h;
    const ctx = canvas.getContext('2d');
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const stepMs = Math.max(50, (Number(interval) || 1) * 1000);
    const total = Math.min(MAX_FRAMES, Math.max(1, Number(count) || 1));

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) break;
      const t0 = Date.now();
      ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      const blob = await toBlob(canvas, mime);
      await onFrame({ index: i, time: (i * stepMs) / 1000, blob });
      onProgress?.((i + 1) / total);
      if (i < total - 1) {
        const until = t0 + stepMs;
        while (Date.now() < until && !signal?.aborted) await sleep(Math.min(120, until - Date.now()));
      }
    }
  } finally {
    stop();
  }
}

// Fallback: chrome.tabs.captureVisibleTab is limited to ~2 calls per second.
export async function captureTabFrames({ windowId, interval, count, format }, { onFrame, onProgress, signal }) {
  const stepMs = Math.max(500, (Number(interval) || 1) * 1000);
  const total = Math.min(MAX_FRAMES, Math.max(1, Number(count) || 1));
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) break;
    const t0 = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, format === 'jpg' ? { format: 'jpeg', quality: 95 } : { format: 'png' });
    const blob = await (await fetch(dataUrl)).blob();
    await onFrame({ index: i, time: (i * stepMs) / 1000, blob });
    onProgress?.((i + 1) / total);
    if (i < total - 1) {
      const until = t0 + stepMs;
      while (Date.now() < until && !signal?.aborted) await sleep(Math.min(200, until - Date.now()));
    }
  }
}
