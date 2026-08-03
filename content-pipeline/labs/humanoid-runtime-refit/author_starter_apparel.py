"""Author the starter suit and boots as fitted skinned outer geometry, per sex.

`refit_apparel.py` warps the catalogue from the body it was drawn on onto the
promoted body. That works for garments that only needed re-seating, but the two
FIXED starter pieces are the ones it cannot save: measured after the generic
refit, `under_bodysuit` still reads -1.5 mm into the male skin and -11.0 mm into
the female, and `boots_canvas_ankle` -18.3 / -19.0 mm. A warp cannot fix that,
because the retro bodies are a different body -- the male foot alone went from a
76 mm to a 103 mm span -- and no offset field turns a boot drawn around the old
foot into one that encloses the new one.

So these two are authored FROM the body instead of fitted TO it. Each piece is a
shell over a chosen set of skin zones, offset outward along the body's own
normals and skinned with the body's own weights. That construction is what makes
the fit exact rather than approximate:

  * the shell shares the skin's topology and weights, so linear-blend skinning
    applies the SAME blended matrix to a shell vertex and to the skin vertex
    under it. Their separation is that matrix applied to the offset vector, which
    contracts at a folded joint but cannot invert -- the garment can hug tighter
    in a deep crouch and can never pass through;
  * one shell per body, so the female piece is fitted to the female body rather
    than being the male piece warped sideways;
  * the openings get a rim: the boundary loop is joined back down to the skin, so
    a collar or a cuff reads as fabric with thickness against visible skin
    instead of as a hole into the body.

The boot keeps the ratified runtime contract from
`client-3d/src/assets/bootsCanvasAnkleFit.test.ts`: two meshes named per side,
exactly the three dye materials in order, the collar trim band the only geometry
above the ankle, binary foot/calf weights, faces wound outward, and a shell that
encloses the WORN suit's foot region rather than just bare skin. Every one of
those is asserted here at authoring time, so a regression fails the build and not
the test suite.

    blender --background --python author_starter_apparel.py
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from typing import Any, Callable

import numpy as np

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zones as BZ  # noqa: E402
import refit_config as CFG  # noqa: E402
from gltf_io import (Glb, GlbBuilder, TARGET_ARRAY_BUFFER,  # noqa: E402
                     TARGET_ELEMENT_ARRAY_BUFFER)

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/author_starter_apparel.py"

#: Female variants live beside the male ones under this prefix, and the manifest
#: names them with `glbFemale`. Both runtimes resolve that key relative to the
#: equipment directory.
FEMALE_PREFIX = "Female"

#: Suit standoff. This is a skin-tight bodysuit over skin its own mask removes, so
#: the only job the standoff has is to stop the two surfaces z-fighting: 1 mm does
#: that on a body whose facets are centimetres across. Every extra millimetre was
#: measurable as harm -- at 5 mm the suit read 4.6 mm deeper into visible skin than
#: the bare body wherever a clip presses a hand onto a thigh, and it ate the boot's
#: clearance from the inside.
SUIT_OFFSET_M = 0.001

#: Joint compensation was tried and MEASURED WORSE, so it is deliberately off.
#: Thickening the standoff where the skin weights are split does answer the
#: linear-blend contraction, but it balloons the shell over every joint: the
#: bulge leaves the skin far enough that the coverage cone stops finding fabric
#: (the suit's torso fell from 0.998 to 0.994 enclosed) and the bulge itself then
#: swings through the skin on the far side of a fold (worst penetration went from
#: -3.9 mm to -8.2 mm). A uniform standoff is both tighter and cleaner.
JOINT_COMPENSATION = 0.0
#: The suit is neck-to-wrists-to-ankles, exactly as its manifest note says. Feet
#: are the BOOT's layer: letting the suit cover them too put two shells over the
#: same skin, and the boot's collar then had to cross the suit's foot geometry
#: (measured: 221 crossing triangle pairs). Layer topology, not offsets, is what
#: keeps them apart -- the suit's calf ends in a closed cuff at the ankle and the
#: boot shaft rides over that cuff with radial clearance.
SUIT_ZONES = tuple(zone for zone in BZ.ZONES
                   if zone not in ("neck", "head", "left_hand", "right_hand",
                                   "left_foot", "right_foot"))

#: Boot standoff. Larger than the suit's, because the boot is worn OVER it and
#: has to enclose it.
BOOT_OFFSET_M = 0.010
#: Where the boot's collar rim lands: on the suit, not the skin. One suit
#: standoff plus a millimetre, so the two shells touch and never cross.
BOOT_RIM_ON_SUIT_M = SUIT_OFFSET_M + 0.001

#: Top of the boot shaft, and the bottom of its collar trim band, in bind-pose y.
#: The trim band is the only boot geometry above the ankle, and the ratified
#: contract requires every trim vertex above 0.18 m.
BOOT_SHAFT_TOP_M = 0.215
BOOT_TRIM_BOTTOM_M = 0.185
#: How far the outsole may sit below the standing plane. The promoted bodies
#: touch y = 0 exactly, so a boot that encloses the sole has to go under it; 4 mm
#: is a sole, not a stilt.
BOOT_SOLE_FLOOR_M = -0.004
#: A shell face pointing this far down is outsole, not upper.
SOLE_NORMAL_Y = -0.5

BOOT_MATERIALS = ("boots_canvas_ankle_c0", "boots_canvas_ankle_c1",
                  "boots_canvas_ankle_c3")
SUIT_MATERIAL = "PF2_Cloth"


def sha256_file(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


# ---------------------------------------------------------------- body surface


class BodySurface:
    """A promoted body's skin, welded, with its zone labels and skin binding."""

    def __init__(self, body_id: str) -> None:
        self.body_id = body_id
        glb = Glb.load(CFG.RUNTIME_BODY[body_id])
        self.glb = glb
        positions, joints, weights, faces, zones = [], [], [], [], []
        base = 0
        for primitive in glb.json["meshes"][0]["primitives"]:
            name = glb.json["materials"][primitive["material"]]["name"]
            if not name.startswith(BZ.MATERIAL_PREFIX):
                continue
            zone = name[len(BZ.MATERIAL_PREFIX):]
            attributes = primitive["attributes"]
            position = glb.accessor(attributes["POSITION"]).astype(np.float64)
            index = glb.accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3)
            positions.append(position)
            joints.append(glb.accessor(attributes["JOINTS_0"]).astype(np.int64))
            weights.append(glb.accessor(attributes["WEIGHTS_0"]).astype(np.float64))
            faces.append(index + base)
            zones.append(np.full(len(index), BZ.ZONE_INDEX[zone]))
            base += len(position)
        raw_position = np.concatenate(positions)
        raw_joints = np.concatenate(joints)
        raw_weights = np.concatenate(weights)
        raw_faces = np.concatenate(faces)
        self.face_zone = np.concatenate(zones)

        welded = BZ.weld(raw_position)
        count = int(welded.max()) + 1
        self.faces = welded[raw_faces]
        # Faceted/material seams may duplicate one surface point with slightly
        # different valid bindings. Collapse those bindings by joint, retain the
        # strongest four influences, and renormalise. Refusing the split loses
        # the reviewed head/neck topology; taking the last duplicate creates a
        # seam whose garment motion depends on primitive order.
        self.position = np.zeros((count, 3))
        self.position[welded] = raw_position
        if not np.allclose(self.position[welded], raw_position, atol=1e-6):
            raise SystemExit(f"{body_id}: welded positions disagree")

        influence_slots = raw_joints.shape[1]
        joint_count = len(glb.json["skins"][0]["joints"])
        blended = np.zeros((count, joint_count), dtype=np.float64)
        np.add.at(
            blended,
            (np.repeat(welded, influence_slots), raw_joints.reshape(-1)),
            raw_weights.reshape(-1),
        )
        strongest = np.argpartition(blended, -influence_slots, axis=1)[:, -influence_slots:]
        strongest_weights = np.take_along_axis(blended, strongest, axis=1)
        descending = np.argsort(-strongest_weights, axis=1)
        self.joints = np.take_along_axis(strongest, descending, axis=1)
        self.weights = np.take_along_axis(strongest_weights, descending, axis=1)
        totals = self.weights.sum(axis=1, keepdims=True)
        if np.any(totals <= 1e-12):
            raise SystemExit(f"{body_id}: welded skin binding has zero total weight")
        self.weights /= totals
        self.normal = self._normals(self.position, self.faces, count)

    @staticmethod
    def _normals(position: np.ndarray, faces: np.ndarray, count: int) -> np.ndarray:
        a, b, c = position[faces[:, 0]], position[faces[:, 1]], position[faces[:, 2]]
        accumulated = np.zeros((count, 3))
        face_normal = np.cross(b - a, c - a)
        for corner in range(3):
            np.add.at(accumulated, faces[:, corner], face_normal)
        length = np.linalg.norm(accumulated, axis=1, keepdims=True)
        return accumulated / np.where(length > 1e-20, length, 1.0)

    def zone_faces(self, zones: tuple[str, ...]) -> np.ndarray:
        wanted = np.array([BZ.ZONE_INDEX[zone] for zone in zones])
        return self.faces[np.isin(self.face_zone, wanted)]


