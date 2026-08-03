"""Reduce the female body's rear pelvis projection, locally and measurably.

The approved female source is `rbf_v3_anim.glb`. Its NAME suggests a
posterior-reduction pass, but the geometry says otherwise. Face is +z, so rear is
-z, and the rear-most skin measures:

    z = -0.0670   pawn_female.glb as shipped at branch base 37da18de
    z = -0.0893   humanoid-lab/pawn_female_latest.glb (the previous promotion input)
    z = -0.0938   rbf_v3_anim.glb  <-- deepest of the three
    z = -0.0966   rb_v4_anim.glb (male, for scale)

on the glute band (y 0.86-1.02). `compare_female_sources.py` measures v2 against
v3 directly: they are identical through the pelvis, and v3 only re-partitions the
head and face. So the reduction does not exist in the source, and this step
applies it as an explicit, reviewable correction instead of pretending it does.

The correction is restrained and local by construction. Vertices move along +z
ONLY -- never in x or y -- so stature, waist and hip width, and every joint's
rest position are untouched by definition rather than by inspection, and nothing
in front of the body can move at all. The displacement is the product of four
smooth gates:

  * `height`   -- fades in above the under-buttock crease and out below the
                  lumbar curve, so neither the thigh transition nor the low back
                  is redrawn;
  * `lateral`  -- confined to the buttock mass; zero by the hip's outer edge, so
                  the hip silhouette and the seat's widest point keep their
                  width;
  * `depth`    -- proportional to how far the surface actually protrudes, so the
                  reduction lands on the projection itself and not on the
                  surrounding form;
  * `pelvis weight` -- the vertex's own pelvis skin share, so wherever the thigh
                  or the spine already owns the deformation the correction has
                  already faded to nothing.

Skin weights, joint indices, inverse binds, node rest transforms, animation data,
UVs, vertex colours, material assignments, topology and vertex order all pass
through untouched. Normals are carried, not rebuilt: the authored set is only
partly smooth (a quarter of it matches area-weighted welded normals exactly), so
rebuilding it would restyle the whole body's shading. Instead each normal is
turned by the amount the surface under it turned, which is exactly zero outside
the corrected region.

    blender --background --python reduce_female_posterior.py
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

import numpy as np

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zones as BZ  # noqa: E402
import refit_config as CFG  # noqa: E402
from gltf_io import Glb, GlbBuilder, TARGET_ARRAY_BUFFER  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/reduce_female_posterior.py"

#: Peak inward move, at the apex of the seat. Sized to land the glute band at
#: about -79 mm: below the previous promotion input (-89.3 mm) and well below the
#: male (-96.6 mm), while staying fuller than the branch-base body (-67.0 mm).
#: Restraint is the point -- this is a silhouette correction, not a reshape.
PEAK_M = 0.0150

#: Height gate, in metres of bind-pose y. Ramps in across the under-buttock
#: crease, holds over the seat, ramps out under the lumbar curve.
HEIGHT_IN = (0.845, 0.900)
HEIGHT_OUT = (1.000, 1.060)
#: Lateral gate: full over the buttock mass, gone by the hip's outer edge.
LATERAL_HOLD = 0.075
LATERAL_OUT = 0.115
#: Depth gate: the correction scales with how far the surface protrudes, from
#: nothing at 45 mm behind the rig axis to full at 70 mm.
DEPTH_IN = (-0.045, -0.070)

#: The band the reduction is judged on, matching the measurements above.
GLUTE_BAND = (0.86, 1.02)
#: The two centre-body bands the v2/v3 audit reports, so the before/after here is
#: directly comparable to it.
AUDIT_BANDS = ((0.85, 0.95), (0.95, 1.05))

BUILD_SUBDIR = "female_posterior"


def sha256_file(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def smoothstep(value: np.ndarray, low: float, high: float) -> np.ndarray:
    """0 below `low`, 1 above `high`, C1 in between (works for high < low)."""
    t = np.clip((value - low) / (high - low), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def skin_soup(glb: Glb):
    """Positions, normals, faces and per-vertex zone shares of the whole mesh."""
    joint_names = [glb.json["nodes"][index].get("name", "")
                   for index in glb.json["skins"][0]["joints"]]
    positions, normals, joints, weights, faces = [], [], [], [], []
    base = 0
    for primitive in glb.json["meshes"][0]["primitives"]:
        attributes = primitive["attributes"]
        position = glb.accessor(attributes["POSITION"]).astype(np.float64)
        positions.append(position)
        normals.append(glb.accessor(attributes["NORMAL"]).astype(np.float64))
        joints.append(glb.accessor(attributes["JOINTS_0"]).astype(np.int64))
        weights.append(glb.accessor(attributes["WEIGHTS_0"]).astype(np.float64))
        faces.append(glb.accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3)
                     + base)
        base += len(position)
    weight = np.concatenate(weights)
    weight = weight / weight.sum(axis=1, keepdims=True)
    shares = BZ.zone_shares(joint_names, np.concatenate(joints), weight)
    return (np.concatenate(positions), np.concatenate(normals),
            np.concatenate(faces), shares)


def welded_normals(position: np.ndarray, faces: np.ndarray,
                   welded: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals over the welded surface, per source vertex."""
    a, b, c = position[faces[:, 0]], position[faces[:, 1]], position[faces[:, 2]]
    face_normal = np.cross(b - a, c - a)
    accumulated = np.zeros((int(welded.max()) + 1, 3))
    for corner in range(3):
        np.add.at(accumulated, welded[faces[:, corner]], face_normal)
    length = np.linalg.norm(accumulated, axis=1, keepdims=True)
    return (accumulated / np.where(length > 1e-20, length, 1.0))[welded]


