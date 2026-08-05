#!/usr/bin/env python3
"""Give every GLB material an explicit metallic/roughness factor.

glTF says a material that omits `metallicFactor` is **fully metallic** and one
that omits `roughnessFactor` is fully rough. A metal surface has no diffuse
albedo, so without an environment map to reflect it renders black - which is
exactly how the building kit shipped: `home_modular_starter` alone left 432
materials unspecified and every wall in the world read as a dark slab no
amount of ambient could lift.

Exporters routinely omit both because their own viewer supplies an IBL. Ours
does not, so the factors have to be written down.

Assignment is by material name, which the kit uses consistently:

  metal        gunmetal, roofmetal, bronze, brass, steel, chrome
  everything   plaster, sinter, screed, umber, paint, basalt, ceramic, ink,
  else         stone, cloth, wood - dielectric

Materials that already state both factors are never touched, so authored
glass, lamps, and glows keep their values.

  python3 tools/successor/assets/fix_glb_pbr.py <path.glb|dir> [...]
  python3 tools/successor/assets/fix_glb_pbr.py --check <path...>
"""

from __future__ import annotations

import json
import pathlib
import struct
import sys

METAL_TOKENS = ("gunmetal", "roofmetal", "bronze", "brass", "steel", "chrome", "alloy")
METAL = {"metallicFactor": 0.85, "roughnessFactor": 0.38}
DIELECTRIC = {"metallicFactor": 0.0, "roughnessFactor": 0.85}


def read_glb(path: pathlib.Path) -> tuple[dict, bytes, int]:
    raw = path.read_bytes()
    if raw[:4] != b"glTF":
        raise ValueError(f"{path}: not a GLB")
    json_len = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20 : 20 + json_len])
    bin_start = 20 + json_len + 8
    return doc, raw, bin_start


def write_glb(path: pathlib.Path, doc: dict, raw: bytes, bin_start: int) -> None:
    """Rewrite the JSON chunk in place; the binary chunk is copied untouched."""
    body = raw[bin_start:]
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    body += b"\x00" * ((4 - len(body) % 4) % 4)
    total = 12 + 8 + len(encoded) + 8 + len(body)
    out = bytearray(b"glTF")
    out += struct.pack("<II", 2, total)
    out += struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    out += struct.pack("<II", len(body), 0x004E4942) + body
    path.write_bytes(bytes(out))


def fix(doc: dict) -> list[str]:
    changed = []
    for material in doc.get("materials", []):
        pbr = material.setdefault("pbrMetallicRoughness", {})
        if "metallicFactor" in pbr and "roughnessFactor" in pbr:
            continue
        name = material.get("name", "")
        preset = METAL if any(t in name.lower() for t in METAL_TOKENS) else DIELECTRIC
        for key, value in preset.items():
            pbr.setdefault(key, value)
        changed.append(name or "<unnamed>")
    return changed


def targets(args: list[str]) -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for arg in args:
        path = pathlib.Path(arg)
        found.extend(sorted(path.rglob("*.glb")) if path.is_dir() else [path])
    return found


def main(argv: list[str]) -> int:
    check = "--check" in argv
    paths = targets([a for a in argv if not a.startswith("--")])
    if not paths:
        print(__doc__)
        return 2
    offenders = 0
    for path in paths:
        doc, raw, bin_start = read_glb(path)
        changed = fix(doc)
        if not changed:
            continue
        offenders += 1
        if check:
            print(f"{path}: {len(changed)} materials without explicit metallic/roughness")
            continue
        write_glb(path, doc, raw, bin_start)
        print(f"{path}: fixed {len(changed)} materials")
    if check and offenders:
        print(f"\n{offenders} file(s) would render metal-black. Run without --check.")
        return 1
    if not offenders:
        print("every material states its metallic and roughness")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