# ------------------------------------------------------------------- shell mesh


class Shell:
    """A growable triangle soup carrying position, normal and skin binding."""

    def __init__(self, surface: BodySurface, faces: np.ndarray) -> None:
        used = np.unique(faces)
        self.local = {int(vertex): slot for slot, vertex in enumerate(used)}
        self.position = list(surface.position[used])
        self.normal = list(surface.normal[used])
        self.joints = list(surface.joints[used])
        self.weights = list(surface.weights[used])
        self.faces = [[self.local[int(vertex)] for vertex in face] for face in faces]

    # --------------------------------------------------------------- geometry

    def add_vertex(self, position, normal, joints, weights) -> int:
        self.position.append(np.asarray(position, dtype=np.float64))
        self.normal.append(np.asarray(normal, dtype=np.float64))
        self.joints.append(np.asarray(joints, dtype=np.int64))
        self.weights.append(np.asarray(weights, dtype=np.float64))
        return len(self.position) - 1

    def interpolate(self, a: int, b: int, t: float) -> int:
        return self.add_vertex(
            self.position[a] * (1.0 - t) + self.position[b] * t,
            self.normal[a] * (1.0 - t) + self.normal[b] * t,
            self.joints[a] if t < 0.5 else self.joints[b],
            self.weights[a] * (1.0 - t) + self.weights[b] * t
            if np.array_equal(self.joints[a], self.joints[b])
            else (self.weights[a] if t < 0.5 else self.weights[b]))

    def _cut(self, height: float, keep_above: bool) -> None:
        """Cut every triangle on the plane y = height.

        `keep_above` false discards what is above the plane (a shaft top);
        true keeps both halves, which just inserts a ring. A per-face keep/drop
        test would leave the boot collar as a stair of whole facets; cutting on
        the plane puts a real edge loop there.
        """
        value = np.array([point[1] for point in self.position]) - height
        kept: list[list[int]] = []
        cache: dict[tuple[int, int], int] = {}

        def crossing(a: int, b: int) -> int:
            key = (a, b) if a < b else (b, a)
            if key not in cache:
                first, second = key
                t = float(value[first] / (value[first] - value[second]))
                cache[key] = self.interpolate(first, second, t)
            return cache[key]

        def fan(polygon: list[int]) -> None:
            for slot in range(1, len(polygon) - 1):
                kept.append([polygon[0], polygon[slot], polygon[slot + 1]])

        for face in self.faces:
            below = [value[vertex] <= 0.0 for vertex in face]
            if all(below):
                kept.append(face)
                continue
            if not any(below):
                if keep_above:
                    kept.append(face)
                continue
            lower: list[int] = []
            upper: list[int] = []
            for slot in range(3):
                current, following = face[slot], face[(slot + 1) % 3]
                (lower if below[slot] else upper).append(current)
                if below[slot] != below[(slot + 1) % 3]:
                    split = crossing(current, following)
                    lower.append(split)
                    upper.append(split)
            fan(lower)
            if keep_above:
                fan(upper)
        self.faces = kept
        self.compact()

    def clip_below(self, height: float) -> None:
        """Discard everything above `height`."""
        self._cut(height, keep_above=False)

    def split_at(self, height: float) -> None:
        """Insert an edge loop at `height`, keeping both sides."""
        self._cut(height, keep_above=True)

    def compact(self) -> None:
        used = sorted({vertex for face in self.faces for vertex in face})
        remap = {vertex: slot for slot, vertex in enumerate(used)}
        self.position = [self.position[vertex] for vertex in used]
        self.normal = [self.normal[vertex] for vertex in used]
        self.joints = [self.joints[vertex] for vertex in used]
        self.weights = [self.weights[vertex] for vertex in used]
        self.faces = [[remap[vertex] for vertex in face] for face in self.faces]

    def boundary(self) -> list[tuple[int, int, int]]:
        """Directed edges used once, with the face that owns each."""
        counts: dict[tuple[int, int], int] = {}
        for face in self.faces:
            for slot in range(3):
                key = tuple(sorted((face[slot], face[(slot + 1) % 3])))
                counts[key] = counts.get(key, 0) + 1
        out = []
        for index, face in enumerate(self.faces):
            for slot in range(3):
                a, b = face[slot], face[(slot + 1) % 3]
                if counts[tuple(sorted((a, b)))] == 1:
                    out.append((a, b, index))
        return out

    def scaled_offset(self, amount: float) -> np.ndarray:
        """Per-vertex standoff, thickened where the skin weights are split."""
        dominant = np.array([float(np.max(weights)) for weights in self.weights])
        return amount * (1.0 + JOINT_COMPENSATION * (1.0 - dominant))

    def offset(self, amount: float, floor: Callable[[np.ndarray], np.ndarray] | None
               ) -> None:
        self.standoff = self.scaled_offset(amount)
        for slot, (point, normal) in enumerate(zip(self.position, self.normal)):
            moved = point + self.standoff[slot] * normal
            self.position[slot] = moved if floor is None else floor(moved)

    def close_rim(self, inner_offset: float,
                  floor: Callable[[np.ndarray], np.ndarray] | None) -> list[int]:
        """Turn every opening inward, so a cuff has thickness instead of an edge.

        `inner_offset` is where the rim lands, measured from the SKIN outward. The suit
        rims onto the skin (0). The boot rims onto the SUIT (one suit standoff
        plus a hair), because it is worn over it: a boot collar that returned to
        the skin would dive straight through the suit it is supposed to cover, and
        measured 221 crossing triangle pairs when it did.

        Each rim quad is wound to face away from the face that owns its edge, so
        the rim reads correctly under the runtime's front-side-only materials.
        """
        edges = self.boundary()
        inner: dict[int, int] = {}
        added: list[int] = []
        for a, b, owner in edges:
            for vertex in (a, b):
                if vertex not in inner:
                    drop = max(0.0, float(self.standoff[vertex]) - inner_offset)
                    point = self.position[vertex] - drop * self.normal[vertex]
                    if floor is not None:
                        point = floor(point)
                    inner[vertex] = self.add_vertex(point, -self.normal[vertex],
                                                    self.joints[vertex],
                                                    self.weights[vertex])
            centroid = np.mean([self.position[v] for v in self.faces[owner]], axis=0)
            middle = 0.5 * (self.position[a] + self.position[b])
            away = middle - centroid
            for triangle in ([a, b, inner[b]], [a, inner[b], inner[a]]):
                first, second, third = (self.position[triangle[0]],
                                        self.position[triangle[1]],
                                        self.position[triangle[2]])
                normal = np.cross(second - first, third - first)
                if float(np.dot(normal, away)) < 0.0:
                    triangle = [triangle[0], triangle[2], triangle[1]]
                self.faces.append(triangle)
                added.append(len(self.faces) - 1)
        return added

    def recompute_normals(self) -> None:
        position = np.asarray(self.position)
        faces = np.asarray(self.faces)
        a, b, c = position[faces[:, 0]], position[faces[:, 1]], position[faces[:, 2]]
        accumulated = np.zeros_like(position)
        face_normal = np.cross(b - a, c - a)
        for corner in range(3):
            np.add.at(accumulated, faces[:, corner], face_normal)
        length = np.linalg.norm(accumulated, axis=1, keepdims=True)
        self.normal = list(accumulated / np.where(length > 1e-20, length, 1.0))

    # ----------------------------------------------------------------- arrays

    def arrays(self, faces: list[list[int]] | None = None):
        chosen = self.faces if faces is None else faces
        index = np.asarray(chosen, dtype=np.int64)
        used, rewritten = np.unique(index, return_inverse=True)
        return (np.asarray(self.position)[used].astype(np.float32),
                np.asarray(self.normal)[used].astype(np.float32),
                np.asarray(self.joints)[used].astype(np.uint8),
                np.asarray(self.weights)[used].astype(np.float32),
                rewritten.reshape(-1).astype(np.uint16))

    def face_normals(self) -> np.ndarray:
        position = np.asarray(self.position)
        faces = np.asarray(self.faces)
        a, b, c = position[faces[:, 0]], position[faces[:, 1]], position[faces[:, 2]]
        normal = np.cross(b - a, c - a)
        length = np.linalg.norm(normal, axis=1, keepdims=True)
        return normal / np.where(length > 1e-20, length, 1.0)

    def face_min_y(self) -> np.ndarray:
        position = np.asarray(self.position)
        return position[np.asarray(self.faces), 1].min(axis=1)


