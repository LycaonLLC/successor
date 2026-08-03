"""Pose the promoted bodies and their apparel the way the runtime does.

Coverage masks and fit proofs both have to be judged in motion, not in the bind
pose: a mask that looks safe on a T-pose can expose skin in a crouch, and a
garment that clears the skin standing still can be pushed through by a folded
knee. This module is the shared instrument -- it evaluates a shipped clip to
joint matrices, skins a body or a garment with them, and hands back triangles.

It reproduces the runtime's own binding rules rather than approximating them:

  * a garment is rebound onto the BODY's live joints while keeping its OWN bind
    inverses, exactly as `attachEquipmentItemToBody` does in `pawns.ts`;
  * the skinned mesh node's own transform is ignored, per the glTF skinning rule
    the loaders follow;
  * `POSES` is a fixed list of (clip, phase) pairs, so every measurement in the
    lab is taken at the same points in the same motions.

Pure numpy: no Blender types, so the same code runs under Blender's interpreter
and any interpreter with numpy.
"""

from __future__ import annotations

import os
import sys

import numpy as np

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zones as BZ  # noqa: E402
import refit_config as CFG  # noqa: E402
from gltf_io import Glb  # noqa: E402

#: Poses every coverage decision and fit proof has to survive. Chosen to move
#: each joint a mask depends on: strides and crouches open the hip and knee, the
#: melee and rifle sets carry the elbow and shoulder through their range,
#: `kneel_loop` and `meditate_loop` fold a leg completely, and `death_f` is the
#: most extreme spine bend that ships. `phase` is a fraction of the clip's own
#: duration, so a re-timed clip still samples the same point in the motion.
POSES: tuple[tuple[str, float], ...] = (
    ("idle", 0.0),
    ("walk_f", 0.25),
    ("walk_f", 0.75),
    ("run_f", 0.2),
    ("run_f", 0.7),
    ("crouch_idle", 0.5),
    ("crouch_walk", 0.3),
    ("kneel_loop", 0.5),
    ("meditate_loop", 0.5),
    ("swing_h1", 0.4),
    ("swing_thrust", 0.5),
    ("rifle_aim", 0.5),
    ("melee_ready", 0.5),
    ("melee_turn_180", 0.5),
    ("death_f", 0.6),
)

#: The bind pose, written the way `POSES` entries are so callers can prepend it.
BIND: tuple[None, float] = (None, 0.0)


def quaternion_matrix(q: np.ndarray) -> np.ndarray:
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def slerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    if float(np.dot(a, b)) < 0.0:
        b = -b
    dot = float(np.clip(np.dot(a, b), -1.0, 1.0))
    if dot > 0.9995:
        out = a + t * (b - a)
    else:
        theta = np.arccos(dot)
        out = ((np.sin((1.0 - t) * theta) * a + np.sin(t * theta) * b)
               / np.sin(theta))
    return out / np.linalg.norm(out)


def column_major(flat: np.ndarray) -> np.ndarray:
    """glTF stores matrices column-major; numpy wants them row-major."""
    return np.transpose(flat.reshape(-1, 4, 4), (0, 2, 1))


