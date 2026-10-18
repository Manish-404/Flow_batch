#!/usr/bin/env python3
"""motion-pack: local motion analysis and keyframe selection for FlowBatch.

  python motion_pack.py extract VIDEO OUTDIR [--max-gap 0.25] [--min-gap 0.08] [--target-motion auto]

Writes OUTDIR/frames/f_00001.png (every source frame, exact), OUTDIR/keyframes/ (the chosen
ones, named f_001, f_002 ... ready to import into FlowBatch) and OUTDIR/manifest.json.
Runs on CPU only. ffmpeg comes from the imageio-ffmpeg wheel, so nothing else to install.
"""
import argparse
import json
import subprocess
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def probe(video):
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        sys.exit(f"cannot open {video}")
    info = {
        "fps": cap.get(cv2.CAP_PROP_FPS),
        "frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
    }
    cap.release()
    return info


def dump_frames(video, frames_dir):
    frames_dir.mkdir(parents=True, exist_ok=True)
    # -vsync 0 keeps one image per source frame, no duplicates or drops
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-i", str(video), "-vsync", "0", str(frames_dir / "f_%05d.png")],
        check=True,
    )
    return sorted(frames_dir.glob("f_*.png"))


def motion_scores(paths, width=320):
    """Mean optical-flow magnitude between consecutive frames (Farneback, downscaled)."""
    scores = [0.0]
    prev = None
    for p in paths:
        img = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
        h = int(img.shape[0] * width / img.shape[1])
        small = cv2.resize(img, (width, h), interpolation=cv2.INTER_AREA)
        if prev is not None:
            flow = cv2.calcOpticalFlowFarneback(prev, small, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            scores.append(float(np.linalg.norm(flow, axis=2).mean()))
        prev = small
    return scores


def select_keyframes(scores, fps, max_gap, min_gap, target):
    """Equal-motion spacing: place a keyframe each time accumulated motion reaches `target`,
    but never closer than min_gap or farther than max_gap seconds. First and last always kept."""
    n = len(scores)
    max_f = max(1, round(max_gap * fps))
    min_f = max(1, round(min_gap * fps))
    keys = [0]
    acc = 0.0
    for i in range(1, n):
        acc += scores[i]
        since = i - keys[-1]
        if (acc >= target and since >= min_f) or since >= max_f:
            keys.append(i)
            acc = 0.0
    if keys[-1] != n - 1:
        if n - 1 - keys[-1] < min_f and len(keys) > 1:
            keys[-1] = n - 1
        else:
            keys.append(n - 1)
    return keys


def cmd_extract(a):
    video, out = Path(a.video), Path(a.outdir)
    info = probe(video)
    frames_dir = out / "frames"
    paths = dump_frames(video, frames_dir)
    scores = motion_scores(paths)
    fps = info["fps"]
    if a.target_motion == "auto":
        # aim for about one keyframe per max_gap on average motion, so busy parts get denser keys
        nominal = max(1, round(a.max_gap * fps))
        target = float(np.mean(scores[1:])) * nominal * 0.75 if len(scores) > 1 else 1.0
    else:
        target = float(a.target_motion)
    keys = select_keyframes(scores, fps, a.max_gap, a.min_gap, target)

    kdir = out / "keyframes"
    if kdir.exists():
        shutil.rmtree(kdir)
    kdir.mkdir(parents=True)
    key_entries = []
    for n, idx in enumerate(keys, 1):
        name = f"f_{n:03d}.png"
        shutil.copyfile(paths[idx], kdir / name)
        key_entries.append({"name": name, "frame": idx, "time": round(idx / fps, 4), "motion": round(scores[idx], 4)})

    segments = [
        {
            "from": key_entries[i]["name"],
            "to": key_entries[i + 1]["name"],
            "start": key_entries[i]["time"],
            "end": key_entries[i + 1]["time"],
            "duration": round(key_entries[i + 1]["time"] - key_entries[i]["time"], 4),
            "motion_sum": round(sum(scores[keys[i] + 1 : keys[i + 1] + 1]), 3),
            "motion_text": "",  # fill by hand, or via `describe` with a free API key
        }
        for i in range(len(key_entries) - 1)
    ]
    manifest = {
        "source": video.name,
        **info,
        "duration": round(len(paths) / fps, 4),
        "params": {"max_gap": a.max_gap, "min_gap": a.min_gap, "target_motion": round(target, 4)},
        "keyframes": key_entries,
        "segments": segments,
        "motion": [round(s, 4) for s in scores],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"{len(paths)} frames @ {fps:.3f} fps, {len(keys)} keyframes, {len(segments)} segments -> {out}")


def clip_duration(path):
    cap = cv2.VideoCapture(str(path))
    n, fps = cap.get(cv2.CAP_PROP_FRAME_COUNT), cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    if not n or not fps:
        sys.exit(f"cannot read {path}")
    return n / fps


def run(cmd):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", *cmd], check=True)


def cmd_assemble(a):
    """One generated clip per manifest segment (overlapping pairs: clip i runs keyframe i -> i+1).
    Each clip is retimed to its segment's real duration, trimmed to a whole number of frames so the
    shared keyframe is not shown twice, joined, and given the original audio."""
    pack, out = Path(a.pack), Path(a.output)
    man = json.loads((pack / "manifest.json").read_text(encoding="utf-8"))
    clips = sorted(p for p in Path(a.clips).iterdir() if p.suffix.lower() in (".mp4", ".mov", ".m4v", ".webm"))
    segs = man["segments"]
    if len(clips) != len(segs):
        sys.exit(f"{len(clips)} clips in {a.clips} but the manifest has {len(segs)} segments (one clip per segment, in order)")
    fps = a.fps or man["fps"]
    w, h = (a.size or f"{man['width']}x{man['height']}").split("x")
    tmp = out.parent / (out.stem + "_parts")
    tmp.mkdir(parents=True, exist_ok=True)
    parts = []
    for i, (clip, seg) in enumerate(zip(clips, segs), 1):
        frames = max(1, round(seg["duration"] * fps))
        factor = seg["duration"] / clip_duration(clip)  # <1 speeds the clip up, >1 slows it down
        part = tmp / f"p_{i:04d}.mp4"
        vf = f"setpts=PTS*{factor:.6f},fps={fps},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
        run(["-i", str(clip), "-vf", vf, "-frames:v", str(frames), "-an", "-c:v", "libx264", "-crf", str(a.crf), "-pix_fmt", "yuv420p", str(part)])
        parts.append(part)
        print(f"clip {i}/{len(segs)} {clip.name}: x{factor:.3f} -> {frames} frames")
    # the last clip keeps its final frame so the video ends on the last keyframe
    lst = tmp / "list.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf-8")
    silent = tmp / "joined.mp4"
    run(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(silent)])
    src = a.audio_from or (pack / ".." / man["source"])
    t0, t1 = segs[0]["start"], segs[-1]["end"]
    if Path(src).exists():
        run(["-i", str(silent), "-ss", str(t0), "-t", str(t1 - t0), "-i", str(src), "-map", "0:v", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac", "-shortest", str(out)])
    else:
        shutil.copyfile(silent, out)
        print("original video not found for audio; wrote a silent video (use --audio-from)")
    print(f"wrote {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("assemble", help="join generated clips, retime to the source, add the original audio")
    s.add_argument("pack", help="folder with manifest.json (from extract)")
    s.add_argument("clips", help="folder of generated clips, one per segment, sorted by name")
    s.add_argument("output")
    s.add_argument("--fps", type=float, default=None, help="output fps (default: source fps)")
    s.add_argument("--size", default=None, help="WxH (default: source size)")
    s.add_argument("--crf", type=int, default=16)
    s.add_argument("--audio-from", default=None, help="video to take audio from (default: the source)")
    s.set_defaults(fn=cmd_assemble)
    e = sub.add_parser("extract", help="exact frames, motion scores, motion-based keyframes")
    e.add_argument("video")
    e.add_argument("outdir")
    e.add_argument("--max-gap", type=float, default=0.25, help="longest gap between keyframes, seconds")
    e.add_argument("--min-gap", type=float, default=0.08, help="shortest gap between keyframes, seconds")
    e.add_argument("--target-motion", default="auto", help="accumulated flow per keyframe, or 'auto'")
    e.set_defaults(fn=cmd_extract)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
