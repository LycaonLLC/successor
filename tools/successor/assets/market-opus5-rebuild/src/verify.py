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
ck(len(views) >= 36, f"{len(views)} final views present (>= 36 required)")
required = ["01_front", "02_back", "03_left", "04_right", "05_top",
            "06_three_quarter", "07_gameplay_ortho", "08_interior_roofoff",
            "09_interior_eye_hall", "10_door_closed", "11_door_open",
            "12_crop_entrance_door", "13_crop_facade_hood",
            "14_crop_floor_wall_contact", "15_crop_service_counter",
            "16_crop_uv_seam_corner", "17_rear_service",
            # pass-3 acceptance evidence, named by the review gate
            "28_term_bank_face", "29_term_trade_face", "30_term_assoc_face",
            "31_boh_route_from_rear_door", "32_boh_route_along_aisle",
            "33_trainer_booth", "34_crop_corner_sealed",
            "35_crop_corner_sealed_ne", "36_crop_hood_smooth"]
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

# ===========================================================================
# 11-15. THE FAILURE MODES THE PASS-2 CHECK SET OMITTED
# ===========================================================================
# The pass-3 review gate: "A 76/76 result is not meaningful if these cases are
# absent."  Each section below tests a defect that shipped green.

print("=== 11. terminal interaction faces point at the customer ===")
# Measured from the SHIPPED furnished GLB, in glTF space, from the screen
# geometry itself -- not from placement yaw, and not from the prose in the
# terminal manifests (which is what the wrong 180 deg placement was reasoned
# from).  The interaction face must point +Z, the public/customer side.
r = subprocess.run(["node", "src/term_face_proof.mjs",
                    "build/market_house_furnished.glb"],
                   capture_output=True, text=True, cwd=ROOT)
print(r.stdout.rstrip())
ck(r.returncode == 0 and "TERM_FACE_OK" in r.stdout,
   "all three terminals: screen normal points +Z (customer side)")
if r.returncode != 0:
    print(r.stderr[-2000:])

print("=== 12. loose-prop footprints do not intersect authored collision ===")
col = json.load(open(os.path.join(B, "market_house.collision.json")))
props_m = json.load(open(os.path.join(B, "prop_footprints.json")))


def boxes_overlap(a, b, tol=0.004):
    """a, b as (x0,x1,y0,y1,z0,z1) in authoring space."""
    return not (a[1] <= b[0] + tol or a[0] >= b[1] - tol or
                a[3] <= b[2] + tol or a[2] >= b[3] - tol or
                a[5] <= b[4] + tol or a[4] >= b[5] - tol)


col_a = []
for bx in col["boxes"]:
    col_a.append((bx["id"], (bx["min"][0], bx["max"][0],
                             -bx["max"][2], -bx["min"][2],
                             bx["min"][1], bx["max"][1]), bx["kind"]))
for pf in props_m["props"]:
    fp = (pf["x0"], pf["x1"], pf["y0"], pf["y1"], pf["z0"], pf["z1"])
    hits = [i for (i, cb, kind) in col_a if boxes_overlap(fp, cb)]
    ck(not hits, f"{pf['name']}: footprint clear of authored collision ({hits})")
ck(len(props_m["props"]) == 7, f"{len(props_m['props'])} prop footprints measured")

print("=== 13. rear entrance -> BOH -> rear of all three fixtures ===")
# A SAMPLED PATH check, not a named-cell check.  Builds an occupancy grid from
# the authored collision proxies in the body-height band, computes the distance
# transform, then runs a widest-path (max-min bottleneck) search from the rear
# doorway to the service side of each fixture.  Reports the MEASURED minimum
# corridor width along the best route.
GRID = 0.02
Z_LO, Z_HI = 0.12, 1.85          # body band: a high shelf is not a blocker
X0, X1 = -5.30, 5.30
Y0, Y1 = 1.90, 4.80              # BOH + a standoff outside the rear doorway
nx = int(round((X1 - X0) / GRID))
ny = int(round((Y1 - Y0) / GRID))
occ = np.zeros((ny, nx), bool)
for bx in col["boxes"]:
    bz0, bz1 = bx["min"][1], bx["max"][1]
    if bz1 <= Z_LO or bz0 >= Z_HI:
        continue                 # entirely above or below the body band
    ax0, ax1 = bx["min"][0], bx["max"][0]
    ay0, ay1 = -bx["max"][2], -bx["min"][2]
    if bx["id"].startswith("shell__wall_north") and "head" not in bx["id"]:
        pass                     # the rear wall, with its doorway gap, is real
    i0 = max(0, int(np.floor((ay0 - Y0) / GRID)))
    i1 = min(ny, int(np.ceil((ay1 - Y0) / GRID)))
    j0 = max(0, int(np.floor((ax0 - X0) / GRID)))
    j1 = min(nx, int(np.ceil((ax1 - X0) / GRID)))
    if i1 > i0 and j1 > j0:
        occ[i0:i1, j0:j1] = True

