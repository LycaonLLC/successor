"""Extract the last known-good animated hands from a runtime body.

The reviewed high-detail hand replacement closes in bind pose but separates from
both forearms once wrist clips run. The pre-refit runtime bodies do not: their
hand geometry, weights, rest pose, inverse binds, and clips were authored as one
contract. Promotion therefore keeps the refined body everywhere except these two
leaf zones and grafts the canonical hand primitives back verbatim.
"""

from __future__ import annotations

import numpy as np

import body_zones as BZ
from gltf_io import Glb

HAND_ZONES = ("left_hand", "right_hand")
HAND_SHARE_THRESHOLD = 0.5


def extract(glb: Glb, target_joint_names: list[str]) -> dict[str, dict[str, np.ndarray]]:
    """Return compact canonical hand primitives remapped to target joint order."""
    source_joints = glb.json["skins"][0]["joints"]
    source_joint_names = [glb.json["nodes"][index].get("name", "")
                          for index in source_joints]
    if set(source_joint_names) != set(target_joint_names):
        missing = sorted(set(target_joint_names) - set(source_joint_names))
        extra = sorted(set(source_joint_names) - set(target_joint_names))
        raise SystemExit(f"canonical hand joint contract drifted: missing={missing}, extra={extra}")
    target_slot = {name: index for index, name in enumerate(target_joint_names)}
    remap = np.array([target_slot[name] for name in source_joint_names], dtype=np.uint8)

    positions: list[np.ndarray] = []
    normals: list[np.ndarray] = []
    joints: list[np.ndarray] = []
    weights: list[np.ndarray] = []
    faces: list[np.ndarray] = []
    base = 0
    for mesh in glb.json["meshes"]:
        for primitive in mesh["primitives"]:
            attributes = primitive["attributes"]
            required = {"POSITION", "NORMAL", "JOINTS_0", "WEIGHTS_0"}
            if not required.issubset(attributes):
                continue
            position = glb.accessor(attributes["POSITION"]).astype(np.float64)
            positions.append(position)
            normals.append(glb.accessor(attributes["NORMAL"]).astype(np.float32))
            joints.append(glb.accessor(attributes["JOINTS_0"]).astype(np.int64))
            weights.append(glb.accessor(attributes["WEIGHTS_0"]).astype(np.float64))
            faces.append(glb.accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3) + base)
            base += len(position)
    if not positions:
        raise SystemExit("canonical hand source has no skinned triangle primitives")

    position = np.concatenate(positions)
    normal = np.concatenate(normals)
    source_joint_slots = np.concatenate(joints)
    weight = np.concatenate(weights)
    face = np.concatenate(faces)
    totals = weight.sum(axis=1, keepdims=True)
    if np.any(totals <= 1.0e-12):
        raise SystemExit("canonical hand source has a zero-weight vertex")
    weight = weight / totals
    shares = BZ.zone_shares(source_joint_names, source_joint_slots, weight)
    face_shares = shares[face].mean(axis=1)

    out: dict[str, dict[str, np.ndarray]] = {}
    masks = []
    remapped = remap[source_joint_slots]
    remapped[weight <= 0.0] = 0
    for zone in HAND_ZONES:
        mask = face_shares[:, BZ.ZONE_INDEX[zone]] > HAND_SHARE_THRESHOLD
        if not mask.any():
            raise SystemExit(f"canonical hand source has no {zone} triangles")
        picked = face[mask]
        used, local = np.unique(picked, return_inverse=True)
        local = local.reshape(-1, 3)
        out[zone] = {
            "POSITION": position[used].astype(np.float32),
            "NORMAL": normal[used],
            "JOINTS_0": remapped[used],
            "WEIGHTS_0": weight[used].astype(np.float32),
            "indices": local,
        }
        masks.append(mask)
    if np.logical_and(masks[0], masks[1]).any():
        raise SystemExit("canonical left/right hand extraction overlapped")
    return out
