// Removing Gemini's visible sparkle from a Veo video. The mark is the same sparkle as on images,
// fixed in place for the whole clip (48 px at a 96 px margin on a 720×1280 video). First its exact
// pattern is learned from frames sampled across the clip; then the clip plays once, each frame is
// drawn to a canvas, the mark's box is un-blended with the frozen pattern, and the canvas plus the original audio are
// re-recorded as MP4 — real time, like splitting. Only the visible mark changes; SynthID is not
// touched.
import { resolveDuration, seek } from './frames.js';
import { pickMime, silentAudioTracks } from './split.js';
import { cleanCanvasFrame } from './watermark.js';

const SAMPLES = 24; // frames spread over the clip, used to learn the pattern before recording

function once(target, event, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    target.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
  });
}

/**
 * Returns { blob, found, frames, cleaned } — the original blob when no mark is found.
 * `learned` is the shared pattern store (settings.geminiMark); it is read and updated.
 */
export async function removeMarkFromVideo(blob, learned = {}, { onProgress, signal } = {}) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  let audio = null;
  let stream = null;
  try {
    await once(video, 'loadedmetadata', 20000, 'Chrome cannot decode this video');
    const duration = await resolveDuration(video);
    const w = video.videoWidth;
    const h = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // 1. Learn the mark from frames spread over the clip (nothing is recorded yet).
    let hits = 0;
    for (let i = 0; i < SAMPLES; i++) {
      if (signal?.aborted) throw new Error('Cancelled');
      await seek(video, (duration * (i + 0.5)) / SAMPLES);
      ctx.drawImage(video, 0, 0, w, h);
      if (cleanCanvasFrame(ctx, w, h, learned).found) hits++;
      onProgress?.((0.15 * (i + 1)) / SAMPLES);
    }
    if (hits < Math.ceil(SAMPLES / 3)) return { blob, found: false }; // not a marked Gemini video

    // 2. Play once, clean every frame, record the canvas with the source's audio.
    const mime = pickMime('mp4');
    if (!mime) throw new Error('This Chrome build cannot record video');
    const track = canvas.captureStream(0).getVideoTracks()[0];
    try {
      audio = await silentAudioTracks(video);
    } catch {
      video.muted = true; // no audio track to keep
    }
    stream = new MediaStream([track, ...(audio?.tracks || [])]);
    // Keep the quality: 1.5× the source's bitrate, 3–16 Mbps.
    const srcBits = (blob.size * 8) / Math.max(0.5, duration);
    const bits = Math.round(Math.min(16e6, Math.max(3e6, srcBits * 1.5)));
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bits, audioBitsPerSecond: 160_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));

    await seek(video, 0);
    let frames = 0;
    let cleaned = 0;
    const draw = () => {
      ctx.drawImage(video, 0, 0, w, h);
      // The pattern is frozen while recording: consecutive frames show nearly the same thing under
      // the mark, so learning from them would drift towards it.
      if (cleanCanvasFrame(ctx, w, h, learned, { learn: false }).found) cleaned++;
      frames++;
      track.requestFrame?.();
      onProgress?.(0.15 + 0.85 * Math.min(1, video.currentTime / duration));
    };
    draw(); // the first frame, before playback starts
    rec.start();
    const onFrame = () => {
      if (video.ended || signal?.aborted) return;
      draw();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    const ended = once(video, 'ended', (duration + 15) * 1000, 'The video stalled while cleaning');
    await video.play();
    await Promise.race([ended, new Promise((r) => signal?.addEventListener('abort', r, { once: true }))]);
    video.pause();
    rec.stop();
    await stopped;
    if (signal?.aborted) throw new Error('Cancelled');
    return { blob: new Blob(chunks, { type: mime.split(';')[0] }), found: true, frames, cleaned };
  } finally {
    video.pause();
    stream?.getTracks().forEach((t) => t.stop());
    audio?.ctx.close().catch(() => {});
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