class Rig:
    """A GLB's node tree and animation samplers, evaluated to joint matrices."""

    def __init__(self, glb: Glb) -> None:
        self.nodes = glb.json["nodes"]
        self.parent: dict[int, int] = {}
        for index, node in enumerate(self.nodes):
            for child in node.get("children", ()):
                self.parent[child] = index
        skin = glb.json["skins"][0]
        self.joints = list(skin["joints"])
        self.joint_names = [self.nodes[j].get("name", "") for j in self.joints]
        self.inverse_bind = column_major(glb.accessor(skin["inverseBindMatrices"]))
        self.clips: dict[str, tuple[dict, float]] = {}
        for animation in glb.json.get("animations", ()):
            channels = {}
            duration = 0.0
            for channel in animation["channels"]:
                sampler = animation["samplers"][channel["sampler"]]
                interpolation = sampler.get("interpolation", "LINEAR")
                if interpolation == "CUBICSPLINE":
                    raise SystemExit(f"{animation.get('name')}: CUBICSPLINE sampler; "
                                     "the pose evaluator only does STEP/LINEAR")
                times = glb.accessor(sampler["input"]).astype(np.float64)
                values = glb.accessor(sampler["output"]).astype(np.float64)
                target = channel["target"]
                channels[(target["node"], target["path"])] = (times, values,
                                                              interpolation)
                duration = max(duration, float(times[-1]))
            self.clips[animation.get("name", "")] = (channels, duration)

    def _sample(self, channels, node: int, path: str, time: float, default):
        entry = channels.get((node, path))
        if entry is None:
            return default
        times, values, interpolation = entry
        if time <= times[0]:
            return values[0]
        if time >= times[-1]:
            return values[-1]
        upper = int(np.searchsorted(times, time))
        lower = upper - 1
        if interpolation == "STEP":
            return values[lower]
        span = float(times[upper] - times[lower])
        fraction = 0.0 if span <= 0.0 else float((time - times[lower]) / span)
        if path == "rotation":
            return slerp(values[lower], values[upper], fraction)
        return values[lower] * (1.0 - fraction) + values[upper] * fraction

    def local(self, channels, node: int, time: float) -> np.ndarray:
        entry = self.nodes[node]
        if "matrix" in entry:
            # glTF forbids animating a node that carries a baked matrix.
            if any(key[0] == node for key in channels):
                raise SystemExit(f"node {node} carries a matrix and animation")
            return np.array(entry["matrix"], dtype=np.float64).reshape(4, 4).T
        translation = self._sample(channels, node, "translation", time,
                                   np.array(entry.get("translation", (0.0, 0.0, 0.0))))
        rotation = self._sample(channels, node, "rotation", time,
                                np.array(entry.get("rotation", (0.0, 0.0, 0.0, 1.0))))
        scale = self._sample(channels, node, "scale", time,
                             np.array(entry.get("scale", (1.0, 1.0, 1.0))))
        out = np.eye(4)
        out[:3, :3] = (quaternion_matrix(np.asarray(rotation, dtype=np.float64))
                       * np.asarray(scale, dtype=np.float64))
        out[:3, 3] = translation
        return out

    def world(self, clip: str | None, phase: float) -> dict[str, np.ndarray]:
        """World matrix of every joint, keyed by joint name."""
        if clip is not None and clip not in self.clips:
            raise SystemExit(f"clip {clip!r} is not on this rig")
        channels, duration = self.clips[clip] if clip else ({}, 0.0)
        time = phase * duration
        cache: dict[int, np.ndarray] = {}

        def resolve(node: int) -> np.ndarray:
            if node not in cache:
                local = self.local(channels, node, time)
                parent = self.parent.get(node)
                cache[node] = local if parent is None else resolve(parent) @ local
            return cache[node]

        return {name: resolve(node)
                for name, node in zip(self.joint_names, self.joints)}


def joint_matrices(world: dict[str, np.ndarray], names: list[str],
                   inverse_bind: np.ndarray, label: str) -> np.ndarray:
    """`world(joint) @ inverseBind(joint)` in one skin's own joint order."""
    out = np.empty((len(names), 4, 4))
    for slot, name in enumerate(names):
        if name not in world:
            raise SystemExit(f"{label}: joint {name!r} is not on the body rig")
        out[slot] = world[name] @ inverse_bind[slot]
    return out


def skin(position: np.ndarray, joints: np.ndarray, weights: np.ndarray,
         matrices: np.ndarray) -> np.ndarray:
    """Linear blend skinning, the only deformation either runtime applies."""
    homogeneous = np.concatenate([position, np.ones((len(position), 1))], axis=1)
    out = np.zeros((len(position), 3))
    for slot in range(joints.shape[1]):
        weight = weights[:, slot]
        active = weight > 0.0
        if not active.any():
            continue
        moved = np.einsum("nij,nj->ni", matrices[joints[active, slot]],
                          homogeneous[active])
        out[active] += weight[active, None] * moved[:, :3]
    return out


def outward_normals(position: np.ndarray, faces: np.ndarray) -> np.ndarray:
    a, b, c = position[faces[:, 0]], position[faces[:, 1]], position[faces[:, 2]]
    normal = np.cross(b - a, c - a)
    length = np.linalg.norm(normal, axis=1, keepdims=True)
    return normal / np.where(length > 1e-20, length, 1.0)


