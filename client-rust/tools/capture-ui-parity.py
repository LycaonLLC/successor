#!/usr/bin/env python3
"""Capture the replayable Successor pregame/loading UI stage matrix."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import struct
import subprocess
import time
from pathlib import Path

STAGES = (
    "entry",
    "connecting",
    "roster",
    "roster-empty",
    "create-profile",
    "create-summary",
    "loading",
)
BMP_SIGNATURE = b"BM"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bmp_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as source:
        header = source.read(54)
    if len(header) != 54 or header[:2] != BMP_SIGNATURE:
        raise RuntimeError(f"capture is not a BMP: {path}")

    file_size = struct.unpack_from("<I", header, 2)[0]
    pixel_offset = struct.unpack_from("<I", header, 10)[0]
    dib_size = struct.unpack_from("<I", header, 14)[0]
    width, height = struct.unpack_from("<ii", header, 18)
    planes, bits_per_pixel = struct.unpack_from("<HH", header, 26)
    compression = struct.unpack_from("<I", header, 30)[0]
    image_size = struct.unpack_from("<I", header, 34)[0]
    if width <= 0 or height <= 0:
        raise RuntimeError(f"capture has invalid BMP dimensions: {path}")
    if (
        dib_size != 40
        or pixel_offset != 54
        or planes != 1
        or bits_per_pixel != 24
        or compression != 0
    ):
        raise RuntimeError(f"capture does not match the Successor BMP format: {path}")

    row_bytes = (width * 3 + 3) & ~3
    expected_image_size = row_bytes * height
    expected_file_size = pixel_offset + expected_image_size
    actual_file_size = path.stat().st_size
    if (
        image_size != expected_image_size
        or file_size != expected_file_size
        or actual_file_size != expected_file_size
    ):
        raise RuntimeError(f"capture is a truncated or malformed BMP: {path}")
    return width, height


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--binary",
        default="target/release/successor",
        help="dev-tools-enabled successor binary, relative to client-rust unless absolute",
    )
    parser.add_argument(
        "--out",
        help="new artifact directory (default: out/ui-parity/<UTC timestamp>)",
    )
    parser.add_argument("--frames", type=int, default=24)
    parser.add_argument(
        "--loading-sequence-count",
        type=int,
        default=25,
        help="400 ms original-client loading samples (0 disables)",
    )
    parser.add_argument(
        "--loading-sequence-step",
        type=int,
        default=24,
        help="60 Hz frames advanced per 400 ms loading sample",
    )
    parser.add_argument(
        "--stages",
        nargs="+",
        choices=STAGES,
        default=list(STAGES),
    )
    parser.add_argument(
        "--ui-surfaces",
        nargs="+",
        default=["actions", "inventory"],
        help="registered window ids to capture; actions must remain first",
    )
    return parser.parse_args()


def run_capture(
    binary: Path,
    root: Path,
    destination: Path,
    label: str,
    arguments: list[str],
    metadata: dict[str, object],
) -> dict[str, object]:
    command = [str(binary), *arguments, "--screenshot", str(destination)]
    started = time.monotonic_ns()
    completed = subprocess.run(command, cwd=root, capture_output=True, text=True)
    duration_ns = time.monotonic_ns() - started
    if completed.returncode != 0:
        raise RuntimeError(
            f"{label} failed with exit {completed.returncode}: "
            f"{completed.stderr[-2000:]}"
        )
    if not destination.is_file():
        raise RuntimeError(f"{label} did not create {destination}")
    width, height = bmp_size(destination)
    metadata.update(
        {
            "path": destination.name,
            "width": width,
            "height": height,
            "bytes": destination.stat().st_size,
            "sha256": sha256(destination),
            "duration_ns": duration_ns,
            "command": command,
        }
    )
    return metadata


def capture_stage(
    binary: Path,
    root: Path,
    destination: Path,
    stage: str,
    frames: int,
) -> dict[str, object]:
    return run_capture(
        binary,
        root,
        destination,
        f"stage {stage!r}",
        [
            "--demo",
            "pregame",
            "--stage",
            stage,
            "--frames",
            str(frames),
        ],
        {"stage": stage, "frames": frames},
    )

def capture_surface(
    binary: Path,
    root: Path,
    destination: Path,
    surface: str,
    frames: int,
) -> dict[str, object]:
    return run_capture(
        binary,
        root,
        destination,
        f"UI surface {surface!r}",
        [
            "--demo",
            "ui",
            "--surface",
            surface,
            "--frames",
            str(frames),
        ],
        {"demo": "ui", "surface": surface, "frames": frames},
    )


def main() -> int:
    args = parse_args()
    if args.frames < 1:
        raise SystemExit("--frames must be positive")
    if args.loading_sequence_count < 0:
        raise SystemExit("--loading-sequence-count must be non-negative")
    if args.loading_sequence_step < 1:
        raise SystemExit("--loading-sequence-step must be positive")
    if not args.ui_surfaces or args.ui_surfaces[0] != "actions":
        raise SystemExit("--ui-surfaces must begin with actions")
    if len(args.ui_surfaces) != len(set(args.ui_surfaces)):
        raise SystemExit("--ui-surfaces must not contain duplicates")

    root = Path(__file__).resolve().parents[1]
    binary = Path(args.binary)
    if not binary.is_absolute():
        binary = root / binary
    binary = binary.resolve()
    if not binary.is_file():
        raise SystemExit(f"successor binary does not exist: {binary}")

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifacts = Path(args.out) if args.out else root / "out" / "ui-parity" / stamp
    if not artifacts.is_absolute():
        artifacts = root / artifacts
    artifacts = artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=False)
    ui_surfaces = [
        capture_surface(
            binary,
            root,
            artifacts / ("ui-overview.bmp" if surface == "actions" else f"ui-{surface}.bmp"),
            surface,
            args.frames,
        )
        for surface in args.ui_surfaces
    ]
    ui_overview = ui_surfaces[0]

    captures = [
        capture_stage(
            binary,
            root,
            artifacts / f"pregame-{stage}.bmp",
            stage,
            args.frames,
        )
        for stage in args.stages
    ]
    loading_sequence = [
        capture_stage(
            binary,
            root,
            artifacts / f"loading-animation-{index:03}.bmp",
            "loading",
            1 + index * args.loading_sequence_step,
        )
        for index in range(args.loading_sequence_count)
    ]

    manifest = {
        "schema_version": 1,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "binary": str(binary),
        "binary_sha256": sha256(binary),
        "frames": args.frames,
        "loading_sequence_step": args.loading_sequence_step,
        "ui_overview": ui_overview,
        "ui_surfaces": ui_surfaces,
        "captures": captures,
        "loading_sequence": loading_sequence,
    }
    manifest_path = artifacts / "capture-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"captured {len(ui_surfaces)} UI surfaces, {len(captures)} stages and "
        f"{len(loading_sequence)} loading frames in {artifacts}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
