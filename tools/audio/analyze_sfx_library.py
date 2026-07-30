#!/usr/bin/env python3
"""Full-library SFX forensics for the soundscape verification workflow.

Per manifest clip:
  - LUFS-I / LRA / true-peak (ffmpeg loudnorm print_format=json)
  - effective LUFS through manifest gain staging (clip volume x bus volume)
  - decoded-PCM metrics: duration, crest factor, spectral band split,
    top spectral peaks w/ prominence (resonance/ring suspects),
  - loops only: seam discontinuity (boundary step vs typical delta),
    leading/trailing sub -60 dBFS silence, duty-cycle swell metrics
    (short-term RMS p50/p95 spread, wall factor = share of windows
    within 3 dB of the loudest window).

Outputs TSV + JSON next to --out.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

SR = 44_100

BANDS = [
    ("sub", 0, 120),
    ("low", 120, 500),
    ("mid", 500, 2000),
    ("presence", 2000, 5000),
    ("cicada", 3000, 8000),  # overlaps presence/air on purpose: the shrill band
    ("air", 8000, 22050),
]


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.stdout + proc.stderr


def loudnorm_measure(path: Path) -> dict:
    out = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-af", "loudnorm=I=-24:TP=-2:LRA=11:print_format=json",
        "-f", "null", "-",
    ])
    brace = out.rfind("{")
    if brace == -1:
        return {}
    try:
        blob = json.loads(out[brace - out[:brace][::-1].find("\n"):] if False else out[out.rfind("{", 0, out.rfind("}")):out.rfind("}") + 1])
    except json.JSONDecodeError:
        # find matched braces of the last JSON object
        end = out.rfind("}")
        start = out.rfind("{", 0, end)
        try:
            blob = json.loads(out[start:end + 1])
        except json.JSONDecodeError:
            return {}
    return blob


def decode_pcm(path: Path) -> np.ndarray:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.float32)


def db(x: float, floor: float = -120.0) -> float:
    if x <= 0:
        return floor
    return max(floor, 20.0 * math.log10(x))


def spectral_profile(x: np.ndarray) -> dict:
    n = len(x)
    if n < SR // 4:
        pad = np.zeros(SR // 4, dtype=np.float32)
        pad[:n] = x
        x = pad
        n = len(x)
    win = 8192
    hop = 4096
    if n < win:
        win = 2048
        hop = 1024
    frames = 1 + (n - win) // hop
    frames = min(frames, 400)
    acc = np.zeros(win // 2 + 1)
    w = np.hanning(win)
    for i in range(frames):
        seg = x[i * hop: i * hop + win] * w
        acc += np.abs(np.fft.rfft(seg)) ** 2
    acc /= max(frames, 1)
    freqs = np.fft.rfftfreq(win, 1 / SR)
    total = acc.sum() or 1.0
    bands = {}
    for name, lo, hi in BANDS:
        sel = (freqs >= lo) & (freqs < hi)
        bands[name] = round(float(acc[sel].sum() / total), 4)
    centroid = float((freqs * acc).sum() / total)
    # resonance peaks: local maxima at least 12 dB above the median spectrum level
    logspec = 10 * np.log10(acc + 1e-20)
    med = np.median(logspec[(freqs > 80) & (freqs < 16000)])
    peaks = []
    for i in range(2, len(acc) - 2):
        if freqs[i] < 80 or freqs[i] > 16000:
            continue
        if logspec[i] > logspec[i - 1] and logspec[i] >= logspec[i + 1] and logspec[i] - med > 12:
            # peak sharpness: dB drop 3 bins (~16 Hz*3) away
            drop = logspec[i] - max(logspec[max(0, i - 6)], logspec[min(len(acc) - 1, i + 6)])
            peaks.append((float(freqs[i]), float(logspec[i] - med), float(drop)))
    peaks.sort(key=lambda p: -p[1])
    top = [
        {"hz": round(p[0], 1), "above_median_db": round(p[1], 1), "sharpness_db": round(p[2], 1)}
        for p in peaks[:5]
    ]
    return {"bands": bands, "centroid_hz": round(centroid, 1), "peaks": top}


def envelope_metrics(x: np.ndarray) -> dict:
    winlen = int(0.4 * SR)
    hop = int(0.1 * SR)
    if len(x) < winlen:
        winlen = max(1024, len(x) // 2)
        hop = winlen // 4
    rms = []
    for i in range(0, len(x) - winlen, hop):
        seg = x[i:i + winlen]
        rms.append(float(np.sqrt(np.mean(seg * seg))))
    if not rms:
        rms = [float(np.sqrt(np.mean(x * x)) or 1e-10)]
    rms_db = np.array([db(v) for v in rms])
    p50 = float(np.percentile(rms_db, 50))
    p95 = float(np.percentile(rms_db, 95))
    mx = float(rms_db.max())
    wall = float(np.mean(rms_db > mx - 3.0))
    return {
        "st_rms_p50_db": round(p50, 2),
        "st_rms_p95_db": round(p95, 2),
        "st_rms_max_db": round(mx, 2),
        "swell_p95_minus_p50_db": round(p95 - p50, 2),
        "wall_factor": round(wall, 3),
    }


def seam_metrics(x: np.ndarray) -> dict:
    if len(x) < SR // 10:
        return {}
    d = np.abs(np.diff(x))
    typical = float(np.percentile(d, 99)) or 1e-9
    boundary = abs(float(x[0]) - float(x[-1]))
    ratio = boundary / typical
    thr = 10 ** (-60 / 20)
    lead = int(np.argmax(np.abs(x) > thr)) if np.any(np.abs(x) > thr) else len(x)
    rev = np.abs(x[::-1]) > thr
    trail = int(np.argmax(rev)) if np.any(rev) else len(x)
    edge_rms_head = float(np.sqrt(np.mean(x[: SR // 100] ** 2)))
    edge_rms_tail = float(np.sqrt(np.mean(x[-SR // 100:] ** 2)))
    body = float(np.sqrt(np.mean(x ** 2))) or 1e-9
    return {
        "seam_step_abs": round(boundary, 5),
        "seam_step_vs_p99delta": round(ratio, 2),
        "lead_silence_ms": round(lead / SR * 1000, 1),
        "trail_silence_ms": round(trail / SR * 1000, 1),
        "head10ms_rms_db": round(db(edge_rms_head), 1),
        "tail10ms_rms_db": round(db(edge_rms_tail), 1),
        "body_rms_db": round(db(body), 1),
    }


def analyze_clip(entry: dict, root: Path, buses: dict) -> dict:
    rel = entry["path"].lstrip("/")
    # manifest paths are like /successor-audio/sfx/x.mp3 relative to public/
    path = root / rel.replace("successor-audio/sfx/", "")
    result = {
        "id": entry["id"],
        "bus": entry["bus"],
        "volume": entry["volume"],
        "loop": bool(entry.get("loop")),
        "file": path.name,
    }
    if not path.exists():
        result["error"] = "missing file"
        return result
    loud = loudnorm_measure(path)
    lufs = float(loud.get("input_i", "nan"))
    result["lufs_i"] = lufs
    result["lra"] = float(loud.get("input_lra", "nan"))
    result["tp_db"] = float(loud.get("input_tp", "nan"))
    bus_vol = buses.get(entry["bus"], {}).get("volume", 1.0)
    gain_db = 20 * math.log10(max(entry["volume"] * bus_vol, 1e-6))
    result["gain_staged_db"] = round(gain_db, 2)
    result["effective_lufs"] = round(lufs + gain_db, 2) if math.isfinite(lufs) else None
    x = decode_pcm(path)
    result["duration_s"] = round(len(x) / SR, 3)
    if len(x):
        peak = float(np.max(np.abs(x))) or 1e-9
        rms = float(np.sqrt(np.mean(x * x))) or 1e-9
        result["crest_db"] = round(db(peak) - db(rms), 1)
        result["spectral"] = spectral_profile(x)
        result["envelope"] = envelope_metrics(x)
        if entry.get("loop"):
            result["seam"] = seam_metrics(x)
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text())
    root = manifest_path.parent
    buses = manifest.get("buses", {})
    clips = manifest["clips"]
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda c: analyze_clip(c, root, buses), clips))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"buses": buses, "clips": results}, indent=1))
    # compact TSV for the analysis doc
    tsv = out.with_suffix(".tsv")
    cols = ["id", "bus", "loop", "volume", "lufs_i", "lra", "tp_db", "effective_lufs",
            "duration_s", "crest_db"]
    lines = ["\t".join(cols + ["cicada_frac", "centroid_hz", "swell_db", "wall", "seam_ratio", "top_peak"]) ]
    for r in results:
        row = [str(r.get(c, "")) for c in cols]
        spec = r.get("spectral", {})
        env = r.get("envelope", {})
        seam = r.get("seam", {})
        peak = spec.get("peaks", [{}])
        peak0 = peak[0] if peak else {}
        row += [
            str(spec.get("bands", {}).get("cicada", "")),
            str(spec.get("centroid_hz", "")),
            str(env.get("swell_p95_minus_p50_db", "")),
            str(env.get("wall_factor", "")),
            str(seam.get("seam_step_vs_p99delta", "")),
            f"{peak0.get('hz','')}Hz+{peak0.get('above_median_db','')}dB" if peak0 else "",
        ]
        lines.append("\t".join(row))
    tsv.write_text("\n".join(lines) + "\n")
    print(f"wrote {out} and {tsv} ({len(results)} clips)")


if __name__ == "__main__":
    sys.exit(main())