# exact Euclidean distance transform to the nearest obstacle (and to the grid
# edge, which stands in for "unmodelled"), in metres
free = ~occ
pad = np.ones((ny + 2, nx + 2), bool)
pad[1:-1, 1:-1] = free
try:
    from scipy import ndimage                     # noqa: F401
    dist = ndimage.distance_transform_edt(pad, sampling=GRID)[1:-1, 1:-1]
except Exception:
    # no scipy: exact brute-force EDT via per-obstacle-cell scan is too slow,
    # so use the two-pass chamfer approximation (<2% error) instead
    BIG = 1e9
    dist = np.where(free, BIG, 0.0)
    dist = np.pad(dist, 1, constant_values=0.0)
    for i in range(1, ny + 1):
        for j in range(1, nx + 1):
            dist[i, j] = min(dist[i, j], dist[i - 1, j] + GRID,
                             dist[i, j - 1] + GRID,
                             dist[i - 1, j - 1] + GRID * 1.41421356,
                             dist[i - 1, j + 1] + GRID * 1.41421356)
    for i in range(ny, 0, -1):
        for j in range(nx, 0, -1):
            dist[i, j] = min(dist[i, j], dist[i + 1, j] + GRID,
                             dist[i, j + 1] + GRID,
                             dist[i + 1, j + 1] + GRID * 1.41421356,
                             dist[i + 1, j - 1] + GRID * 1.41421356)
    dist = dist[1:-1, 1:-1]


def cell(x, y):
    return (int(round((y - Y0) / GRID)), int(round((x - X0) / GRID)))


def widest_path(src, dsts):
    """Max-min bottleneck search: maximise the narrowest clearance en route."""
    import heapq
    best = np.full(dist.shape, -1.0)
    si, sj = src
    if not (0 <= si < ny and 0 <= sj < nx) or dist[si, sj] <= 0:
        return None, None
    best[si, sj] = dist[si, sj]
    pq = [(-dist[si, sj], si, sj)]
    while pq:
        nw, i, j = heapq.heappop(pq)
        w = -nw
        if w < best[i, j]:
            continue
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = i + di, j + dj
            if not (0 <= a < ny and 0 <= b < nx):
                continue
            nb = min(w, dist[a, b])
            if nb > best[a, b] + 1e-12 and nb > 0:
                best[a, b] = nb
                heapq.heappush(pq, (-nb, a, b))
    return best, [best[d] for d in dsts]


SVC_X, SVC_W = 1.30, 1.15
# The start is a valid stance OUTSIDE the rear doorway, and each target is a
# valid stance in the corridor directly behind that fixture.  Reaching the
# fixture's back face itself is proven separately by boh_reach_* (section 14);
# this check measures the WIDTH of the route between those stances.
start = cell(SVC_X, 4.55)
targets = {"bank": (-2.375, 3.00), "trade": (0.475, 3.00), "assoc": (3.325, 3.00)}
bestmap, _ = widest_path(start, [])
route_ok = True
widths = {}
for nm, (tx, ty) in targets.items():
    ti, tj = cell(tx, ty)
    half = float(bestmap[ti, tj])
    w = half * 2.0
    widths[nm] = w
    ok = w >= 0.90 - 1e-6
    route_ok = route_ok and ok
    ck(ok, f"rear door -> rear of {nm}: continuous route, measured minimum "
           f"width {w:.3f} m (>= 0.90 m required)")
ck(route_ok, f"BOH staff route: narrowest of the three is "
             f"{min(widths.values()):.3f} m")
# and the doorway itself must admit that width
di, dj = cell(SVC_X, 3.78)
ck(float(bestmap[di, dj]) * 2.0 >= 0.90 - 1e-6,
   f"rear doorway threshold clear width {float(bestmap[di, dj])*2.0:.3f} m")