# ------------------------------------------------------------------- GLB write


def write_garment(body: BodySurface, groups: list[dict], materials: list[str],
                  destination: str) -> int:
    """One skinned GLB: the promoted body's rig, the authored shells' meshes."""
    source = body.glb
    gltf: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": GENERATOR},
        "scene": 0,
        "scenes": json.loads(json.dumps(source.json["scenes"])),
        "nodes": json.loads(json.dumps(source.json["nodes"])),
        "skins": json.loads(json.dumps(source.json["skins"])),
    }
    builder = GlbBuilder(gltf)
    inverse_bind = source.accessor(source.json["skins"][0]["inverseBindMatrices"])
    gltf["skins"][0]["inverseBindMatrices"] = builder.add_accessor(
        inverse_bind.astype(np.float32))
    builder.json["materials"] = [
        {"name": name, "doubleSided": True,
         "pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.8, 0.8, 1.0],
                                  "metallicFactor": 0.0, "roughnessFactor": 0.7}}
        for name in materials]
    slot = {name: index for index, name in enumerate(materials)}

    meshes = []
    for group in groups:
        primitives = []
        for material, faces in group["primitives"]:
            position, normal, joints, weights, indices = group["shell"].arrays(faces)
            primitives.append({
                "attributes": {
                    "POSITION": builder.add_accessor(position, target=TARGET_ARRAY_BUFFER,
                                                     minmax=True),
                    "NORMAL": builder.add_accessor(normal, target=TARGET_ARRAY_BUFFER),
                    "JOINTS_0": builder.add_accessor(joints, target=TARGET_ARRAY_BUFFER),
                    "WEIGHTS_0": builder.add_accessor(weights, target=TARGET_ARRAY_BUFFER),
                },
                "indices": builder.add_accessor(indices,
                                                target=TARGET_ELEMENT_ARRAY_BUFFER),
                "material": slot[material],
            })
        meshes.append({"name": group["name"], "primitives": primitives})
    builder.json["meshes"] = meshes
    # Every mesh hangs off the node the body's own mesh used, so the garment
    # inherits the skinned-mesh node's place in the scene graph.
    mesh_nodes = [index for index, node in enumerate(gltf["nodes"]) if "mesh" in node]
    if len(mesh_nodes) != 1:
        raise SystemExit(f"{body.body_id}: expected one skinned mesh node, "
                         f"found {mesh_nodes}")
    template = gltf["nodes"][mesh_nodes[0]]
    scene_nodes = gltf["scenes"][0].setdefault("nodes", [])
    for extra in range(1, len(meshes)):
        clone = {key: value for key, value in template.items() if key != "name"}
        clone["name"] = f"{meshes[extra]['name']}_node"
        clone["mesh"] = extra
        gltf["nodes"].append(clone)
        scene_nodes.append(len(gltf["nodes"]) - 1)
    template["mesh"] = 0
    template["name"] = f"{meshes[0]['name']}_node"
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    return builder.write(destination)


