// Cutting a video into clips in the browser. There is no ffmpeg here — Chrome plays the source
// and MediaRecorder re-records each segment — so a split runs in real time and re-encodes.
import { resolveDuration, seek } from './frames.js';

export const MAX_CLIPS = 200;

export const QUALITY = {
  high: 8_000_000,
  medium: 4_000_000,
  small: 1_500_000,
};

/** The best container Chrome can record to; MP4 needs a recent Chrome, WebM always works. */
export function pickMime(prefer) {
  const mp4 = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const order = prefer === 'mp4' ? [...mp4, ...webm] : webm;
  return order.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export function clipPlan(duration, { clipSec, start, end }) {
  const len = Math.max(0.2, Number(clipSec) || 5);
  const from = Math.min(Math.max(0, Number(start) || 0), duration);
  const to = end === '' || end == null ? duration : Math.min(Math.max(from, Number(end)), duration);
  const out = [];
  // A tail shorter than a tenth of a second is rounding noise, not a clip.
  for (let t = from; to - t > 0.1 && out.length < MAX_CLIPS; t += len) out.push({ start: t, end: Math.min(t + len, to) });
  return out;
}

function once(target, event, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    target.addEventListener(
      event,
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** Resolve once playback reaches `t`, with a wall-clock guard in case the source stalls. */
function playUntil(video, t, signal) {
  const guardMs = Math.max(0, t - video.currentTime) * 1000 + 8000;
  const deadline = Date.now() + guardMs;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (signal?.aborted || video.ended || video.currentTime >= t - 0.02 || Date.now() > deadline) {
        clearInterval(timer);
        resolve();
      }
    }, 25);
  });
}

/**
 * Route the source's audio into the recording without playing it through the speakers.
 * Muting the element instead would silence the captured track too.
 */
async function silentAudioTracks(video) {
  const ctx = new AudioContext();
  const source = ctx.createMediaElementSource(video);
  const dest = ctx.createMediaStreamDestination();
  source.connect(dest); // deliberately not connected to ctx.destination
  await ctx.resume();
  return { ctx, tracks: dest.stream.getAudioTracks() };
}

/**
 * Split `file` into clips of `clipSec` seconds. `onClip` receives each clip as it finishes, so
 * a cancelled run keeps everything recorded so far.
 */
export async function splitVideo(file, opts, { onClip, onProgress, onNote, signal }) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  let audio = null;
  let stream = null;
  try {
    await once(video, 'loadedmetadata', 20000, 'Chrome cannot decode this video (try MP4/H.264 or WebM)');
    const duration = await resolveDuration(video);
    const plan = clipPlan(duration, opts);
    if (!plan.length) throw new Error('Nothing to split — check Start and End');
    const mime = pickMime(opts.format);
    if (!mime) throw new Error('This Chrome build cannot record video');
    if (opts.format === 'mp4' && !mime.startsWith('video/mp4')) onNote?.('This Chrome cannot record MP4 — clips will be WebM');

    const videoTracks = video.captureStream().getVideoTracks();
    try {
      audio = await silentAudioTracks(video);
    } catch (e) {
      video.muted = true;
      onNote?.(`Audio could not be captured (${e.message}) — clips will be video-only`);
    }
    stream = new MediaStream([...videoTracks, ...(audio?.tracks || [])]);
    const type = mime.split(';')[0];
    const bits = QUALITY[opts.quality] || QUALITY.high;

    for (let i = 0; i < plan.length; i++) {
      if (signal?.aborted) break;
      const seg = plan[i];
      await seek(video, seg.start);
      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bits, audioBitsPerSecond: 128_000 });
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => (rec.onstop = r));
      rec.start();
      await video.play();
      await playUntil(video, seg.end, signal);
      video.pause();
      rec.stop();
      await stopped;
      if (signal?.aborted && !chunks.length) break;
      await onClip({ index: i, start: seg.start, end: Math.min(seg.end, video.currentTime), blob: new Blob(chunks, { type }) });
      onProgress?.((i + 1) / plan.length);
    }
    return { total: plan.length, mime };
  } finally {
    video.pause();
    stream?.getTracks().forEach((t) => t.stop());
    audio?.ctx.close().catch(() => {});
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