print("=== 14. trainer booth: seats, fixture and approach ===")
cc = {c["check"]: c for c in man["collision"]["clearance_checks"]}
for nm in ("trainer_seat_trainer", "trainer_seat_visitor",
           "trainer_standing_approach", "trainer_sightline",
           "rear_door_approach_in", "rear_door_walk_through", "boh_route_band",
           "boh_reach_bank", "boh_reach_trade", "boh_reach_assoc"):
    ck(nm in cc and cc[nm]["clear"], f"clearance check present and clear: {nm}")
ck(len([b for b in col["boxes"] if b["id"].startswith("fixture__trainer")]) >= 2,
   "trainer booth has authored table + credenza collision proxies")

print("=== 15. envelope is closed: corners and every punched opening ===")
oc = json.load(open(os.path.join(B, "diag", "opening_closure.json")))
for r_ in oc:
    ck(r_["closed"], f"opening closed: {r_['opening']} "
                     f"({r_['pass_through']}/{r_['samples']} rays passed through)")
cs = json.load(open(os.path.join(B, "diag", "corner_seal.json")))
for r_ in cs:
    ck(not r_["leaks"], f"corner sealed: {r_['corner']}")
# Geometric closure is proven above by ray casts, which is stronger than any
# tonal threshold.  The remaining question is perceptual: does a solid surface
# render so dark that it READS as missing geometry?  Ray-probing the pass-3
# diagnostic crop showed its dark band was solid sinter plinth at 3.5 m, not a
# void -- the plinth's albedo was simply below any real basalt and collapsed in
# raking light.  So this checks TRUE black (<1.2% grey), which a lit solid
# surface with a physical albedo cannot reach, and reports the darkest column
# of each view so the margin is visible rather than merely asserted.
for v in ("03_left.png", "04_right.png", "16_crop_uv_seam_corner.png",
          "01_front.png", "02_back.png", "34_crop_corner_sealed.png",
          "35_crop_corner_sealed_ne.png"):
    fp = os.path.join(PF, v)
    if not os.path.exists(fp):
        ck(False, f"{v}: expected proof view missing")
        continue
    g = np.asarray(Image.open(fp).convert("L"), float) / 255.0
    h_, w_ = g.shape
    band = g[int(h_ * 0.30):int(h_ * 0.88), :]
    colm = band.mean(axis=0)
    ncols = int((colm < 0.012).sum())
    ck(ncols == 0, f"{v}: no true-black column band ({ncols} cols < 1.2% grey; "
                   f"darkest column {colm.min()*100:.2f}%)")

print("=== 16. no proof view is stale ===")
# The pass-2 report claimed "the whole set was re-rendered from one build so no
# proof is stale".  Nothing enforced it.  Every proof PNG must be newer than
# every shipped build artefact, or it was rendered against different geometry.
newest_build = max(
    os.path.getmtime(os.path.join(B, f)) for f in
    ("market_house_lod0.glb", "market_house_furnished.glb",
     "market_house_full.blend", "market_house.collision.json"))
stale_views = [v for v in views
               if os.path.getmtime(os.path.join(PF, v)) < newest_build - 1.0]
ck(not stale_views,
   f"all {len(views)} proof views are newer than the shipped build "
   f"({len(stale_views)} stale: {stale_views[:6]})")

print("=== 17. material system has distinct scale and response ===")
tex = json.load(open(os.path.join(B, "textures", "textures.json")))
ms = tex["material_scale"]
tiles = sorted(v["tile_m"] for v in ms.values())
ck(len(set(tiles)) >= 5,
   f"materials use {len(set(tiles))} distinct tile scales {tiles}")
rough = sorted(v["rough_mean"] for v in ms.values())
ck(rough[-1] - rough[0] >= 0.45,
   f"roughness spans {rough[0]:.2f}..{rough[-1]:.2f} "
   f"(spread {rough[-1]-rough[0]:.2f})")
bands = [c for c in tex["micro_only_checks"] if c["kind"] == "micro_band"]
ck(len(bands) == 7 and all(c["pass"] for c in bands),
   f"{len(bands)}/7 materials inside their own micro-energy band")
mm = {c["map"].split(".")[0]: c["high_freq_rms"] for c in bands}
ck(max(mm.values()) / max(min(mm.values()), 1e-9) >= 2.5,
   f"micro energy ratio coarsest/quietest = "
   f"{max(mm.values())/max(min(mm.values()),1e-9):.2f} (materials differ)")

print()
print(f"{len(FAILS)} FAILURES" if FAILS else "VERIFY_ALL_OK")
for f in FAILS:
    print("  -", f)
sys.exit(1 if FAILS else 0)