def displacement(position: np.ndarray, shares: np.ndarray) -> np.ndarray:
    """Per-vertex +z move: peak x height x lateral x depth x pelvis share."""
    height = (smoothstep(position[:, 1], *HEIGHT_IN)
              * (1.0 - smoothstep(position[:, 1], *HEIGHT_OUT)))
    lateral = 1.0 - smoothstep(np.abs(position[:, 0]), LATERAL_HOLD, LATERAL_OUT)
    depth = smoothstep(position[:, 2], *DEPTH_IN)
    pelvis = shares[:, BZ.ZONE_INDEX["pelvis"]]
    return PEAK_M * height * lateral * depth * pelvis


def band_rear(position: np.ndarray, band: tuple[float, float]) -> float:
    inside = (position[:, 1] >= band[0]) & (position[:, 1] < band[1])
    return float(position[inside, 2].min())


def measure(before: np.ndarray, after: np.ndarray, move: np.ndarray) -> dict:
    moved = move > 1.0e-6
    return {
        "glute_band_y_m": list(GLUTE_BAND),
        "rear_projection_before_mm": round(band_rear(before, GLUTE_BAND) * 1000.0, 3),
        "rear_projection_after_mm": round(band_rear(after, GLUTE_BAND) * 1000.0, 3),
        # Rear z is negative, so a shallower silhouette is a LARGER z.
        "reduction_mm": round((band_rear(after, GLUTE_BAND)
                               - band_rear(before, GLUTE_BAND)) * 1000.0, 3),
        "audit_bands_mm": [
            {"y_m": list(band),
             "before": round(band_rear(before, band) * 1000.0, 3),
             "after": round(band_rear(after, band) * 1000.0, 3),
             "reduction": round((band_rear(after, band)
                                 - band_rear(before, band)) * 1000.0, 3)}
            for band in AUDIT_BANDS],
        "vertices_moved": int(moved.sum()),
        "vertices_total": int(len(move)),
        "max_move_mm": round(float(move.max()) * 1000.0, 3),
        "mean_move_moved_mm": (round(float(move[moved].mean()) * 1000.0, 3)
                               if moved.any() else 0.0),
        "height_span_moved_m": ([round(float(before[moved, 1].min()), 4),
                                 round(float(before[moved, 1].max()), 4)]
                                if moved.any() else []),
        "abs_x_span_moved_m": ([round(float(np.abs(before[moved, 0]).min()), 4),
                                round(float(np.abs(before[moved, 0]).max()), 4)]
                               if moved.any() else []),
        "stature_delta_mm": round(float(after[:, 1].max() - before[:, 1].max())
                                  * 1000.0, 6),
        "hip_width_delta_mm": round(float(np.abs(after[:, 0]).max()
                                          - np.abs(before[:, 0]).max()) * 1000.0, 6),
        "front_silhouette_delta_mm": round(float(after[:, 2].max()
                                                 - before[:, 2].max()) * 1000.0, 6),
    }


def rear_profile(position: np.ndarray) -> list[list[float]]:
    """Rear silhouette: rear-most z per 1 cm height slice, in millimetres."""
    out = []
    for step in range(70, 116):
        low, high = step / 100.0, (step + 1) / 100.0
        inside = ((position[:, 1] >= low) & (position[:, 1] < high)
                  & (position[:, 2] < 0.0))
        if inside.any():
            out.append([round(low, 2),
                        round(float(position[inside, 2].min()) * 1000.0, 2)])
    return out


