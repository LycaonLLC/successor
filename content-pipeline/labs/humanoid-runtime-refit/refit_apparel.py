"""Refit the whole apparel catalogue onto the promoted humanoid bodies.

Every catalogued piece is skinned to the same 50-joint rig in the same bind
pose, so a refit only moves bind-pose POSITIONS and the normals that follow
them. Joints, weights, indices, UVs, materials and embedded textures are copied
through untouched, which is why a refitted piece still deforms exactly as it was
authored and still satisfies the rig contract by construction.

The promoted bodies are much fuller than the reference mannequins they replace
(the male trunk stands up to 84 mm further forward and 54 mm wider), so the
catalogue does not merely shift -- unrefitted, a tank top's chest and a trouser's
thigh burst straight through the cloth. Three policies, chosen per item:

  soft  -- per-vertex radial displacement, then iterative contact resolution
           relaxed over the garment's own graph. Cloth follows the new silhouette
           and keeps the clearance it was authored with.
  shell -- one similarity transform per connected component, least-squares fitted
           to that component's own displacement, then at most one bounded
           outward nudge. A pauldron or a hip plate keeps its authored thickness
           and hard-surface shape exactly; only placement and overall size move.
  head  -- ONE similarity transform for the whole piece, fitted to how the head
           itself changed. Hair, helmets, hoods, masks and visors are re-seated
           on the new cranium rather than reshaped, so a hair silhouette survives
           intact and its cap keeps exactly the scalp contact it was authored
           with.

Quality is measured as clearance DRIFT, not absolute standoff: a skirt is
supposed to float and a boot lining is supposed to sit inside the ankle, so the
test is whether each vertex kept the gap it had over the reference body.

    python3 refit_apparel.py [item-id ...]
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from typing import Any

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refit_config as CFG  # noqa: E402
import reference_bodies  # noqa: E402
import refit_field as FIELD  # noqa: E402
from gltf_io import (Glb, GlbBuilder, TARGET_ARRAY_BUFFER,  # noqa: E402
                     TARGET_ELEMENT_ARRAY_BUFFER)

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/refit_apparel.py"

FEMALE_SUBDIR = "Female"

#: Authored, not refitted. The two FIXED starter pieces are generated from each
#: body's own skin by `author_starter_apparel.py`, because warping the versions
#: drawn on the old body still left them inside the promoted skin (-1.5/-11.0 mm
#: for the suit, -18.3/-19.0 mm for the boots). Refitting them here would
#: overwrite that authored geometry with the warp it replaced.
AUTHORED_ITEM_IDS = frozenset({"under_bodysuit", "boots_canvas_ankle"})

#: Minimum skin gap after refit, by policy. Soft cloth may sit almost on the
#: skin; hard armour needs room for its own inner face.
CLEARANCE = {"soft": 0.0015, "shell": 0.0025, "head": 0.0015}
#: A vertex this far inside the skin is clipping, not resting on it.
PENETRATION_LIMIT = 0.0010
#: Contact resolution is iterative: pushing one vertex out changes which face is
#: closest to its neighbours, so a single pass leaves creases behind.
CLEARANCE_ITERATIONS = 6
CLEARANCE_EPSILON = 5.0e-5
#: A component may be re-seated and resized; it may not be restyled.
SHELL_SCALE_CLAMP = (0.88, 1.15)
SHELL_NUDGE_LIMIT = 0.020
HEAD_SCALE_CLAMP = (0.85, 1.15)

#: Anything that rides the skull. These are re-seated with the head, never
#: reshaped: a mohawk that follows a per-vertex field stops being a mohawk.
HEAD_GROUPS = {"Hair", "Helmet — bake-off", "Headwear — baseline"}
HEAD_ID_PREFIXES = ("trial_hair", "trial_helm", "trial_visor", "trial_mask",
                    "trial_hood")
#: Hard-surface pieces that sit on the body rather than the skull.
SHELL_ID_PREFIXES = ("armor_", "trial_back", "trial_hip")

#: Female-variant thresholds. The field's own residual against bare skin is
#: ~0.9 mm mean / 2.3 mm p90, so anything at this scale is a real misfit and not
#: measurement noise.
VARIANT_PENETRATION_MM = 4.0
VARIANT_PENETRATION_COUNT = 4
VARIANT_DRIFT_P95_MM = 8.0


def sha256_file(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def policy_for(item: dict) -> str:
    if item.get("group") in HEAD_GROUPS:
        return "head"
    if any(item["id"].startswith(prefix) for prefix in HEAD_ID_PREFIXES):
        return "head"
    if any(item["id"].startswith(prefix) for prefix in SHELL_ID_PREFIXES):
        return "shell"
    return "soft"


# ---------------------------------------------------------------- body setup


def joint_origins(glb: Glb) -> dict[str, np.ndarray]:
    """Bind-pose world origin of every joint, from the inverse bind matrices."""
    skin = glb.json["skins"][0]
    matrices = glb.accessor(skin["inverseBindMatrices"]).astype(np.float64)
    out = {}
    for slot, node in enumerate(skin["joints"]):
        inverse = matrices[slot].reshape(4, 4).T   # glTF matrices are column-major
        out[glb.json["nodes"][node]["name"]] = np.linalg.inv(inverse)[:3, 3]
    return out


def body_geometry(path: str):
    """(surface, resampled body, joint origins)."""
    glb = Glb.load(path)
    joint_names = [glb.json["nodes"][index]["name"]
                   for index in glb.json["skins"][0]["joints"]]
    positions, faces, joints, weights = [], [], [], []
    base = 0
    for primitive in glb.json["meshes"][0]["primitives"]:
        vertex = glb.accessor(primitive["attributes"]["POSITION"]).astype(np.float64)
        positions.append(vertex)
        joints.append(glb.accessor(primitive["attributes"]["JOINTS_0"]).astype(np.int64))
        weights.append(glb.accessor(primitive["attributes"]["WEIGHTS_0"]).astype(np.float64))
        faces.append(glb.accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3) + base)
        base += len(vertex)
    vertices = np.concatenate(positions)
    face_array = np.concatenate(faces)
    shares = FIELD.region_weights(joint_names, np.concatenate(joints),
                                  np.concatenate(weights))
    return (FIELD.Surface(vertices, face_array),
            FIELD.BodySample(vertices, face_array, shares),
            joint_origins(glb))


def head_transform(field: FIELD.DeformationField, sample: FIELD.BodySample):
    """Similarity transform describing how the skull itself changed.

    Head accessories are re-seated with this instead of being warped, so a
    helmet crest or a mohawk ridge survives the refit as authored.
    """
    index = FIELD.REGION_INDEX["head"]
    points, share = FIELD.region_samples(sample, index)
    core = points[share >= 0.5]
    weights = np.zeros((len(core), len(FIELD.REGIONS)))
    weights[:, index] = 1.0
    target = core + field.sample(core, weights)
    scale, rotation, shift = FIELD.umeyama(core, target)
    scale = float(np.clip(scale, *HEAD_SCALE_CLAMP))
    return scale, rotation, shift


def build_fields() -> dict[str, dict]:
    reference_bodies.materialise()
    out = {}
    for body_id in ("male", "female"):
        reference, reference_sample, origins = body_geometry(
            reference_bodies.path_for(body_id))
        target, target_sample, _ = body_geometry(CFG.RUNTIME_BODY[body_id])
        field = FIELD.DeformationField(reference_sample, target_sample, origins)
        # Self-test: carrying the reference skin through the field must land it
        # ON the promoted skin. Residual here is the field's own error and it
        # bounds how well any garment can be refitted.
        moved = reference.vertices + field.sample(reference.vertices,
                                                  reference_sample.vertex_weights)
        _, _, residual = target.closest(moved)
        _, _, raw = target.closest(reference.vertices)
        scale, rotation, shift = head_transform(field, reference_sample)
        out[body_id] = {
            "reference": reference, "target": target, "field": field,
            "head": (scale, rotation, shift),
            "residual_mean_mm": round(float(residual.mean() * 1000), 3),
            "residual_p90_mm": round(float(np.percentile(residual, 90) * 1000), 3),
            "raw_mean_mm": round(float(raw.mean() * 1000), 3),
        }
        print(f"[field] {body_id}: skin gap {raw.mean() * 1000:.2f} -> "
              f"{residual.mean() * 1000:.2f} mm mean, "
              f"{np.percentile(residual, 90) * 1000:.2f} mm p90; "
              f"head scale {scale:.4f}, shift "
              f"{np.round(shift * 1000, 1).tolist()} mm")
    return out


# ---------------------------------------------------------------- item mesh


class ItemMesh:
    """One garment primitive's editable state."""

    def __init__(self, glb: Glb, primitive: dict, joint_names: list[str]):
        attributes = primitive["attributes"]
        self.position = glb.accessor(attributes["POSITION"]).astype(np.float64)
        self.has_normal = "NORMAL" in attributes
        self.faces = (glb.accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3)
                      if "indices" in primitive else
                      np.arange(len(self.position)).reshape(-1, 3))
        if "JOINTS_0" in attributes:
            self.shares = FIELD.region_weights(
                joint_names,
                glb.accessor(attributes["JOINTS_0"]).astype(np.int64),
                glb.accessor(attributes["WEIGHTS_0"]).astype(np.float64))
        else:
            self.shares = None
        key = np.round(self.position, 6)
        _, welded = np.unique(key, axis=0, return_inverse=True)
        self.welded = welded.reshape(-1)
        self.welded_count = int(self.welded.max()) + 1
        self.edge_a, self.edge_b = FIELD.graph_edges(self.faces, self.welded,
                                                     self.welded_count)

    def components(self) -> list[np.ndarray]:
        """Connected shells, by welded position."""
        parent = np.arange(self.welded_count)

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b in zip(self.edge_a, self.edge_b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
        labels = np.array([find(x) for x in range(self.welded_count)])[self.welded]
        return [np.where(labels == root)[0] for root in np.unique(labels)]

    def recompute_normals(self) -> np.ndarray:
        """Area-weighted per-index normals; split vertices keep their hard edges."""
        a = self.position[self.faces[:, 0]]
        b = self.position[self.faces[:, 1]]
        c = self.position[self.faces[:, 2]]
        face_normal = np.cross(b - a, c - a)
        out = np.zeros_like(self.position)
        for column in range(3):
            np.add.at(out, self.faces[:, column], face_normal)
        lengths = np.linalg.norm(out, axis=1, keepdims=True)
        return out / np.where(lengths > 1e-20, lengths, 1.0)


# ---------------------------------------------------------------- fitting


def apply_soft(mesh: ItemMesh, field: FIELD.DeformationField) -> None:
    mesh.position = mesh.position + field.sample(mesh.position, mesh.shares)


def apply_shell(mesh: ItemMesh, field: FIELD.DeformationField,
                components: list[np.ndarray]) -> list[dict]:
    displaced = mesh.position + field.sample(mesh.position, mesh.shares)
    report = []
    for component in components:
        source = mesh.position[component]
        if len(component) < 4:
            mesh.position[component] = displaced[component]
            continue
        scale, rotation, shift = FIELD.umeyama(source, displaced[component])
        scale = float(np.clip(scale, *SHELL_SCALE_CLAMP))
        mesh.position[component] = source @ (scale * rotation).T + shift
        report.append({"vertices": int(len(component)), "scale": round(scale, 4),
                       "shift_mm": [round(float(v) * 1000.0, 2) for v in shift]})
    return report


def apply_head(mesh: ItemMesh, transform) -> None:
    scale, rotation, shift = transform
    mesh.position = mesh.position @ (scale * rotation).T + shift


def soft_clearance(mesh: ItemMesh, surface: FIELD.Surface, minimum: float,
                   before: np.ndarray) -> dict:
    """Push cloth out of the skin, never pull it in, and keep it smooth.

    The target is `min(minimum, before)`, never `minimum` alone. Garments carry
    real interior surfaces -- a boot lining, the inside of a glove finger, the
    hidden back of a strap -- and forcing every vertex outside the skin would
    turn those into balloons. A vertex that was already inside only has to stay
    as deep as it was; a vertex that was clear must stay clear.
    """
    target = np.minimum(minimum, before)
    pushed = 0
    worst = 0.0
    for _ in range(CLEARANCE_ITERATIONS):
        signed, _, direction = surface.signed(mesh.position)
        deficit = np.maximum(0.0, target - signed)
        touching = deficit > CLEARANCE_EPSILON
        if not touching.any():
            break
        pushed = max(pushed, int(touching.sum()))
        worst = max(worst, float(deficit.max()))
        correction = direction * deficit[:, None]
        pooled = np.zeros((mesh.welded_count, 3))
        hits = np.bincount(mesh.welded, minlength=mesh.welded_count).astype(np.float64)
        np.add.at(pooled, mesh.welded, correction)
        pooled /= np.where(hits > 0, hits, 1.0)[:, None]
        pooled = FIELD.relax(pooled, mesh.edge_a, mesh.edge_b, mesh.welded_count,
                             passes=1, weight=0.35)
        smoothed = pooled[mesh.welded]
        # Relaxation spreads the push over neighbours, which is what keeps cloth
        # smooth, but it must not leave the offending vertex short.
        achieved = np.maximum((smoothed * direction).sum(1), 1e-9)
        gain = np.where(touching, np.clip(deficit / achieved, 1.0, 4.0), 1.0)
        mesh.position = mesh.position + smoothed * gain[:, None]
    return {"pushed": pushed, "max_push_mm": round(worst * 1000.0, 3)}


def shell_clearance(mesh: ItemMesh, surface: FIELD.Surface, minimum: float,
                    before: np.ndarray, components: list[np.ndarray]) -> dict:
    """One bounded rigid nudge per shell. Hard surfaces are never re-warped."""
    target = np.minimum(minimum, before)
    signed, _, direction = surface.signed(mesh.position)
    deficit = np.maximum(0.0, target - signed)
    pushed = 0
    worst = 0.0
    for component in components:
        rows = component[deficit[component] > CLEARANCE_EPSILON]
        if len(rows) == 0:
            continue
        pushed += len(rows)
        worst = max(worst, float(deficit[rows].max()))
        weight = deficit[rows]
        axis = (direction[rows] * weight[:, None]).sum(0)
        length = float(np.linalg.norm(axis))
        if length < 1e-12:
            continue
        axis = axis / length
        along = np.maximum((direction[rows] * axis).sum(1), 0.25)
        travel = float(min(SHELL_NUDGE_LIMIT, (deficit[rows] / along).max()))
        mesh.position[component] = mesh.position[component] + axis * travel
    return {"pushed": pushed, "max_push_mm": round(worst * 1000.0, 3)}


def measure(position: np.ndarray, before: np.ndarray,
            surface: FIELD.Surface) -> dict:
    """Fit quality is relative: did each vertex keep the gap it was authored with?"""
    signed, _, _ = surface.signed(position)
    drift = signed - before
    lost = np.maximum(0.0, -drift)
    return {
        "penetrating": int((drift < -PENETRATION_LIMIT).sum()),
        "max_penetration_mm": float(lost.max() * 1000.0),
        "drift_p95_mm": float(np.percentile(np.abs(drift), 95) * 1000.0),
        "drift_max_mm": float(np.abs(drift).max() * 1000.0),
        "clearance_min_mm": float(signed.min() * 1000.0),
        "clearance_mean_mm": float(signed.mean() * 1000.0),
    }


# ---------------------------------------------------------------- export


def rewrite_glb(source: Glb, positions: dict[int, np.ndarray],
                normals: dict[int, np.ndarray], destination: str) -> int:
    """Copy a GLB through, replacing only POSITION and NORMAL."""
    gltf = json.loads(json.dumps({k: v for k, v in source.json.items()
                                  if k not in ("accessors", "bufferViews", "buffers")}))
    gltf["asset"] = {"version": "2.0", "generator": GENERATOR}
    builder = GlbBuilder(gltf)
    cache: dict[int, int] = {}

    def carry(index: int) -> int:
        if index not in cache:
            accessor = source.json["accessors"][index]
            new_index = builder.add_accessor(
                np.ascontiguousarray(source.accessor(index)),
                target=(TARGET_ELEMENT_ARRAY_BUFFER
                        if accessor["type"] == "SCALAR" else TARGET_ARRAY_BUFFER))
            for key in ("min", "max", "normalized", "name"):
                if key in accessor:
                    builder.json["accessors"][new_index][key] = accessor[key]
            cache[index] = new_index
        return cache[index]

    slot = 0
    for mesh in gltf.get("meshes", []):
        for primitive in mesh["primitives"]:
            rebuilt = {}
            for name, accessor_index in primitive["attributes"].items():
                if name == "POSITION" and slot in positions:
                    rebuilt[name] = builder.add_accessor(
                        positions[slot].astype(np.float32),
                        target=TARGET_ARRAY_BUFFER, minmax=True)
                elif name == "NORMAL" and slot in normals:
                    rebuilt[name] = builder.add_accessor(
                        normals[slot].astype(np.float32), target=TARGET_ARRAY_BUFFER)
                else:
                    rebuilt[name] = carry(accessor_index)
            primitive["attributes"] = rebuilt
            if "indices" in primitive:
                primitive["indices"] = carry(primitive["indices"])
            for target in primitive.get("targets", []):
                for name, accessor_index in list(target.items()):
                    target[name] = carry(accessor_index)
            slot += 1
    for skin in gltf.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = carry(skin["inverseBindMatrices"])
    for animation in gltf.get("animations", []):
        for sampler in animation["samplers"]:
            sampler["input"] = carry(sampler["input"])
            sampler["output"] = carry(sampler["output"])
    for image in gltf.get("images", []):
        if "bufferView" in image:
            payload, _ = source.buffer_view_bytes(image["bufferView"])
            image["bufferView"] = builder.add_view(bytes(payload))
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    return builder.write(destination)


# ---------------------------------------------------------------- item pass


def fit(original: Glb, joint_names: list[str], policy: str, body: dict):
    """Run one item through one body's fit. Returns positions/normals/stats."""
    field, reference, target = body["field"], body["reference"], body["target"]
    positions: dict[int, np.ndarray] = {}
    normals: dict[int, np.ndarray] = {}
    stats: list[dict] = []
    shells: list[dict] = []
    slot = 0
    for mesh_json in original.json["meshes"]:
        for primitive in mesh_json["primitives"]:
            mesh = ItemMesh(original, primitive, joint_names)
            start = mesh.position.copy()
            before, _, _ = reference.signed(start)
            if policy == "head":
                apply_head(mesh, body["head"])
                push = {"pushed": 0, "max_push_mm": 0.0}
            elif policy == "shell":
                components = mesh.components()
                shells.extend(apply_shell(mesh, field, components))
                push = shell_clearance(mesh, target, CLEARANCE[policy], before,
                                       components)
            else:
                apply_soft(mesh, field)
                push = soft_clearance(mesh, target, CLEARANCE[policy], before)
            moved = np.linalg.norm(mesh.position - start, axis=1)
            stats.append({**measure(mesh.position, before, target), **push,
                          "vertices": int(len(start)),
                          "moved_mean_mm": float(moved.mean() * 1000.0),
                          "moved_max_mm": float(moved.max() * 1000.0)})
            positions[slot] = mesh.position
            if mesh.has_normal:
                normals[slot] = mesh.recompute_normals()
            slot += 1
    return positions, normals, stats, shells


def cross_check(original: Glb, joint_names: list[str],
                positions: dict[int, np.ndarray], body: dict) -> dict:
    """How does one body's fit read on the other body?"""
    worst = {"penetrating": 0, "max_penetration_mm": 0.0, "drift_p95_mm": 0.0}
    slot = 0
    for mesh_json in original.json["meshes"]:
        for primitive in mesh_json["primitives"]:
            mesh = ItemMesh(original, primitive, joint_names)
            before, _, _ = body["reference"].signed(mesh.position)
            check = measure(positions[slot], before, body["target"])
            worst["penetrating"] += check["penetrating"]
            worst["max_penetration_mm"] = max(worst["max_penetration_mm"],
                                              check["max_penetration_mm"])
            worst["drift_p95_mm"] = max(worst["drift_p95_mm"], check["drift_p95_mm"])
            slot += 1
    return worst


def summarise(stats: list[dict]) -> dict:
    return {
        "moved_mean_mm": round(max(s["moved_mean_mm"] for s in stats), 3),
        "moved_max_mm": round(max(s["moved_max_mm"] for s in stats), 3),
        "penetrating": int(sum(s["penetrating"] for s in stats)),
        "max_penetration_mm": round(max(s["max_penetration_mm"] for s in stats), 3),
        "drift_p95_mm": round(max(s["drift_p95_mm"] for s in stats), 3),
        "clearance_min_mm": round(min(s["clearance_min_mm"] for s in stats), 3),
        "pushed": int(sum(s["pushed"] for s in stats)),
        "max_push_mm": round(max(s["max_push_mm"] for s in stats), 3),
    }


def refit_one(item: dict, bodies: dict, source_path: str, original: Glb) -> dict:
    policy = policy_for(item)
    joint_names = ([original.json["nodes"][i]["name"]
                    for i in original.json["skins"][0]["joints"]]
                   if original.json.get("skins") else [])
    record: dict[str, Any] = {
        "id": item["id"], "group": item["group"], "layer": item["layer"],
        "slot": item["slot"], "glb": item["glb"], "policy": policy,
        "skinned": bool(original.json.get("skins")),
        "source_sha256": sha256_file(source_path),
    }
    if not joint_names:
        record.update({"decision": "not_applicable",
                       "reason": "rigid bone-anchored accessory with no skin binding; "
                                 "its placement follows the unchanged rest skeleton"})
        return record

    results = {body_id: fit(original, joint_names, policy, bodies[body_id])
               for body_id in ("male", "female")}
    male_positions, male_normals, male_stats, male_shells = results["male"]
    female_positions, female_normals, female_stats, _ = results["female"]

    shared = cross_check(original, joint_names, male_positions, bodies["female"])
    needs_variant = ((shared["max_penetration_mm"] > VARIANT_PENETRATION_MM
                      and shared["penetrating"] >= VARIANT_PENETRATION_COUNT)
                     or shared["drift_p95_mm"] > VARIANT_DRIFT_P95_MM)

    male_bytes = rewrite_glb(original, male_positions, male_normals, source_path)
    record["male"] = {"path": item["glb"], "bytes": male_bytes,
                      "sha256": sha256_file(source_path), **summarise(male_stats)}
    if male_shells:
        record["male"]["shells"] = male_shells
    record["shared_on_female"] = {k: round(v, 3) if isinstance(v, float) else v
                                 for k, v in shared.items()}

    if needs_variant:
        relative = os.path.join(FEMALE_SUBDIR, item["glb"]).replace(os.sep, "/")
        female_path = os.path.normpath(os.path.join(CFG.EQUIPMENT, relative))
        female_bytes = rewrite_glb(original, female_positions, female_normals,
                                   female_path)
        record["female"] = {"path": relative, "bytes": female_bytes,
                            "sha256": sha256_file(female_path),
                            **summarise(female_stats)}
        record["decision"] = "refit_both"
        record["reason"] = (
            f"the male fit reads {shared['max_penetration_mm']:.1f} mm into the "
            f"female body over {shared['penetrating']} vertices with "
            f"{shared['drift_p95_mm']:.1f} mm p95 clearance drift")
    else:
        record["decision"] = "refit_shared"
        record["reason"] = (
            f"the male fit holds on the female body: "
            f"{shared['max_penetration_mm']:.1f} mm penetration over "
            f"{shared['penetrating']} vertices, "
            f"{shared['drift_p95_mm']:.1f} mm p95 clearance drift")
    return record


def main() -> None:
    CFG.ensure_dirs()
    wanted = set(sys.argv[1:])
    with open(os.path.join(CFG.EQUIPMENT, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)
    bodies = build_fields()

    # Restore every catalogued source from the branch base before refitting, so
    # a re-run refits the authored geometry instead of a refit of a refit.
    baseline = os.path.join(CFG.BUILD_DIR, "apparel_baseline")
    reference_bodies.stage_apparel(baseline, manifest)

    records = []
    for item in manifest["items"]:
        if wanted and item["id"] not in wanted:
            continue
        if item["id"] in AUTHORED_ITEM_IDS:
            records.append({"id": item["id"], "group": item["group"],
                            "layer": item["layer"], "slot": item["slot"],
                            "glb": item["glb"], "policy": "authored",
                            "skinned": True, "decision": "authored",
                            "reason": "generated per body by "
                                      "author_starter_apparel.py"})
            print(f"  {item['id']:<32} authored (skipped: per-body geometry)")
            continue
        live = os.path.normpath(os.path.join(CFG.EQUIPMENT, item["glb"]))
        staged = os.path.join(baseline, f"{item['id']}.glb")
        shutil.copyfile(staged, live)
        record = refit_one(item, bodies, live, Glb.load(staged))
        records.append(record)
        male = record.get("male")
        print(f"  {record['id']:<32} {record['policy']:<5} {record['decision']:<14}"
              + (f" moved {male['moved_mean_mm']:6.2f}/{male['moved_max_mm']:6.2f} mm"
                 f"  lost {male['max_penetration_mm']:6.2f} mm"
                 f"  gap>={male['clearance_min_mm']:7.2f} mm" if male else ""))

    report = {
        "generator": GENERATOR,
        "fields": {body_id: {k: v for k, v in body.items()
                             if k.endswith("_mm")} for body_id, body in bodies.items()},
        "audited": len(records),
        "refit_male": sum(1 for r in records if r.get("male")),
        "female_variants": sum(1 for r in records if r.get("female")),
        "shared": sum(1 for r in records if r["decision"] == "refit_shared"),
        "not_applicable": sum(1 for r in records if r["decision"] == "not_applicable"),
        "items": records,
    }
    with open(os.path.join(CFG.REPORT_DIR, "apparel_refit.json"), "w",
              encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != "items"}, indent=2))


if __name__ == "__main__":
    main()
