"""Measure what each shipped apparel item encloses, and write the manifest masks.

Hiding skin under a garment is only safe where the garment really is over that
skin. Deciding that from an item's group name would hide a tank top's chest and
punch a hole through its own neckline, so it is measured instead -- on both
promoted bodies, in the bind pose and in every pose of `pose_probe.POSES`, with
the garment skinned by the same joint matrices as the body.

Per skin sample (barycentric points over every `BodyZone_*` triangle, weighted by
area):

  * `find_nearest` inside `NEAR_LIMIT` first. Nothing further away can be covered
    by either test below, and this prunes most of the body for a glove or a
    helmet;
  * an outward CONE of rays up to `REACH_OUT`. Fabric directly over the skin
    blocks nearly the whole cone, while skin at a neckline, cuff, hem or armhole
    keeps most of it -- so the cone is what separates "enclosed" from "exposed",
    instead of one fragile ray;
  * one INWARD ray up to `REACH_IN`. Skin that has pushed through the fabric is
    outside it, so no outward ray finds anything -- yet that skin is exactly the
    poke-through a mask exists to remove. The inward ray keeps a penetrating
    sample counted as covered.

`REACH_OUT` is deliberately short. A garment that floats centimetres off the skin
cannot produce poke-through, and hiding skin behind it would show the world
through the gap, so "loosely draped over" must NOT read as covered.

A zone is hidden only when, on BOTH bodies and in EVERY pose, essentially all of
its area is enclosed (`COVER_FRACTION`) and the exposed remainder is too small to
read as skin (`EXPOSED_LIMIT_CM2`).

The measurement is then promoted into `equipment/manifest.json` as each item's
`hideBodyZones`, together with `glbFemale` for the items that ship an authored
female variant. Both runtimes read exactly those two keys, so the masks are inert
until they are written; this step is what makes them live. Rewriting the manifest
is deterministic: keys keep their authored order, arrays are canonical-order, and
an item that encloses nothing has the key removed rather than set to `[]`.

    blender --background --python body_zone_coverage.py
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

import numpy as np
from mathutils.bvhtree import BVHTree

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zones as BZ  # noqa: E402
import pose_probe as POSE  # noqa: E402
import refit_config as CFG  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/body_zone_coverage.py"

#: Nothing further than this from the garment can be covered by either test, so
#: it is the one cheap query that prunes the body down to the garment.
NEAR_LIMIT = 0.030
#: How far above the skin fabric still counts as covering it. Snug cloth sits at
#: 1.5-2.5 mm and padded shells at 10-15 mm; 30 mm keeps those and rejects a
#: skirt or a coat tail hanging off the leg.
REACH_OUT = 0.030
#: How far the fabric may be INSIDE the skin and still count. This is the
#: poke-through depth the masks are being authored to hide.
REACH_IN = 0.015
#: Fabric this close is in CONTACT with the skin, and contact is coverage whatever
#: the rays say. Rays are unreliable exactly here: at a hard-folded ankle the
#: shell lands flush on the skin, so the outward cone starts on the surface it is
#: looking for and the inward ray has nothing ahead of it. Without this the boot
#: measured 0.977 of the foot enclosed in `meditate_loop` while sitting directly
#: on it. 4 mm is below any gap a viewer could see through.
CONTACT_M = 0.004
#: Outward cone: 9 rays inside 35 degrees of the normal. Wide enough that a
#: garment edge fails, tight enough that snug fabric passes.
CONE_RAYS = 9
CONE_HALF_ANGLE_DEG = 35.0
#: 7 of 9. Two rays may legitimately escape where the surface curves away.
CONE_HIT_FRACTION = 7.0 / 9.0

#: Barycentric sample pattern per triangle: centroid, three near-corner and
#: three near-edge points. Fixed, so a re-run measures the same points.
SAMPLE_BARYCENTRIC = np.array([
    (1 / 3, 1 / 3, 1 / 3),
    (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6),
    (0.1, 0.45, 0.45), (0.45, 0.1, 0.45), (0.45, 0.45, 0.1),
])

#: A zone is hidden only if this fraction of its area is enclosed in the worst
#: pose on the worst body...
COVER_FRACTION = 0.99
#: ...and the exposed remainder stays under this. 12 cm2 is a 3.5 cm square. The
#: residue on a genuinely enclosing garment is slivers along its own seams -- the
#: authored bodysuit measures 7 cm2 of torso and 9 cm2 of pelvis across every
#: pose -- while a garment that actually leaves skin out leaves it by hundreds of
#: cm2: a tank top's neckline and armholes alone expose most of the chest. So the
#: gap between "sliver" and "opening" is two orders of magnitude wide, and this
#: sits in the middle of it rather than on either edge.
EXPOSED_LIMIT_CM2 = 12.0

#: An item whose GLB carries no skinned mesh is never attached by the runtime's
#: skinned-equipment path (`attachEquipmentItemToBody` collects `SkinnedMesh`
#: only, and these carry no `rigidAnchorBone` to take the rigid route). It covers
#: nothing because it is not on the pawn at all.
UNATTACHED_REASON = ("no skinned mesh and no rigidAnchorBone: the runtime "
                     "attaches nothing, so it encloses no skin")

#: Female variants live under this prefix and are named by `glbFemale`. Both
#: runtimes resolve the key relative to the equipment directory.
FEMALE_PREFIX = "Female"


def sha256_file(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def cone_directions(normals: np.ndarray) -> np.ndarray:
    """`CONE_RAYS` deterministic directions inside the cone around each normal."""
    index = np.arange(CONE_RAYS, dtype=np.float64) + 0.5
    limit = np.radians(CONE_HALF_ANGLE_DEG)
    # Fibonacci lattice on the spherical cap: fixed, seedless, machine-stable.
    cosine = 1.0 - (index / CONE_RAYS) * (1.0 - np.cos(limit))
    radius = np.sqrt(np.maximum(0.0, 1.0 - cosine ** 2))
    theta = np.pi * (1.0 + 5.0 ** 0.5) * index
    local = np.stack([radius * np.cos(theta), radius * np.sin(theta), cosine], axis=1)

    sign = np.where(normals[:, 2] >= 0.0, 1.0, -1.0)
    a = -1.0 / (sign + normals[:, 2])
    b = normals[:, 0] * normals[:, 1] * a
    tangent = np.stack([1.0 + sign * normals[:, 0] ** 2 * a, sign * b,
                        -sign * normals[:, 0]], axis=1)
    bitangent = np.stack([b, sign + normals[:, 1] ** 2 * a, -normals[:, 1]], axis=1)
    return (tangent[:, None, :] * local[None, :, 0:1]
            + bitangent[:, None, :] * local[None, :, 1:2]
            + normals[:, None, :] * local[None, :, 2:3])


def zone_samples(posed: np.ndarray, faces: np.ndarray):
    """Barycentric sample points, their outward normals and their areas."""
    corners = posed[faces]
    area = 0.5 * np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0],
                                         corners[:, 2] - corners[:, 0]), axis=1)
    normal = POSE.outward_normals(posed, faces)
    points = np.einsum("sb,fbc->fsc", SAMPLE_BARYCENTRIC, corners)
    count = len(SAMPLE_BARYCENTRIC)
    return (points.reshape(-1, 3), np.repeat(normal, count, axis=0),
            np.repeat(area / count, count))


def covered_mask(points: np.ndarray, normals: np.ndarray,
                 tree: BVHTree) -> np.ndarray:
    """Which samples the garment encloses."""
    out = np.zeros(len(points), dtype=bool)
    distance = np.fromiter(
        (nearest[3] if (nearest := tree.find_nearest(tuple(point), NEAR_LIMIT))[0]
         is not None else np.inf for point in points),
        dtype=np.float64, count=len(points))
    out |= distance <= CONTACT_M
    candidates = np.flatnonzero(np.isfinite(distance) & ~out)
    if not len(candidates):
        return out
    cone = cone_directions(normals[candidates])
    needed = int(np.ceil(CONE_HIT_FRACTION * CONE_RAYS))
    for slot, sample in enumerate(candidates):
        origin = tuple(points[sample])
        if tree.ray_cast(origin, tuple(-normals[sample]), REACH_IN)[0] is not None:
            out[sample] = True                      # fabric is inside the skin
            continue
        hits = 0
        for ray in range(CONE_RAYS):
            if tree.ray_cast(origin, tuple(cone[slot, ray]), REACH_OUT)[0] is not None:
                hits += 1
                if hits >= needed:
                    out[sample] = True
                    break
    return out


def probe(item: POSE.SkinnedGeometry, body: POSE.Body) -> dict:
    """Per-zone covered fraction and exposed area, keeping the worst pose."""
    zones = {zone: {"covered_fraction": 1.0, "exposed_cm2": 0.0, "area_cm2": 0.0,
                    "worst_pose": None} for zone in BZ.ZONES}
    for clip, phase in body.poses():
        world, skin = body.pose(clip, phase)
        garment = item.posed(world)
        tree = BVHTree.FromPolygons([tuple(point) for point in garment],
                                    [tuple(face) for face in item.faces],
                                    all_triangles=True, epsilon=0.0)
        low = garment.min(axis=0) - NEAR_LIMIT
        high = garment.max(axis=0) + NEAR_LIMIT
        label = "bind" if clip is None else f"{clip}@{phase:g}"
        for zone, faces in body.zone_faces.items():
            points, normals, areas = zone_samples(skin, faces)
            total = float(areas.sum())
            inside = ((points >= low) & (points <= high)).all(axis=1)
            covered = np.zeros(len(points), dtype=bool)
            if inside.any():
                covered[inside] = covered_mask(points[inside], normals[inside], tree)
            hidden_area = float(areas[covered].sum())
            fraction = hidden_area / total if total > 0.0 else 1.0
            record = zones[zone]
            record["area_cm2"] = round(total * 1.0e4, 3)
            if record["worst_pose"] is None or fraction < record["covered_fraction"]:
                record.update(covered_fraction=round(fraction, 5),
                              exposed_cm2=round((total - hidden_area) * 1.0e4, 3),
                              worst_pose=label)
    return zones


def hidden_zones(measurement: dict[str, dict]) -> list[str]:
    """Zones enclosed on every body in every pose, by the thresholds above."""
    return [zone for zone in BZ.ZONES
            if all(body[zone]["covered_fraction"] >= COVER_FRACTION
                   and body[zone]["exposed_cm2"] <= EXPOSED_LIMIT_CM2
                   for body in measurement.values())]


def female_variant(entry: dict) -> str | None:
    """The authored female GLB for an item, when one is on disk."""
    relative = f"{FEMALE_PREFIX}/{entry['glb']}"
    return relative if os.path.exists(
        os.path.normpath(os.path.join(CFG.EQUIPMENT, relative))) else None


def promote_manifest(manifest: dict,
                     decisions: dict[str, dict]) -> tuple[dict, list[str]]:
    """Write `hideBodyZones` and `glbFemale` back onto the authored manifest.

    Authored key order is preserved and the two managed keys are appended in a
    fixed place, so a re-run with the same measurement is a byte-identical file.
    An item that encloses nothing loses the key entirely: both runtimes treat
    absent and empty the same way, and an empty array only invites the reader to
    wonder which it meant.

    Both managed keys are dropped before being rewritten, so the result depends
    only on the measurement and never on what the manifest happened to say when
    the run started -- two runs on the same assets are the same bytes.
    """
    out = json.loads(json.dumps(manifest))
    managed = []
    for entry in out["items"]:
        decision = decisions[entry["id"]]
        entry.pop("hideBodyZones", None)
        entry.pop("glbFemale", None)
        variant = decision["glb_female"]
        if variant:
            # Beside `glb`, so a reader sees both meshes together.
            rebuilt = {}
            for key, value in entry.items():
                rebuilt[key] = value
                if key == "glb":
                    rebuilt["glbFemale"] = variant
            entry.clear()
            entry.update(rebuilt)
        if decision["hide_body_zones"]:
            entry["hideBodyZones"] = list(decision["hide_body_zones"])
        if entry.get("hideBodyZones") or entry.get("glbFemale"):
            managed.append(entry["id"])
    return out, managed


def main() -> None:
    CFG.ensure_dirs()
    manifest_path = os.path.join(CFG.EQUIPMENT, "manifest.json")
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    bodies = {body_id: POSE.Body(body_id) for body_id in CFG.RUNTIME_BODY}
    report = {
        "generator": GENERATOR,
        "policy": {"near_limit_m": NEAR_LIMIT, "reach_out_m": REACH_OUT,
                   "reach_in_m": REACH_IN, "cone_rays": CONE_RAYS,
                   "cone_half_angle_deg": CONE_HALF_ANGLE_DEG,
                   "cone_hit_fraction": round(CONE_HIT_FRACTION, 4),
                   "samples_per_triangle": len(SAMPLE_BARYCENTRIC),
                   "cover_fraction": COVER_FRACTION,
                   "exposed_limit_cm2": EXPOSED_LIMIT_CM2},
        "poses": [{"clip": clip, "phase": phase} for clip, phase in POSE.POSES],
        "bodies": {body_id: {"path": os.path.relpath(CFG.RUNTIME_BODY[body_id], CFG.REPO),
                             "sha256": sha256_file(CFG.RUNTIME_BODY[body_id])}
                   for body_id in bodies},
        "items": {},
    }
    for entry in manifest["items"]:
        path = os.path.normpath(os.path.join(CFG.EQUIPMENT, entry["glb"]))
        variant = female_variant(entry)
        # The female body is probed against the FEMALE mesh when one ships. Using
        # the male mesh for both would measure a garment the female pawn never
        # wears, and would report the male fit as the female's coverage.
        geometry = {"male": POSE.SkinnedGeometry(path, entry["id"])}
        geometry["female"] = (
            POSE.SkinnedGeometry(os.path.normpath(os.path.join(CFG.EQUIPMENT, variant)),
                                 f"{entry['id']}:female")
            if variant else geometry["male"])
        record = {"glb": entry["glb"], "group": entry.get("group"),
                  "layer": entry.get("layer"), "slot": entry.get("slot"),
                  "sha256": sha256_file(path),
                  "glb_female": variant,
                  "glb_female_sha256": sha256_file(
                      os.path.normpath(os.path.join(CFG.EQUIPMENT, variant)))
                  if variant else None}
        if not geometry["male"].skinned:
            record.update(attached=False, reason=UNATTACHED_REASON,
                          hide_body_zones=[], measurement={})
        else:
            measurement = {body_id: probe(geometry[body_id], body)
                           for body_id, body in bodies.items()}
            record.update(attached=True,
                          garment_triangles=int(len(geometry["male"].faces)),
                          female_garment_triangles=int(len(geometry["female"].faces)),
                          measurement=measurement,
                          hide_body_zones=hidden_zones(measurement))
        report["items"][entry["id"]] = record
        print(f"[coverage] {entry['id']:32s}"
              f"{' F' if record['glb_female'] else '  '} -> "
              f"{record['hide_body_zones']}")

    promoted, managed = promote_manifest(manifest, report["items"])
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(promoted, handle, indent=1, ensure_ascii=False)
        handle.write("\n")
    report["manifest"] = {
        "path": os.path.relpath(manifest_path, CFG.REPO),
        "sha256": sha256_file(manifest_path),
        "managed_items": managed,
        "items_with_coverage": sum(1 for item in report["items"].values()
                                   if item["hide_body_zones"]),
        "items_with_female_variant": sum(1 for item in report["items"].values()
                                         if item["glb_female"]),
    }
    destination = os.path.join(CFG.REPORT_DIR, "body_zone_coverage.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1)
        handle.write("\n")
    print(f"[coverage] {len(report['items'])} items, "
          f"{report['manifest']['items_with_coverage']} with coverage, "
          f"{report['manifest']['items_with_female_variant']} with a female variant "
          f"-> {report['manifest']['path']}")


if __name__ == "__main__":
    main()
