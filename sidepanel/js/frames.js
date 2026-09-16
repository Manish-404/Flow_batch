// Frame extraction: sample a local video every N seconds, or screenshot the Flow tab on a timer.
import { sleep } from './utils.js';

export const MAX_FRAMES = 1000;

// Recorder-made WebM files often report duration = Infinity until the end is seeked once.
async function resolveDuration(video) {
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

function seek(video, t) {
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

// chrome.tabs.captureVisibleTab is limited to ~2 calls per second.
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