def rebuild(glb: Glb, position: np.ndarray, normal: np.ndarray,
            destination: str) -> int:
    """Copy the GLB through, replacing only POSITION and NORMAL."""
    builder = GlbBuilder(json.loads(json.dumps(glb.json)))
    replaced = {}
    cursor = 0
    for primitive in glb.json["meshes"][0]["primitives"]:
        count = glb.json["accessors"][primitive["attributes"]["POSITION"]]["count"]
        replaced[primitive["attributes"]["POSITION"]] = (
            position[cursor: cursor + count].astype(np.float32), True)
        replaced[primitive["attributes"]["NORMAL"]] = (
            normal[cursor: cursor + count].astype(np.float32), False)
        cursor += count

    remap = {}
    for index, accessor in enumerate(glb.json["accessors"]):
        if index in replaced:
            array, minmax = replaced[index]
            remap[index] = builder.add_accessor(array, target=TARGET_ARRAY_BUFFER,
                                                minmax=minmax)
            continue
        payload, stride = glb.buffer_view_bytes(accessor["bufferView"])
        entry = dict(accessor)
        entry["byteOffset"] = 0
        entry["bufferView"] = builder.add_view(
            payload[accessor.get("byteOffset", 0):],
            target=glb.json["bufferViews"][accessor["bufferView"]].get("target"),
            stride=stride)
        builder.json["accessors"].append(entry)
        remap[index] = len(builder.json["accessors"]) - 1

    for mesh in builder.json["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["attributes"] = {name: remap[index] for name, index
                                       in primitive["attributes"].items()}
            if "indices" in primitive:
                primitive["indices"] = remap[primitive["indices"]]
    for skin in builder.json.get("skins", ()):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = remap[skin["inverseBindMatrices"]]
    for animation in builder.json.get("animations", ()):
        for sampler in animation["samplers"]:
            sampler["input"] = remap[sampler["input"]]
            sampler["output"] = remap[sampler["output"]]
    builder.json["asset"] = {"version": "2.0", "generator": GENERATOR}
    return builder.write(destination)


def output_path() -> str:
    return os.path.join(CFG.BUILD_DIR, BUILD_SUBDIR, "rbf_v3_reduced.glb")


def report_path() -> str:
    return os.path.join(CFG.REPORT_DIR, "female_posterior.json")


def build(source: str) -> dict:
    glb = Glb.load(source)
    position, normal, faces, shares = skin_soup(glb)
    welded = BZ.weld(position)
    before_normals = welded_normals(position, faces, welded)

    move = displacement(position, shares)
    corrected = position.copy()
    corrected[:, 2] += move
    after_normals = welded_normals(corrected, faces, welded)

    # Turn each authored normal by exactly how much the surface under it turned.
    # Outside the corrected region the two welded fields are identical, so the
    # authored normal is reproduced unchanged.
    turned = normal + (after_normals - before_normals)
    length = np.linalg.norm(turned, axis=1, keepdims=True)
    turned = turned / np.where(length > 1e-12, length, 1.0)

    metrics = measure(position, corrected, move)
    if (metrics["stature_delta_mm"] or metrics["hip_width_delta_mm"]
            or metrics["front_silhouette_delta_mm"]):
        raise SystemExit("posterior reduction touched stature, hip width or the "
                         "front silhouette; the correction is +z only")
    if metrics["reduction_mm"] <= 0.0:
        raise SystemExit("posterior reduction did not reduce the projection")

    destination = output_path()
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    size = rebuild(glb, corrected, turned, destination)
    record = {
        "generator": GENERATOR,
        "source": os.path.relpath(source, CFG.REPO),
        "source_sha256": sha256_file(source),
        "output": os.path.relpath(destination, CFG.REPO),
        "output_sha256": sha256_file(destination),
        "bytes": size,
        "gates": {"peak_m": PEAK_M, "height_in": list(HEIGHT_IN),
                  "height_out": list(HEIGHT_OUT), "lateral_hold_m": LATERAL_HOLD,
                  "lateral_out_m": LATERAL_OUT, "depth_in": list(DEPTH_IN)},
        "metrics": metrics,
        "rear_profile_before_mm": rear_profile(position),
        "rear_profile_after_mm": rear_profile(corrected),
    }
    with open(report_path(), "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2)
    return record


def ensure(source: str) -> str:
    """The reduced female body, rebuilt when missing or stale."""
    destination = output_path()
    recorded = None
    if os.path.exists(report_path()):
        with open(report_path(), encoding="utf-8") as handle:
            recorded = json.load(handle)
    stale = (recorded is None
             or not os.path.exists(destination)
             or recorded.get("generator") != GENERATOR
             or recorded.get("source_sha256") != sha256_file(source)
             or recorded.get("output_sha256") != sha256_file(destination)
             or recorded.get("gates", {}).get("peak_m") != PEAK_M)
    if stale:
        build(source)
    return destination


def main() -> None:
    CFG.ensure_dirs()
    import reference_bodies  # local: only the CLI needs the source hash gate
    record = build(reference_bodies.refined()["female"])
    metrics = record["metrics"]
    print(f"[posterior] glute band rear {metrics['rear_projection_before_mm']:.1f} -> "
          f"{metrics['rear_projection_after_mm']:.1f} mm "
          f"(-{metrics['reduction_mm']:.1f} mm) over "
          f"{metrics['vertices_moved']}/{metrics['vertices_total']} vertices, "
          f"peak move {metrics['max_move_mm']:.1f} mm")
    for band in metrics["audit_bands_mm"]:
        print(f"[posterior] y {band['y_m'][0]:.2f}-{band['y_m'][1]:.2f}: "
              f"{band['before']:.3f} -> {band['after']:.3f} mm "
              f"(-{band['reduction']:.3f})")
    print(f"[posterior] stature {metrics['stature_delta_mm']} mm, hip width "
          f"{metrics['hip_width_delta_mm']} mm, front "
          f"{metrics['front_silhouette_delta_mm']} mm -> {record['output']}")


if __name__ == "__main__":
    main()
