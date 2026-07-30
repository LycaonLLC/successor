#!/usr/bin/env python3
"""Generate the first Successor runtime SFX bank with ElevenLabs."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests


REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "client" / "public" / "successor-audio" / "sfx"
MANIFEST_PATH = OUT_DIR / "manifest.json"
PROVENANCE_PATH = OUT_DIR / "manifest.provenance.json"
API_KEY_PATH = Path("~/.config/elevenlabs/api-key").expanduser()
ENDPOINT = "https://api.elevenlabs.io/v1/sound-generation"
OUTPUT_FORMAT = "mp3_44100_128"
MODEL_ID = "eleven_text_to_sound_v2"


@dataclass(frozen=True)
class SfxSpec:
    id: str
    file: str
    bus: str
    volume: float
    duration_seconds: float
    prompt_influence: float
    prompt: str
    tags: tuple[str, ...]
    polyphony: int = 4
    post_gain_db: float = 0.0


SFX: tuple[SfxSpec, ...] = (
    SfxSpec(
        id="ui_panel_open",
        file="ui_panel_open.mp3",
        bus="ui",
        volume=0.34,
        duration_seconds=0.5,
        prompt_influence=0.48,
        tags=("ui", "panel"),
        prompt="Short gritty game inventory panel opening sound: tactile cyberdeck latch click, tiny relay snap, warm CRT chirp upward, dry one-shot, no voice, no music, no long tail.",
    ),
    SfxSpec(
        id="ui_panel_close",
        file="ui_panel_close.mp3",
        bus="ui",
        volume=0.28,
        duration_seconds=0.5,
        prompt_influence=0.48,
        tags=("ui", "panel"),
        prompt="Short gritty game inventory panel closing sound: firm mechanical latch shut, clipped relay snap, tiny descending digital blip, dry one-shot, no voice, no music, no long tail.",
    ),
    SfxSpec(
        id="ui_button_tick",
        file="ui_button_tick.mp3",
        bus="ui",
        volume=0.22,
        duration_seconds=0.5,
        prompt_influence=0.38,
        tags=("ui", "button"),
        prompt="Very short terminal button tick: mechanical key click layered with a tiny neon digital blip, dry, clean, no voice, no music.",
    ),
    SfxSpec(
        id="ui_toolbar_use",
        file="ui_toolbar_use.mp3",
        bus="ui",
        volume=0.16,
        duration_seconds=0.5,
        prompt_influence=0.42,
        tags=("ui", "toolbar", "ability", "confirm"),
        prompt="Very short sci-fi MMO ability toolbar confirmation: soft glassy button tap, warm micro relay click, tiny upward holographic chirp, satisfying but subtle, dry one-shot, no voice, no music, no long tail.",
        polyphony=8,
        post_gain_db=8.0,
    ),
    SfxSpec(
        id="ui_toolbar_ineligible",
        file="ui_toolbar_ineligible.mp3",
        bus="ui",
        volume=0.2,
        duration_seconds=0.5,
        prompt_influence=0.36,
        tags=("ui", "toolbar", "ability", "ineligible"),
        prompt="Very short non-abrasive sci-fi MMO ability ineligible cue: muted soft double tick, low rounded digital blip downward, gentle denial feedback, dry one-shot, no alarm, no harsh buzz, no voice, no music.",
        polyphony=6,
    ),
    SfxSpec(
        id="equip_pistol",
        file="equip_pistol.mp3",
        bus="gear",
        volume=0.42,
        duration_seconds=0.65,
        prompt_influence=0.46,
        tags=("weapon", "equip", "pistol"),
        prompt="Compact sidearm equip sound: cloth rustle, small polymer pistol lifted, metal slide tap, tight arcade inventory one-shot, no firing, no voice.",
    ),
    SfxSpec(
        id="equip_shotgun",
        file="equip_shotgun.mp3",
        bus="gear",
        volume=0.5,
        duration_seconds=0.78,
        prompt_influence=0.48,
        tags=("weapon", "equip", "shotgun"),
        prompt="Tactical pump shotgun equip sound: heavier cloth sling movement, metal receiver clack, short pump grip knock, arcade readable, no firing, no voice.",
    ),
    SfxSpec(
        id="pistol_fire",
        file="pistol_fire.mp3",
        bus="weapons",
        volume=0.82,
        duration_seconds=0.55,
        prompt_influence=0.56,
        tags=("weapon", "pistol", "fire"),
        prompt="Unsuppressed 9mm pistol gunshot. Loud single shot, sharp crack, bright muzzle blast, close microphone. No silence. No music. No voice.",
        polyphony=8,
        post_gain_db=18.0,
    ),
    SfxSpec(
        id="pistol_reload",
        file="pistol_reload.mp3",
        bus="weapons",
        volume=0.43,
        duration_seconds=0.85,
        prompt_influence=0.5,
        tags=("weapon", "pistol", "reload"),
        prompt="Compact pistol reload one-shot: magazine click out and in, light slide rack, tight mechanical handling, arcade UI readable, no firing, no voice.",
    ),
    SfxSpec(
        id="shotgun_fire",
        file="shotgun_fire.mp3",
        bus="weapons",
        volume=0.72,
        duration_seconds=0.65,
        prompt_influence=0.55,
        tags=("weapon", "shotgun", "fire"),
        prompt="Pump shotgun shot. Loud muzzle blast, heavy thump, dry close microphone, short echo. No explosion. No music. No voice.",
        polyphony=6,
    ),
    SfxSpec(
        id="shotgun_reload",
        file="shotgun_reload.mp3",
        bus="weapons",
        volume=0.5,
        duration_seconds=1.1,
        prompt_influence=0.5,
        tags=("weapon", "shotgun", "reload"),
        prompt="Pump shotgun reload one-shot: two shell clicks into tube, subtle metal receiver clack, short pump confirmation, tight arcade timing, no firing, no voice.",
    ),
    SfxSpec(
        id="weapon_dry",
        file="weapon_dry.mp3",
        bus="weapons",
        volume=0.36,
        duration_seconds=0.5,
        prompt_influence=0.44,
        tags=("weapon", "dry"),
        prompt="Empty firearm dry click: short hollow trigger click with tiny metal tick, clear arcade feedback, no shot, no voice, no music.",
    ),
    SfxSpec(
        id="stimpak_apply",
        file="stimpak_apply.mp3",
        bus="gear",
        volume=0.46,
        duration_seconds=0.75,
        prompt_influence=0.62,
        tags=("medical", "consumable", "stimpak"),
        prompt="Short sci-fi field stimpak use sound for a top-down MMO: tight injector cap click, pneumatic hypospray hiss, liquid pressure snap, quick sterile synth pulse rising, clean one-shot, no voice, no music, no long reverb.",
        polyphony=8,
    ),
    SfxSpec(
        id="bandage_apply",
        file="bandage_apply.mp3",
        bus="foley",
        volume=0.52,
        duration_seconds=0.85,
        prompt_influence=0.6,
        tags=("medical", "consumable", "bandage"),
        prompt="Short field bandage application sound for an isometric RPG: gauze packet tear, cloth wrap pull, adhesive cinch, small buckle snap, dry tactile foley, no voice, no music, no wet gore.",
        polyphony=8,
    ),
    SfxSpec(
        id="inventory_transfer",
        file="inventory_transfer.mp3",
        bus="gear",
        volume=0.38,
        duration_seconds=0.58,
        prompt_influence=0.52,
        tags=("inventory", "pickup", "ammo", "transfer"),
        prompt="Short ammo pickup and inventory transfer sound: compact box clack, a few brass rounds settling, satchel snap, subtle terminal confirmation tick, grounded MMO loot feedback, no voice, no music.",
        polyphony=10,
    ),
    SfxSpec(
        id="projectile_hit",
        file="projectile_hit.mp3",
        bus="world",
        volume=0.5,
        duration_seconds=0.55,
        prompt_influence=0.58,
        tags=("combat", "hit"),
        prompt="Fast bullet impact on a tin target: sharp metallic spall ping, dry dent snap, tiny debris ticks, not a UI blip, no laser, no voice, no music.",
        polyphony=8,
    ),
    SfxSpec(
        id="target_down",
        file="death.mp3",
        bus="world",
        volume=0.55,
        duration_seconds=1.032,
        prompt_influence=0.5,
        tags=("combat", "death", "downed"),
        prompt="User-supplied Successor down/death one-shot. Do not regenerate over this clip.",
    ),
    SfxSpec(
        id="area_transition",
        file="area_transition.mp3",
        bus="world",
        volume=0.4,
        duration_seconds=0.9,
        prompt_influence=0.42,
        tags=("world", "transition"),
        prompt="Entering a cyberpunk shop doorway: soft automatic door hiss, neon room tone swell, tiny relay tick, quick transition one-shot, no voice, no music.",
    ),
    SfxSpec(
        id="chat_send",
        file="chat_send.mp3",
        bus="ui",
        volume=0.24,
        duration_seconds=0.5,
        prompt_influence=0.36,
        tags=("chat", "ui"),
        prompt="Tiny chat send sound: clean data packet blip, soft key confirmation, unobtrusive social MMO UI one-shot, no voice, no music.",
    ),
    SfxSpec(
        id="chat_receive",
        file="chat_receive.mp3",
        bus="ui",
        volume=0.22,
        duration_seconds=0.5,
        prompt_influence=0.36,
        tags=("chat", "ui"),
        prompt="Tiny incoming chat sound: soft terminal notification chirp, single clean pulse, friendly but restrained, no voice, no music.",
    ),
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def probe_duration(path: Path) -> float | None:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    try:
        return round(float(result.stdout.strip()), 3)
    except ValueError:
        return None


def postprocess_clip(path: Path, gain_db: float) -> None:
    if gain_db == 0:
        return
    tmp = path.with_suffix(".postprocess.mp3")
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(path),
            "-af",
            f"volume={gain_db}dB,alimiter=limit=0.95",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "128k",
            str(tmp),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"failed to postprocess {path.name}: {result.stderr.strip()}")
    tmp.replace(path)


def generate_clip(spec: SfxSpec, api_key: str, force: bool) -> dict[str, Any]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / spec.file
    request_headers: dict[str, str | None] = {}

    if force or not out.exists():
        response = requests.post(
            f"{ENDPOINT}?output_format={OUTPUT_FORMAT}",
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            json={
                "text": spec.prompt,
                "duration_seconds": spec.duration_seconds,
                "prompt_influence": spec.prompt_influence,
                "model_id": MODEL_ID,
            },
            timeout=180,
        )
        response.raise_for_status()
        out.write_bytes(response.content)
        postprocess_clip(out, spec.post_gain_db)
        request_headers = {
            "requestId": response.headers.get("request-id") or response.headers.get("x-request-id"),
            "historyItemId": response.headers.get("history-item-id") or response.headers.get("x-history-item-id"),
        }

    return {
        "id": spec.id,
        "path": f"/successor-audio/sfx/{spec.file}",
        "bus": spec.bus,
        "volume": spec.volume,
        "polyphony": spec.polyphony,
        "tags": list(spec.tags),
        "durationSeconds": probe_duration(out),
        "sha256": sha256(out),
        "bytes": out.stat().st_size,
        "prompt": spec.prompt,
        "requestedDurationSeconds": spec.duration_seconds,
        "promptInfluence": spec.prompt_influence,
        "postGainDb": spec.post_gain_db,
        "modelId": MODEL_ID,
        **{key: value for key, value in request_headers.items() if value},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="regenerate existing clips")
    parser.add_argument("--only", action="append", help="generate only the selected id; can be repeated")
    args = parser.parse_args()

    api_key = API_KEY_PATH.read_text(encoding="utf-8").strip()
    selected = set(args.only or [])
    specs = [spec for spec in SFX if not selected or spec.id in selected]
    unknown = selected.difference({spec.id for spec in SFX})
    if unknown:
        raise SystemExit(f"unknown SFX id(s): {', '.join(sorted(unknown))}")

    existing_manifest: dict[str, Any] = {}
    existing_provenance: dict[str, Any] = {}
    if MANIFEST_PATH.exists():
        existing_manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if PROVENANCE_PATH.exists():
        existing_provenance = json.loads(PROVENANCE_PATH.read_text(encoding="utf-8"))

    manifest_by_id: dict[str, dict[str, Any]] = {}
    provenance_by_id: dict[str, dict[str, Any]] = {}
    if selected:
        for old in existing_manifest.get("clips", []):
            manifest_by_id[old["id"]] = old
        for old in existing_provenance.get("clips", []):
            provenance_by_id[old["id"]] = old

    entries = [generate_clip(spec, api_key, args.force) for spec in specs]
    generated_ids = {entry["id"] for entry in entries}
    for entry in entries:
        manifest_by_id[entry["id"]] = entry
        provenance_by_id[entry["id"]] = entry

    if not selected:
        manifest_by_id.clear()
        provenance_by_id.clear()
        for entry in entries:
            manifest_by_id[entry["id"]] = entry
            provenance_by_id[entry["id"]] = entry

    ordered_ids: list[str] = []
    for old in existing_manifest.get("clips", []):
        if old["id"] in manifest_by_id and old["id"] not in ordered_ids:
            ordered_ids.append(old["id"])
    for spec in SFX:
        if spec.id in manifest_by_id and spec.id not in ordered_ids:
            ordered_ids.append(spec.id)

    clips = [manifest_by_id[clip_id] for clip_id in ordered_ids]
    provenance_clips = [
        provenance_by_id.get(clip_id, manifest_by_id[clip_id])
        for clip_id in ordered_ids
    ]
    default_buses = {
        "ui": {"volume": 0.75, "polyphony": 6},
        "gear": {"volume": 0.85, "polyphony": 4},
        "weapons": {"volume": 0.85, "polyphony": 10},
        "world": {"volume": 0.78, "polyphony": 8},
        "foley": {"volume": 0.52, "polyphony": 32},
    }
    buses = {
        **default_buses,
        **(existing_manifest.get("buses") if isinstance(existing_manifest.get("buses"), dict) else {}),
    }
    def public_clip(clip: dict[str, Any]) -> dict[str, Any]:
        if selected and clip.get("id") not in generated_ids:
            return clip
        return {
            key: value
            for key, value in clip.items()
            if key not in {"prompt", "requestedDurationSeconds", "promptInfluence", "requestId", "historyItemId"}
        }

    manifest = {
        "schema": "successor-sfx-manifest-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "vendor": "ElevenLabs",
        "endpoint": ENDPOINT,
        "outputFormat": OUTPUT_FORMAT,
        "predecode": True,
        "modelId": MODEL_ID,
        "buses": buses,
        "clips": [public_clip(clip) for clip in clips],
    }
    provenance = {
        **manifest,
        "docs": "https://elevenlabs.io/docs/api-reference/sound-generation/",
        "clips": provenance_clips,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"clips": len(clips), "manifest": str(MANIFEST_PATH), "provenance": str(PROVENANCE_PATH)}, indent=2))


if __name__ == "__main__":
    main()