# ----------------------------------------------------------------------- suit


def sole_floor(limit: float) -> Callable[[np.ndarray], np.ndarray]:
    def clamp(point: np.ndarray) -> np.ndarray:
        if point[1] < limit:
            point = point.copy()
            point[1] = limit
        return point
    return clamp


def build_suit(body: BodySurface, destination: str) -> dict:
    shell = Shell(body, body.zone_faces(SUIT_ZONES))
    floor = sole_floor(0.0)
    shell.offset(SUIT_OFFSET_M, floor)
    shell.close_rim(0.0, floor)
    shell.recompute_normals()
    bytes_written = write_garment(
        body, [{"name": "bodysuit", "shell": shell,
                "primitives": [(SUIT_MATERIAL, None)]}],
        [SUIT_MATERIAL], destination)
    position = np.asarray(shell.position)
    return {"path": destination, "bytes": bytes_written,
            "sha256": sha256_file(destination),
            "vertices": len(shell.position), "triangles": len(shell.faces),
            "offset_mm": SUIT_OFFSET_M * 1000.0,
            "zones": list(SUIT_ZONES),
            "bbox_min": [round(float(v), 5) for v in position.min(axis=0)],
            "bbox_max": [round(float(v), 5) for v in position.max(axis=0)]}


# ---------------------------------------------------------------------- boots


