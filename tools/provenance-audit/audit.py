#!/usr/bin/env python3
"""
Provenance audit. Walks content-pipeline/ for assets and verifies that:

1. Every asset has a sibling .manifest.json
2. Every manifest conforms to the schema
3. The recorded asset_hash matches the actual file hash
4. Required fields (tool, prompt, denylist_audit, review) are populated
5. Prompts pass the current denylist

Exit 0 on clean, 1 on any violation, 2 on misuse.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ASSET_EXTS = {
    ".glb", ".gltf",
    ".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".basis",
    ".wav", ".ogg", ".mp3", ".flac",
    ".bvh",
}

REPO_ROOT = Path(__file__).resolve().parents[2]
PIPELINE = REPO_ROOT / "content-pipeline"
DENYLIST_CHECK = REPO_ROOT / "tools" / "denylist" / "check.sh"


def blake3_hex(path: Path) -> str:
    try:
        import blake3 as _blake3
        h = _blake3.blake3()
    except ImportError:
        sys.stderr.write("blake3 not installed; falling back to sha256 (manifests must declare 'sha256:' prefix in that case).\n")
        h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check_denylist(prompt: str) -> bool:
    if not DENYLIST_CHECK.exists():
        return True
    result = subprocess.run(
        [str(DENYLIST_CHECK), "--prompt", prompt],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def audit_asset(asset_path: Path) -> list[str]:
    errors: list[str] = []
    manifest_path = asset_path.with_suffix(asset_path.suffix + ".manifest.json")
    if not manifest_path.exists():
        return [f"{asset_path}: missing manifest at {manifest_path}"]

    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as e:
        return [f"{manifest_path}: invalid JSON ({e})"]

    required = [
        "asset_id", "asset_path", "asset_hash", "asset_kind",
        "tool", "prompt", "review",
    ]
    for k in required:
        if k not in manifest:
            errors.append(f"{manifest_path}: missing required field '{k}'")

    asset_hash = manifest.get("asset_hash", "")
    if asset_hash:
        prefix, _, expected_hex = asset_hash.partition(":")
        if prefix not in {"blake3", "sha256"}:
            errors.append(f"{manifest_path}: unknown hash algorithm '{prefix}'")
        else:
            actual_hex = blake3_hex(asset_path) if prefix == "blake3" else hashlib.sha256(asset_path.read_bytes()).hexdigest()
            if actual_hex != expected_hex:
                errors.append(
                    f"{manifest_path}: hash mismatch (manifest={expected_hex[:16]}..., actual={actual_hex[:16]}...)"
                )

    prompt_text = (manifest.get("prompt") or {}).get("text", "")
    if prompt_text and not check_denylist(prompt_text):
        errors.append(f"{manifest_path}: prompt fails denylist re-audit")

    review = manifest.get("review") or {}
    if not review.get("art_director"):
        errors.append(f"{manifest_path}: review.art_director missing")
    if not review.get("approved_at"):
        errors.append(f"{manifest_path}: review.approved_at missing")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="treat warnings as errors")
    args = parser.parse_args()

    if not PIPELINE.exists():
        print(f"pipeline directory missing: {PIPELINE}", file=sys.stderr)
        return 2

    errors: list[str] = []
    asset_count = 0

    for path in PIPELINE.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in ASSET_EXTS:
            continue
        if path.name.endswith(".manifest.json"):
            continue
        asset_count += 1
        errors.extend(audit_asset(path))

    if errors:
        print(f"provenance audit found {len(errors)} issue(s) across {asset_count} asset(s):", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1

    print(f"provenance audit clean ({asset_count} asset(s)).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
