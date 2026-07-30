"""End-to-end verification of the shipped package. Re-runnable.

  python3 src/verify.py
"""
import hashlib
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.path.join(ROOT, "build")
sys.path.insert(0, os.path.join(ROOT, "src"))
import plan as PL  # noqa: E402

FAILS = []


def ck(cond, msg):
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAILS.append(msg)


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


print("=== 1. coordinate contract ===")
PL.assert_contract(verbose=True)
ck(True, "zero-based fixture centres assert in glTF and authoring space")

print("=== 2. deliverables exist ===")
need = ["market_house_lod0.glb", "market_house_lod1.glb", "market_house_lod2.glb",
        "market_house_furnished.glb", "market_house.collision.json",
        "market_house.manifest.json", "market_house_full.blend",
        "checkpoints/market_house_checkpoint_01_full_lod0.blend"]
for n in need:
    ck(os.path.exists(os.path.join(B, n)), f"exists: {n}")

man = json.load(open(os.path.join(B, "market_house.manifest.json")))

print("=== 3. manifest hashes match the files on disk ===")
for k, v in man["lods"].items():
    p = os.path.join(B, v["file"])
    ck(sha(p) == v["sha256"], f"{k} sha256 matches ({v['sha256'][:16]}...)")
    ck(os.path.getsize(p) == v["bytes"], f"{k} byte count matches ({v['bytes']})")
p = os.path.join(B, man["furnished"]["file"])
ck(sha(p) == man["furnished"]["sha256"], "furnished sha256 matches")
ck(sha(os.path.join(B, "market_house.collision.json")) ==
   man["collision"]["sidecar_sha256"], "collision sidecar sha256 matches")

print("=== 4. budgets and contract values ===")
for k, v in man["lods"].items():
    ck(v["within_budget"],
       f"{k}: {v['triangles']} tris <= {v['triangle_budget']}")
sz = man["lods"]["lod0"]["size_m"]
ck(sz["x"] <= 11.4 + 1e-6 and sz["z_front"] <= 8.55 + 1e-6,
   f"footprint {sz['x']} x {sz['z_front']} m within 11.40 x 8.55")
d = man["door"]
ck(d["node"] == "door_slide" and d["node_parent"] is None,
   "door_slide is a root node")
ck(d["clip_seconds"] == 0.8 and set(d["clips"]) == {"door_open", "door_close"},
   f"clips {d['clips']} at {d['clip_seconds']} s")
ck(abs(d["travel_abs_m"] - 2.6) < 1e-9, f"recorded travel {d['travel_abs_m']} m on local {d['local_axis']}")
ck(man["collision"]["clearance_issues"] == [],
   f"all {len(man['collision']['clearance_checks'])} clearance checks clear")
ck(all(c["clear"] for c in man["collision"]["clearance_checks"]),
   "no clearance check reports a blocker")

print("=== 5. every prop has provenance ===")
PD = os.path.abspath(os.path.join(ROOT, "..", "..", "..", "..", "client-3d",
                                  "public", "assets", "world-items"))
for r in man["props"]:
    fp = os.path.join(ROOT, "..", "..", "..", "..", r["file"])
    ck(os.path.exists(fp) and sha(fp) == r["sha256"],
       f"{os.path.basename(r['file'])} sha256 matches the runtime file")
    ck(r["provenance"] is not None, f"{os.path.basename(r['file'])} has provenance")
ck(len(man["props_omitted"]) == 8, "8 optional props omitted for missing provenance")

print("=== 6. strict glTF validation ===")
for k in ("lod0", "lod1", "lod2", "furnished"):
    out = subprocess.run(["npx", "--no-install", "gltf-transform", "validate",
                          os.path.join(B, f"market_house_{k}.glb")],
                         capture_output=True, text=True, cwd=ROOT).stdout
    nerr = out.count("│ ") and sum(1 for ln in out.splitlines()
                                   if ln.startswith("│ ") and ln[2:3].isupper())
    ck("No errors found" in out, f"{k}: no validation errors")
    ck("No warnings found" in out, f"{k}: no validation warnings")

print("=== 7. Three.js loader + animation proof ===")
for k in ("lod0", "lod1", "lod2", "furnished"):
    r = subprocess.run(["node", "src/loader_proof.mjs",
                        f"build/market_house_{k}.glb"], capture_output=True,
                       text=True, cwd=ROOT)
    ck(r.returncode == 0 and "LOADER_PROOF_OK" in r.stdout,
       f"{k}: loader proof OK ({r.stdout.count(' PASS')} assertions)")

print("=== 8. proof set ===")
PF = os.path.join(ROOT, "proofs", "final")
views = sorted(f for f in os.listdir(PF) if f.endswith(".png")
               and f != "texture_contact_sheet.png")
ck(len(views) == 27, f"27 final views present ({len(views)})")
required = ["01_front", "02_back", "03_left", "04_right", "05_top",
            "06_three_quarter", "07_gameplay_ortho", "08_interior_roofoff",
            "09_interior_eye_hall", "10_door_closed", "11_door_open",
            "12_crop_entrance_door", "13_crop_facade_hood",
            "14_crop_floor_wall_contact", "15_crop_service_counter",
            "16_crop_uv_seam_corner", "17_rear_service"]
for r in required:
    ck(any(v.startswith(r) for v in views), f"required view: {r}")
dark = [v for v in views
        if np.asarray(Image.open(os.path.join(PF, v)).convert("L")).mean() < 12]
ck(not dark, f"no proof view is effectively black ({dark})")

a = np.asarray(Image.open(os.path.join(PF, "10_door_closed.png")).convert("RGB"), float)
b = np.asarray(Image.open(os.path.join(PF, "11_door_open.png")).convert("RGB"), float)
rmse = float(np.sqrt(((a - b) ** 2).mean()))
ck(rmse > 1.0, f"door closed vs open differ: RMSE {rmse:.3f}, "
   f"{float((np.abs(a-b).max(-1)>8).mean())*100:.2f}% pixels changed")

print("=== 9. texture sheet is current ===")
ts = json.load(open(os.path.join(PF, "texture_contact_sheet.json")))
stale = [k for k, v in ts["hashes_shown"].items()
         if sha(os.path.join(B, "textures", k)) != v]
ck(not stale, f"contact sheet matches the final maps ({len(ts['hashes_shown'])} files)")
ck(len(man["textures"]) == 21, f"{len(man['textures'])} texture files recorded")

print("=== 10. camera positions are outside authored collision ===")
col = json.load(open(os.path.join(B, "market_house.collision.json")))


def blocked(x, y, z, r=0.20):
    out = []
    for bx in col["boxes"]:
        x0, x1 = bx["min"][0], bx["max"][0]
        y0, y1 = -bx["max"][2], -bx["min"][2]
        z0, z1 = bx["min"][1], bx["max"][1]
        if x0 - r < x < x1 + r and y0 - r < y < y1 + r and z0 - r < z < z1 + r:
            out.append(bx["id"])
    return out


import re
src = open(os.path.join(ROOT, "src", "render.py")).read()
cams = re.findall(r"cam\(\(([-\d.]+), ([-\d.]+), ([-\d.]+)\)", src)
bad = [(c, blocked(*map(float, c))) for c in cams if blocked(*map(float, c))]
ck(not bad, f"all {len(cams)} proof cameras sit outside authored collision "
   f"({[b[0] for b in bad]})")

print()
print(f"{len(FAILS)} FAILURES" if FAILS else "VERIFY_ALL_OK")
for f in FAILS:
    print("  -", f)
sys.exit(1 if FAILS else 0)