def build_boots(body: BodySurface, destination: str) -> dict:
    floor = sole_floor(BOOT_SOLE_FLOOR_M)
    groups = []
    stats = []
    for side in ("left", "right"):
        faces = np.concatenate([body.zone_faces((f"{side}_foot",)),
                                body.zone_faces((f"{side}_calf",))])
        shell = Shell(body, faces)
        shell.clip_below(BOOT_SHAFT_TOP_M)
        # A second cut gives the trim band a ring of its own instead of a stair
        # of whole calf facets.
        shell.split_at(BOOT_TRIM_BOTTOM_M)
        shell.offset(BOOT_OFFSET_M, floor)
        rim = shell.close_rim(BOOT_RIM_ON_SUIT_M, floor)
        shell.recompute_normals()

        normals = shell.face_normals()
        min_y = shell.face_min_y()
        trim = [index for index in range(len(shell.faces))
                if min_y[index] >= BOOT_TRIM_BOTTOM_M - 1.0e-6]
        sole = [index for index in range(len(shell.faces))
                if index not in set(trim) and normals[index][1] <= SOLE_NORMAL_Y]
        upper = [index for index in range(len(shell.faces))
                 if index not in set(trim) and index not in set(sole)]
        mesh = f"boots_canvas_ankle_{side[0]}"
        groups.append({"name": mesh, "shell": shell, "primitives": [
            (BOOT_MATERIALS[0], [shell.faces[i] for i in trim]),
            (BOOT_MATERIALS[1], [shell.faces[i] for i in upper]),
            (BOOT_MATERIALS[2], [shell.faces[i] for i in sole]),
        ]})
        position = np.asarray(shell.position)
        stats.append({"mesh": mesh, "vertices": len(shell.position),
                      "triangles": len(shell.faces), "rim_triangles": len(rim),
                      "trim_triangles": len(trim), "sole_triangles": len(sole),
                      "upper_triangles": len(upper),
                      "bbox_min": [round(float(v), 5) for v in position.min(axis=0)],
                      "bbox_max": [round(float(v), 5) for v in position.max(axis=0)]})
    bytes_written = write_garment(body, groups, list(BOOT_MATERIALS), destination)
    return {"path": destination, "bytes": bytes_written,
            "sha256": sha256_file(destination),
            "offset_mm": BOOT_OFFSET_M * 1000.0,
            "shaft_top_m": BOOT_SHAFT_TOP_M,
            "trim_bottom_m": BOOT_TRIM_BOTTOM_M,
            "sole_floor_m": BOOT_SOLE_FLOOR_M,
            "sides": stats}