class SkinnedGeometry:
    """One GLB's skinned triangles, ready to be posed with a body's rig."""

    def __init__(self, path: str, label: str,
                 keep=lambda name: True) -> None:
        self.label = label
        self.path = path
        self.glb = Glb.load(path)
        self.skinned = bool(self.glb.json.get("skins"))
        if not self.skinned:
            self.faces = np.zeros((0, 3), dtype=np.int64)
            return
        positions, joints, weights, faces, groups = [], [], [], [], []
        base = 0
        face_base = 0
        for mesh in self.glb.json["meshes"]:
            for primitive in mesh["primitives"]:
                name = self.glb.json["materials"][primitive["material"]]["name"]
                attributes = primitive["attributes"]
                if not keep(name) or "JOINTS_0" not in attributes:
                    continue
                position = self.glb.accessor(attributes["POSITION"]).astype(np.float64)
                index = self.glb.accessor(primitive["indices"]
                                          ).astype(np.int64).reshape(-1, 3)
                positions.append(position)
                joints.append(self.glb.accessor(attributes["JOINTS_0"]).astype(np.int64))
                weights.append(self.glb.accessor(attributes["WEIGHTS_0"]
                                                 ).astype(np.float64))
                faces.append(index + base)
                #: material -> the half-open face range it owns in `self.faces`.
                groups.append((name, face_base, face_base + len(index)))
                face_base += len(index)
                base += len(position)
        if not positions:
            self.skinned = False
            self.faces = np.zeros((0, 3), dtype=np.int64)
            return
        self.position = np.concatenate(positions)
        self.joints = np.concatenate(joints)
        self.weights = np.concatenate(weights)
        self.weights = self.weights / self.weights.sum(axis=1, keepdims=True)
        self.faces = np.concatenate(faces)
        self.groups = groups
        skin_json = self.glb.json["skins"][0]
        nodes = self.glb.json["nodes"]
        self.joint_names = [nodes[j].get("name", "") for j in skin_json["joints"]]
        self.inverse_bind = column_major(
            self.glb.accessor(skin_json["inverseBindMatrices"]))

    def posed(self, world: dict[str, np.ndarray]) -> np.ndarray:
        matrices = joint_matrices(world, self.joint_names, self.inverse_bind,
                                  self.label)
        return skin(self.position, self.joints, self.weights, matrices)


class Body(SkinnedGeometry):
    """A promoted body, with its skin split by canonical coverage zone."""

    def __init__(self, body_id: str) -> None:
        super().__init__(CFG.RUNTIME_BODY[body_id], body_id,
                         keep=lambda name: name.startswith(BZ.MATERIAL_PREFIX))
        self.body_id = body_id
        self.rig = Rig(self.glb)
        self.zone_faces: dict[str, np.ndarray] = {}
        for name, start, stop in self.groups:
            zone = name[len(BZ.MATERIAL_PREFIX):]
            if zone not in BZ.ZONE_INDEX:
                raise SystemExit(f"{body_id}: unknown zone material {name!r}")
            self.zone_faces[zone] = self.faces[start:stop]
        missing = [zone for zone in BZ.ZONES if zone not in self.zone_faces]
        if missing:
            raise SystemExit(f"{body_id}: body has no {missing} zone primitives")
        self._cache: dict[tuple[str | None, float], tuple[dict, np.ndarray]] = {}
        self._assert_outward()

    def _assert_outward(self) -> None:
        """Front faces must point away from the body, or every ray test inverts.

        Judged by signed volume rather than by comparing each normal to the rig
        axis: a foot sole, a palm and the crown of the head are all correctly
        wound and none of them points away from the axis.
        """
        corners = self.position[self.faces]
        volume = float(np.einsum("ij,ij->i", corners[:, 0],
                                 np.cross(corners[:, 1], corners[:, 2])).sum() / 6.0)
        if volume <= 0.0:
            raise SystemExit(f"{self.body_id}: skin winds inward (signed volume "
                             f"{volume:.6f}); the coverage probe assumes CCW "
                             "front faces")

    def pose(self, clip: str | None, phase: float):
        """(joint world matrices, posed skin positions), cached per pose."""
        key = (clip, phase)
        if key not in self._cache:
            world = self.rig.world(clip, phase)
            self._cache[key] = (world, self.posed(world))
        return self._cache[key]

    def poses(self) -> list[tuple[str | None, float]]:
        available = [BIND]
        for clip, phase in POSES:
            if clip in self.rig.clips:
                available.append((clip, phase))
            else:
                raise SystemExit(f"{self.body_id}: clip {clip!r} is missing")
        return available
