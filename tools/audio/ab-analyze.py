#!/usr/bin/env python3
"""A/B analysis: per-segment LUFS/TP deltas, fire-segment pump depth,
night spectrograms, and telegram-ready mp3 clips."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

AB = Path("verification/ledgers/artifacts/soundscape/ab")
SR = 44100
LABELS = tuple(__import__("os").environ.get("AB_LABELS", "baseline,remix").split(","))


def band_loudnorm(path: Path, start: float, end: float, lo: int = 5000, hi: int = 12000) -> dict:
    """LUFS of the cicada band only (5-12kHz) — the metric that matches the
    owner's ear: at night the integrated level is music-floored, but the
    complaint lives in this band."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-ss", str(start), "-to", str(end), "-i", str(path),
         "-af", f"highpass=f={lo},lowpass=f={hi},loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    blob = out[out.rfind("{", 0, out.rfind("}")):out.rfind("}") + 1]
    try:
        m = json.loads(blob)
        return {"lufs": float(m["input_i"])}
    except Exception:
        return {"lufs": float("nan")}


def loudnorm(path: Path, start: float, end: float) -> dict:
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-ss", str(start), "-to", str(end), "-i", str(path),
         "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    blob = out[out.rfind("{", 0, out.rfind("}")):out.rfind("}") + 1]
    try:
        m = json.loads(blob)
        return {"lufs": float(m["input_i"]), "tp": float(m["input_tp"]), "lra": float(m["input_lra"])}
    except Exception:
        return {"lufs": float("nan"), "tp": float("nan"), "lra": float("nan")}


def decode_mono(path: Path) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                        "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), "-"],
                       capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def db(x: float) -> float:
    return 20 * np.log10(max(x, 1e-9))


def envelope_db(x: np.ndarray, win_s: float = 0.05) -> np.ndarray:
    w = int(win_s * SR)
    n = len(x) // w
    seg = x[: n * w].reshape(n, w)
    rms = np.sqrt((seg * seg).mean(axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-9))


def pump_depth(x: np.ndarray, t0: float, t1: float) -> dict:
    """During sustained fire: level range of the inter-shot floor (25-75ms after
    each local envelope peak) — how hard the background gets yanked."""
    seg = x[int(t0 * SR):int(t1 * SR)]
    env = envelope_db(seg, 0.05)  # 50ms grid
    # gaps: envelope valleys between shots — take the 20th percentile trace over
    # 1s windows and measure its swing
    n = len(env)
    per = 20  # 1s = 20 bins
    floors = [np.percentile(env[i:i + per], 20) for i in range(0, n - per, per // 2)]
    return {
        "floor_swing_db": round(float(np.max(floors) - np.min(floors)), 2),
        "floor_p50_db": round(float(np.median(floors)), 2),
        "env_max_db": round(float(env.max()), 2),
    }


def main() -> None:
    rows = []
    xs = {}
    segmaps = {}
    for label in LABELS:
        segs = json.loads((AB / f"{label}.segments.json").read_text())
        segmaps[label] = segs
        xs[label] = decode_mono(AB / f"{label}.wav")
        for name, (a, b) in segs.items():
            m = loudnorm(AB / f"{label}.wav", a, b)
            rows.append({"capture": label, "segment": name, **m})
    # night sub-window: skip first 2s, use 30s
    for label in LABELS:
        a, b = segmaps[label]["night_ambience"]
        m = loudnorm(AB / f"{label}.wav", a + 2, a + 38)
        rows.append({"capture": label, "segment": "night_ambience_core", **m})
        band = band_loudnorm(AB / f"{label}.wav", a + 2, a + 38)
        rows.append({"capture": label, "segment": "night_CICADA_BAND_5-12k", **{"tp": None, "lra": None}, **band})
        dband = band_loudnorm(AB / f"{label}.wav", segmaps[label]["day_ambience"][0] + 1, segmaps[label]["day_ambience"][1] - 1)
        rows.append({"capture": label, "segment": "day_band_5-12k_control", **{"tp": None, "lra": None}, **dband})
        fa, fb = segmaps[label]["night_fire"]
        pd = pump_depth(xs[label], fa + 1, fb - 3)
        rows.append({"capture": label, "segment": "night_fire_pump", **{"lufs": None, "tp": None, "lra": None}, **pd})

    table = {}
    for r in rows:
        table.setdefault(r["segment"], {})[r["capture"]] = r
    labelA, labelB = LABELS[0], LABELS[-1]
    print(f"{'segment':<26}{labelA:>20}{labelB:>20}{'delta':>10}")
    out_lines = []
    for seg, caps in table.items():
        b = caps.get(labelA, {})
        r = caps.get(labelB, {})
        if b.get("lufs") is not None:
            d = r["lufs"] - b["lufs"]
            line = f"{seg:<26}{b['lufs']:>12.1f} LUFS  {r['lufs']:>12.1f} LUFS  {d:>+8.1f}"
        else:
            line = f"{seg:<26}{b.get('floor_swing_db','?'):>12} swing {r.get('floor_swing_db','?'):>13} swing"
        print(line)
        out_lines.append(line)
    (AB / "lufs-table.txt").write_text("\n".join(out_lines) + "\n")
    (AB / "lufs-table.json").write_text(json.dumps(rows, indent=1))

    # gunfire pollution check inside night_ambience: envelope spikes > 12 dB over floor
    for label in LABELS:
        a, b = segmaps[label]["night_ambience"]
        env = envelope_db(xs[label][int((a + 2) * SR):int((b - 2) * SR)])
        floor = np.percentile(env, 30)
        spikes = int(np.sum(env > floor + 12))
        print(f"{label} night_ambience: floor {floor:.1f} dBFS, 50ms bins >floor+12dB: {spikes}")

    # spectrograms + owner clips
    for label in LABELS:
        a, b = segmaps[label]["night_ambience"]
        subprocess.run(["ffmpeg", "-hide_banner", "-y", "-ss", str(a + 2), "-to", str(a + 32), "-i", str(AB / f"{label}.wav"),
                        "-lavfi", "showspectrumpic=s=1280x480:legend=1:scale=log:fscale=log:start=40:stop=16000",
                        str(AB / f"spec-night-{label}.png")], capture_output=True)
        # owner listening clips (short mp3s)
        clips = {
            "night": (a + 2, a + 22),
            "door": tuple(segmaps[label]["door"]),
            "fire": tuple(segmaps[label]["night_fire"]),
            "day": tuple(segmaps[label]["day_ambience"]),
        }
        for cname, (ca, cb) in clips.items():
            subprocess.run(["ffmpeg", "-hide_banner", "-y", "-ss", str(ca), "-to", str(cb), "-i", str(AB / f"{label}.wav"),
                            "-codec:a", "libmp3lame", "-b:a", "192k", str(AB / f"clip-{cname}-{label}.mp3")], capture_output=True)
    print("clips + spectrograms written to", AB)


if __name__ == "__main__":
    sys.exit(main())
