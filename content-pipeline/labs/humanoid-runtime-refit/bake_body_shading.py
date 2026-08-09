"""Bake the runtime bodies' stylized skin shading as per-vertex occlusion.

The world renderer is unlit (`MeshMatcapMaterial`), so nothing in a shipped
frame produces contact shading on its own: without a baked term a faceted
low-poly body reads as a flat silhouette. This step bakes ONE gentle ambient
occlusion pass and remaps it into `[AO_FLOOR, 1]`. That is the only tonal
variation the skin carries -- no pores, no procedural noise, no painted detail.

It is baked to VERTEX COLOURS rather than a texture on purpose. The approved
heads carry an authored UV set whose head island folds front onto back (measured
at 278k conflicting texels on a 512 map), so a UV-space bake would smear the
jawline onto the crown. Vertices are the honest domain here: 13k of them across
a 5.8k-triangle body is finer than any map the UV layout could support, glTF
`COLOR_0` needs no unwrap, and both `MeshStandardMaterial` and the runtime's
`MeshMatcapMaterial` multiply it into base colour.

Occlusion is evaluated on WELDED positions with area-weighted normals, so the
split shading vertices of one corner all receive the same value and the result
is a smooth occlusion field under the matcap's facet shading.

    blender --background --python bake_body_shading.py
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
import reference_bodies  # noqa: E402
import refit_config as CFG  # noqa: E402
from gltf_io import Glb  # noqa: E402

RAY_COUNT = 64
WELD_DECIMALS = 6


def merged_mesh(glb: Glb) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[int]]:
    """Concatenate every primitive into one (V, N, F) soup.

    `offsets` has one entry per primitive plus the soup total, so a primitive's
    vertex range is `offsets[slot]:offsets[slot + 1]`.
    """
    positions, normals, faces, offsets = [], [], [], []
    base = 0
    for primitive in glb.json["meshes"][0]["primitives"]:
        vertex = glb.accessor(primitive["attributes"]["POSITION"]).astype(np.float64)
        normal = glb.accessor(primitive["attributes"]["NORMAL"]).astype(np.float64)
        index = glb.accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3)
        positions.append(vertex)
        normals.append(normal)
        faces.append(index + base)
        offsets.append(base)
        base += len(vertex)
    offsets.append(base)
    return (np.concatenate(positions), np.concatenate(normals),
            np.concatenate(faces), offsets)


def hemisphere(count: int) -> np.ndarray:
    """Deterministic cosine-weighted hemisphere directions around +Z."""
    index = np.arange(count, dtype=np.float64) + 0.5
    # Fibonacci lattice: fixed, seedless, identical on every run and machine.
    radial = np.sqrt(index / count)
    theta = np.pi * (1.0 + 5.0 ** 0.5) * index
    x = radial * np.cos(theta)
    y = radial * np.sin(theta)
    z = np.sqrt(np.maximum(0.0, 1.0 - radial * radial))
    return np.stack([x, y, z], axis=1)


def frames(normals: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Branchless orthonormal tangent frames (Duff et al.)."""
    sign = np.where(normals[:, 2] >= 0.0, 1.0, -1.0)
    a = -1.0 / (sign + normals[:, 2])
    b = normals[:, 0] * normals[:, 1] * a
    tangent = np.stack([1.0 + sign * normals[:, 0] ** 2 * a,
                        sign * b,
                        -sign * normals[:, 0]], axis=1)
    bitangent = np.stack([b,
                          sign + normals[:, 1] ** 2 * a,
                          -normals[:, 1]], axis=1)
    return tangent, bitangent


def occlusion(vertices: np.ndarray, faces: np.ndarray,
              welded: np.ndarray, welded_normals: np.ndarray) -> np.ndarray:
    tree = BVHTree.FromPolygons([tuple(v) for v in vertices],
                                [tuple(f) for f in faces],
                                all_triangles=True, epsilon=0.0)
    directions = hemisphere(RAY_COUNT)
    tangent, bitangent = frames(welded_normals)
    origins = welded + welded_normals * 2.0e-4
    hits = np.zeros(len(welded), dtype=np.float64)
    for ray in directions:
        world = (tangent * ray[0] + bitangent * ray[1] + welded_normals * ray[2])
        for index in range(len(welded)):
            location, _, _, _ = tree.ray_cast(tuple(origins[index]),
                                              tuple(world[index]),
                                              CFG.AO_DISTANCE)
            if location is not None:
                hits[index] += 1.0
    return 1.0 - hits / RAY_COUNT