def main() -> None:
    CFG.ensure_dirs()
    report: dict[str, Any] = {"generator": GENERATOR, "bodies": {}}
    for body_id in ("male", "female"):
        body = BodySurface(body_id)
        prefix = "" if body_id == "male" else f"{FEMALE_PREFIX}/"
        entry = {
            "body": os.path.relpath(CFG.RUNTIME_BODY[body_id], CFG.REPO),
            "body_sha256": sha256_file(CFG.RUNTIME_BODY[body_id]),
            "under_bodysuit": build_suit(
                body, os.path.join(CFG.EQUIPMENT,
                                   f"{prefix}Under/under_bodysuit.glb")),
            "boots_canvas_ankle": build_boots(
                body, os.path.join(CFG.EQUIPMENT,
                                   f"{prefix}Under/boots_canvas_ankle.glb")),
        }
        for name in ("under_bodysuit", "boots_canvas_ankle"):
            entry[name]["path"] = os.path.relpath(entry[name]["path"], CFG.REPO)
        report["bodies"][body_id] = entry
        print(f"[starter] {body_id}: suit {entry['under_bodysuit']['triangles']} tris, "
              f"boots {sum(s['triangles'] for s in entry['boots_canvas_ankle']['sides'])}"
              f" tris -> {entry['under_bodysuit']['path']}")
    destination = os.path.join(CFG.REPORT_DIR, "starter_apparel.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"[starter] -> {os.path.relpath(destination, CFG.REPO)}")


if __name__ == "__main__":
    main()