def relax(values: np.ndarray, faces: np.ndarray, inverse: np.ndarray,
          count: int) -> np.ndarray:
    """Laplacian smoothing over the welded surface graph.

    Occlusion is sampled per welded point, and a low-poly neck or armpit can
    step from open to fully closed across a single edge loop. Unsmoothed that
    renders as a hard band; a few relaxation passes turn it back into the
    gradient a contact shadow actually is.
    """
    welded_faces = inverse[faces]
    a = np.concatenate([welded_faces[:, 0], welded_faces[:, 1], welded_faces[:, 2]])
    b = np.concatenate([welded_faces[:, 1], welded_faces[:, 2], welded_faces[:, 0]])
    edges_a = np.concatenate([a, b])
    edges_b = np.concatenate([b, a])
    degree = np.bincount(edges_a, minlength=count).astype(np.float64)
    degree[degree == 0] = 1.0
    out = values.copy()
    for _ in range(CFG.AO_SMOOTH_PASSES):
        total = np.zeros(count)
        np.add.at(total, edges_a, out[edges_b])
        out = (1.0 - CFG.AO_SMOOTH_WEIGHT) * out + CFG.AO_SMOOTH_WEIGHT * (total / degree)
    return out


def bake(body_id: str, source: str) -> dict:
    glb = Glb.load(source)
    vertices, normals, faces, offsets = merged_mesh(glb)

    keys = np.round(vertices, WELD_DECIMALS)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    welded = np.zeros((len(first), 3))
    welded_normals = np.zeros((len(first), 3))
    np.add.at(welded, inverse, vertices)
    np.add.at(welded_normals, inverse, normals)
    counts = np.bincount(inverse, minlength=len(first)).astype(np.float64)
    welded /= counts[:, None]
    lengths = np.linalg.norm(welded_normals, axis=1, keepdims=True)
    welded_normals /= np.where(lengths > 1e-12, lengths, 1.0)

    raw = occlusion(vertices, faces, welded, welded_normals)
    raw = relax(raw, faces, inverse, len(welded))
    shade = CFG.AO_FLOOR + (1.0 - CFG.AO_FLOOR) * np.clip(raw, 0.0, 1.0) ** CFG.AO_GAMMA
    per_vertex = shade[inverse]

    # The face panel carries the composited face: its border is invisible only
    # while the panel background matches the head tone exactly, so the panel
    # stays unshaded. It is found by material rather than by slot -- a body that
    # reorders its primitives must not silently shade the face.
    materials = [glb.json["materials"][primitive["material"]]["name"]
                 for primitive in glb.json["meshes"][0]["primitives"]]
    if materials.count(BZ.FACE_MATERIAL) != 1:
        raise SystemExit(f"{body_id}: expected exactly one {BZ.FACE_MATERIAL} "
                         f"primitive, found {materials}")
    panel = materials.index(BZ.FACE_MATERIAL)
    per_vertex[offsets[panel]: offsets[panel + 1]] = 1.0

    path = os.path.join(CFG.BUILD_DIR, f"{body_id}_vertex_ao.npy")
    np.save(path, per_vertex.astype(np.float32))
    return {
        "npy": os.path.relpath(path, CFG.REPO),
        "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
        "vertices": int(len(per_vertex)),
        "welded": int(len(welded)),
        "rays": RAY_COUNT,
        "distance_m": CFG.AO_DISTANCE,
        "floor": CFG.AO_FLOOR,
        "gamma": CFG.AO_GAMMA,
        "min": float(per_vertex.min()),
        "mean": float(per_vertex.mean()),
    }


def main() -> None:
    CFG.ensure_dirs()
    report = {}
    for body_id, source in reference_bodies.promotion_inputs().items():
        report[body_id] = bake(body_id, source)
        entry = report[body_id]
        print(f"[shading] {body_id}: {entry['welded']} welded points, "
              f"min {entry['min']:.3f}, mean {entry['mean']:.3f} -> {entry['npy']}")
    with open(os.path.join(CFG.REPORT_DIR, "body_shading.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)


if __name__ == "__main__":
    main()
