"""Prove every hair piece and non-hair wearable actually sits on the body, on BOTH bodies.

The humanoid refit guarantees:
  1. Every hair style seats within 3.0 mm of the scalp, buries no deeper than
     60 mm, leaves at most 8 un-covered scalp vertices inside its footprint,
     and seats within 25.0 mm of its opposite-sex variant.
  2. Non-hair wearables (armor, tops, legs, gloves, boots, helmets) respect
     category-specific standoff bands and hard burial limits.
  3. Rigid attachments (11 custom weapons + 3 legacy weapon rigs + hat_field_cap)
     resolve their socket transform exactly as pawn/catalog.rs does, and are
     measured against both skeletons for clearance, burial depth, and mount
     position delta.
"""

from __future__ import annotations

import json
import os
import sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import pose_probe as POSE  # noqa: E402
import refit_config as CFG  # noqa: E402
from gltf_io import Glb  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/verify_wearable_fit.py"

REPO = os.path.abspath(os.path.join(LAB_DIR, "..", "..", ".."))
EQUIPMENT = os.path.join(REPO, "client-3d", "public", "assets",
                         "pawn-pack", "equipment")

#: Skin a cap vertex must come within to count as resting on the head.
CONTACT_BAND_MM = 2.0
#: A cap whose closest point never reaches the skin is floating: the skull
#: shows through the gap and the hair reads as a hat hovering above the head.
FLOAT_LIMIT_MM = 3.0
#: A cap is MEANT to cross the scalp -- a rim that stops at the skin leaves a
#: slot. Across the shipped set the crossing measures 11..46 mm (median 28),
#: so this rejects a piece swallowed well past the authored band rather than
#: pretending shallow is better.
BURIED_LIMIT_MM = 60.0
#: The male and female variants are refits of one style, so they may differ by
#: a head-size margin. The shipped set differs by at most 9.8 mm; a piece that
#: disagrees by more than this has been fitted to one body only.
VARIANT_DELTA_LIMIT_MM = 25.0
#: Where the scalp starts, as a fraction of head-zone height. Below the brow
#: the skin is face and jaw, which hair is not answerable for.
BROW_HEIGHT_FRACTION = 0.45
#: A vertex whose outward normal points this strongly toward the face is part
#: of the face shell, not the scalp, even when it sits above the brow.
FACE_NORMAL_LIMIT = 0.5
#: How far out from the skin a cover probe looks for hair. Anything further
#: than this is a silhouette the scalp was never behind.
COVER_PROBE_MM = 80.0
#: A bare skull vertex counts as a poke-through when at least this share of its
#: neighbours ARE covered: the cap is present all around it and stops short
#: only there, which is the hole the player sees. A vertex on the open edge of
#: the style -- a hairline, a shaved back, the gap beside a ponytail -- has bare
#: neighbours too and is left alone.
POKE_NEIGHBOUR_FRACTION = 0.75
#: The probe samples the scalp at its vertices, so a cap that genuinely
#: envelops still misses a few along the brow edge of the mask. Measured
#: against the helmets, which are built to swallow the skull whole: they leave
#: 5-7. Anything past that is the style itself failing to cover, and the refit
#: target is zero.
POKE_LIMIT = 8
#: Skin zones that define the skull reference the crown is measured against.
HEAD_ZONES = ("head", "neck")

#: Non-hair wearable category seating rules: standoff band [min, max] and hard burial limit.
#:
#: Category justifications:
#: - boots: Footwear wraps tightly around feet and ankles; standoff > 10.0 mm hovers off the foot,
#:   while burial depth > 10.0 mm swallows foot/ankle skin.
#: - gloves: Enclose fingers and wrists closely; standoff > 15.0 mm leaves hover gaps,
#:   while burial depth > 20.0 mm causes hand skin poke-through.
#: - legs: Trousers and skirts drape over legs; standoff > 15.0 mm creates ballooning gaps,
#:   while burial depth > 10.0 mm swallows thigh/leg skin.
#: - tops: Torso vests and shirts sit on chest and waist; standoff > 15.0 mm hovers off torso,
#:   while burial depth > 12.0 mm swallows chest/stomach skin.
#: - armor: Hard shoulder pads, back packs, and chest harnesses carry thicker plate geometry and tight straps;
#:   standoff > 30.0 mm detaches from torso frame, while burial depth > 30.0 mm buries chest/hip plates.
#: - helmets: Full-head caps and helmets envelop the skull whole (depth up to 65.0 mm),
#:   but must not float > 20.0 mm off the skull or penetrate past 65.0 mm.
CATEGORY_RULES = {
    "boots":   {"standoff_min_mm": -10.0, "standoff_max_mm": 10.0, "burial_limit_mm": 10.0},
    "gloves":  {"standoff_min_mm": -20.0, "standoff_max_mm": 15.0, "burial_limit_mm": 20.0},
    "legs":    {"standoff_min_mm": -10.0, "standoff_max_mm": 15.0, "burial_limit_mm": 10.0},
    "tops":    {"standoff_min_mm": -12.0, "standoff_max_mm": 15.0, "burial_limit_mm": 12.0},
    "armor":   {"standoff_min_mm": -30.0, "standoff_max_mm": 30.0, "burial_limit_mm": 30.0},
    "helmets": {"standoff_min_mm": -65.0, "standoff_max_mm": 20.0, "burial_limit_mm": 65.0},
}


def variant_path(body_id: str, relative: str) -> str:
    root = EQUIPMENT if body_id == "male" else os.path.join(EQUIPMENT, "Female")
    return os.path.join(root, relative)


def wearables() -> list[str]:
    """Every authored piece that has to fit both bodies."""
    found: list[str] = []
    for folder in ("Under", "Armor"):
        directory = os.path.join(EQUIPMENT, folder)
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if name.endswith(".glb"):
                found.append(f"{folder}/{name}")
    return found


def is_hair(relative: str) -> bool:
    return "hair" in os.path.basename(relative).lower()


def get_category(relative: str) -> str:
    name = os.path.splitext(os.path.basename(relative))[0]
    lname = name.lower()
    if is_hair(relative):
        return "hair"
    elif lname.startswith("boots"):
        return "boots"
    elif lname.startswith("gloves"):
        return "gloves"
    elif lname.startswith("legs") or name in ("Shorts", "SCFI_Pants_Refit"):
        return "legs"
    elif lname.startswith("top") or name in ("Tank", "under_bodysuit", "SCFI_Top_Refit"):
        return "tops"
    elif lname.startswith("armor") or lname.startswith("trial_hip") or lname.startswith("trial_back") or name in ("Bicep_L", "Bicep_R", "Gorget", "Harness", "Nape_Reinforcement", "Reinforcement"):
        return "armor"
    elif lname.startswith("helmet") or lname.startswith("trial_helm") or lname.startswith("trial_hood") or lname.startswith("trial_visor") or lname.startswith("trial_mask") or name in ("Hat_Warm", "field_cap"):
        return "helmets"
    else:
        return "other"


def vertex_normals(position, faces, indices):
    """Area-weighted outward normal per skull vertex, in body space."""
    accumulated = np.zeros((len(position), 3), dtype=np.float64)
    corners = position[faces]
    cross = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    for slot in range(3):
        np.add.at(accumulated, faces[:, slot], cross)
    lengths = np.linalg.norm(accumulated, axis=1)
    lengths[lengths == 0.0] = 1.0
    return accumulated[indices] / lengths[indices, None]


def vertex_neighbours(faces, indices):
    """Adjacency among the given vertices, from the faces that share them."""
    wanted = set(int(index) for index in indices)
    adjacency: dict[int, set[int]] = {index: set() for index in wanted}
    for face in faces:
        for slot, vertex in enumerate(face):
            vertex = int(vertex)
            if vertex not in wanted:
                continue
            for other in (face[(slot + 1) % 3], face[(slot + 2) % 3]):
                other = int(other)
                if other in wanted:
                    adjacency[vertex].add(other)
    return adjacency


def scalp_vertices(position, indices, normals):
    """The part of the skull hair is responsible for covering.

    Not the whole head. The face is bare by design and the neck is nobody's
    job, so probing them reports the open front of a helm as a hole. The scalp
    is what remains: the cranium above the brow, minus the forward-facing
    shell that carries the face.
    """
    points = position[indices]
    low, high = float(points[:, 1].min()), float(points[:, 1].max())
    brow = low + (high - low) * BROW_HEIGHT_FRACTION
    # Whichever way the face points, it is the axis the head is deepest along.
    middle = float(np.median(points[:, 2]))
    forward = 1.0 if float(points[:, 2].max()) - middle >= middle - float(points[:, 2].min()) else -1.0
    facing = normals[:, 2] * forward
    return np.where((points[:, 1] >= brow) & (facing < FACE_NORMAL_LIMIT))[0]


def scalp_exposure(cap, skull_indices, scalp_slots, position, normals, adjacency):
    """Skull left bare inside the cap's own footprint.

    The seating measures above all run cap-to-body: they prove the hair TOUCHES
    the head. None of them can see the opposite defect, where the cap is too
    small or too tight and the skull pushes out through it -- every cap vertex
    still rests on skin while the crown pokes into open air. This probes the
    other direction, skull outward, and reports the holes.
    """
    cap_tree = BVHTree.FromPolygons(
        [tuple(point) for point in cap.position],
        [tuple(face) for face in cap.faces])
    reach = COVER_PROBE_MM / 1000.0
    covered: dict[int, bool] = {}
    for slot in scalp_slots:
        index = skull_indices[slot]
        point = position[index]
        normal = normals[slot]
        origin = Vector((float(point[0] + normal[0] * 1.0e-5),
                         float(point[1] + normal[1] * 1.0e-5),
                         float(point[2] + normal[2] * 1.0e-5)))
        hit, _, _, _ = cap_tree.ray_cast(
            origin, Vector((float(normal[0]), float(normal[1]), float(normal[2]))), reach)
        covered[int(index)] = hit is not None
    holes = 0
    for index, is_covered in covered.items():
        if is_covered:
            continue
        neighbours = adjacency.get(index) or ()
        if not neighbours:
            continue
        share = sum(1 for other in neighbours if covered.get(other)) / len(neighbours)
        if share >= POKE_NEIGHBOUR_FRACTION:
            holes += 1
    return holes, sum(1 for value in covered.values() if value), len(covered)


def quat_matrix(q: list[float] | np.ndarray) -> np.ndarray:
    x, y, z, w = q
    return np.array([
        [1 - 2*(y**2 + z**2), 2*(x*y - z*w),     2*(x*z + y*w),     0],
        [2*(x*y + z*w),     1 - 2*(x**2 + z**2), 2*(y*z - x*w),     0],
        [2*(x*z - y*w),     2*(y*z + x*w),     1 - 2*(x**2 + y**2), 0],
        [0,                 0,                 0,                 1]
    ], dtype=np.float64)


def trs_matrix(pos: list[float], quat: list[float], scale: float = 1.0) -> np.ndarray:
    m = quat_matrix(quat)
    m[:3, :3] *= scale
    m[:3, 3] = pos
    return m


def load_glb_vertices(glb_path: str, model_scale: float = 1.0) -> np.ndarray:
    g = Glb.load(glb_path)
    nodes = g.json["nodes"]
    count = len(nodes)
    parent: dict[int, int] = {}
    for idx, node in enumerate(nodes):
        for child in node.get("children", ()):
            parent[child] = idx

    roots = g.json.get("scenes", [{}])[0].get("nodes", []) if "scenes" in g.json else []
    if not roots:
        has_p = set(parent.keys())
        roots = [i for i in range(count) if i not in has_p]

    def get_local(n: dict) -> np.ndarray:
        if "matrix" in n:
            return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        t = np.array(n.get("translation", [0, 0, 0]), dtype=np.float64)
        r = np.array(n.get("rotation", [0, 0, 0, 1]), dtype=np.float64)
        s = np.array(n.get("scale", [1, 1, 1]), dtype=np.float64)
        m = np.eye(4)
        m[:3, :3] = quat_matrix(r)[:3, :3] * s
        m[:3, 3] = t
        return m

    cache: dict[int, np.ndarray] = {}

    def get_global(idx: int) -> np.ndarray:
        if idx not in cache:
            l = get_local(nodes[idx])
            p = parent.get(idx)
            cache[idx] = l if p is None else get_global(p) @ l
        return cache[idx]

    all_verts = []
    for idx, node in enumerate(nodes):
        if "mesh" in node:
            mesh_idx = node["mesh"]
            mesh = g.json["meshes"][mesh_idx]
            g_mat = get_global(idx)
            if abs(model_scale - 1.0) > 1e-5:
                s_mat = np.eye(4)
                s_mat[0, 0] = s_mat[1, 1] = s_mat[2, 2] = model_scale
                g_mat = s_mat @ g_mat
            for prim in mesh["primitives"]:
                pos_acc = prim["attributes"]["POSITION"]
                pos_data = g.accessor(pos_acc).astype(np.float64)
                ones = np.ones((len(pos_data), 1))
                pos_h = np.hstack([pos_data, ones])
                pos_world = (g_mat @ pos_h.T).T[:, :3]
                all_verts.append(pos_world)
    if not all_verts:
        return np.zeros((0, 3))
    return np.vstack(all_verts)


def probe_rigid_mounts(male: POSE.Body, female: POSE.Body) -> tuple[dict[str, dict], list[str]]:
    """Probe rigid attachments and weapons across male and female skeletons."""
    male_world = male.rig.world(None, 0.0)
    female_world = female.rig.world(None, 0.0)

    male_tree = BVHTree.FromPolygons([tuple(p) for p in male.position], [tuple(f) for f in male.faces])
    female_tree = BVHTree.FromPolygons([tuple(p) for p in female.position], [tuple(f) for f in female.faces])

    rigid_items = []
    field_cap_path = os.path.normpath(os.path.join(CFG.ASSETS, "items/custom/accessories/field_cap.glb"))
    rigid_items.append({
        "id": "hat_field_cap",
        "glb": field_cap_path,
        "bone": "head",
        "mount_pos": [0.0, 0.0, 0.0],
        "mount_quat": [0.0, 0.0, 0.0, 1.0],
        "scale": 1.0
    })

    legacy_weapons = [
        ("slugthrower", "slugthrower.glb", "slugthrower_attach.json"),
        ("vibrosword", "vibrosword.glb", "vibrosword_attach.json"),
        ("plasma_hilt", "plasma_hilt.glb", "vibrosword_attach.json"),
    ]
    for item_id, glb_name, attach_name in legacy_weapons:
        gpath = os.path.normpath(os.path.join(CFG.ASSETS, "pawn-pack", glb_name))
        apath = os.path.normpath(os.path.join(CFG.ASSETS, "pawn-pack", attach_name))
        with open(apath) as f:
            spec = json.load(f)
        m = spec["mount_hand_r_local"]
        rigid_items.append({
            "id": item_id,
            "glb": gpath,
            "bone": "hand_r",
            "mount_pos": m["pos"],
            "mount_quat": m["quat"],
            "scale": spec.get("scale_to_pawn", 1.0)
        })

    weapons_manifest_path = os.path.join(CFG.ASSETS, "pawn-pack/weapons/weapons_manifest.json")
    with open(weapons_manifest_path) as f:
        cmanifest = json.load(f)

    for item in cmanifest["items"]:
        item_id = item["id"]
        gpath = os.path.normpath(os.path.join(CFG.ASSETS, "pawn-pack/weapons", item["glb"]))
        apath = os.path.normpath(os.path.join(CFG.ASSETS, "pawn-pack/weapons", item["attach"]))
        with open(apath) as f:
            spec = json.load(f)
        m = spec["mount_hand_r_local"]
        m_scale = spec.get("scale_to_pawn", item.get("scale", 1.0))
        rigid_items.append({
            "id": item_id,
            "glb": gpath,
            "bone": "hand_r",
            "mount_pos": m["pos"],
            "mount_quat": m["quat"],
            "scale": m_scale
        })

    results = {}
    failures = []

    for item in rigid_items:
        item_id = item["id"]
        verts_local = load_glb_vertices(item["glb"], item["scale"])
        mount_mat = trs_matrix(item["mount_pos"], item["mount_quat"])

        m_bone = male_world[item["bone"]]
        m_mount_world_mat = m_bone @ mount_mat
        m_mount_pos = m_mount_world_mat[:3, 3]

        f_bone = female_world[item["bone"]]
        f_mount_world_mat = f_bone @ mount_mat
        f_mount_pos = f_mount_world_mat[:3, 3]

        pos_delta_mm = float(np.linalg.norm(m_mount_pos - f_mount_pos) * 1000.0)

        m_signed = []
        if len(verts_local) > 0:
            verts_h = np.hstack([verts_local, np.ones((len(verts_local), 1))])
            m_verts_world = (m_mount_world_mat @ verts_h.T).T[:, :3]
            for pt in m_verts_world:
                loc, norm, _, dist = male_tree.find_nearest(Vector((float(pt[0]), float(pt[1]), float(pt[2]))))
                if loc is None:
                    continue
                outward = (float(pt[0]) - loc.x, float(pt[1]) - loc.y, float(pt[2]) - loc.z)
                inside = (outward[0]*norm.x + outward[1]*norm.y + outward[2]*norm.z) < 0.0
                m_signed.append(dist * 1000.0 * (-1.0 if inside else 1.0))

        m_clear = float(np.min(m_signed)) if m_signed else 0.0
        m_depth = max(0.0, -m_clear)

        f_signed = []
        if len(verts_local) > 0:
            verts_h = np.hstack([verts_local, np.ones((len(verts_local), 1))])
            f_verts_world = (f_mount_world_mat @ verts_h.T).T[:, :3]
            for pt in f_verts_world:
                loc, norm, _, dist = female_tree.find_nearest(Vector((float(pt[0]), float(pt[1]), float(pt[2]))))
                if loc is None:
                    continue
                outward = (float(pt[0]) - loc.x, float(pt[1]) - loc.y, float(pt[2]) - loc.z)
                inside = (outward[0]*norm.x + outward[1]*norm.y + outward[2]*norm.z) < 0.0
                f_signed.append(dist * 1000.0 * (-1.0 if inside else 1.0))

        f_clear = float(np.min(f_signed)) if f_signed else 0.0
        f_depth = max(0.0, -f_clear)

        # Check for rigid mount fit deviations
        if item_id == "hat_field_cap" and f_clear > FLOAT_LIMIT_MM:
            failures.append(f"rigid: {item_id} female mount floats {f_clear:.1f} mm above scalp (male clearance {m_clear:.1f} mm)")

        results[item_id] = {
            "bone": item["bone"],
            "male": {
                "clearance_mm": round(m_clear, 3),
                "max_depth_mm": round(m_depth, 3),
                "mount_world_pos": [round(x, 5) for x in m_mount_pos],
            },
            "female": {
                "clearance_mm": round(f_clear, 3),
                "max_depth_mm": round(f_depth, 3),
                "mount_world_pos": [round(x, 5) for x in f_mount_pos],
            },
            "delta_pos_mm": round(pos_delta_mm, 3),
            "delta_clearance_mm": round(abs(m_clear - f_clear), 3)
        }

    return results, failures


def main() -> None:
    CFG.ensure_dirs()
    report = {"generator": GENERATOR,
              "contact_band_mm": CONTACT_BAND_MM,
              "float_limit_mm": FLOAT_LIMIT_MM,
              "buried_limit_mm": BURIED_LIMIT_MM,
              "variant_delta_limit_mm": VARIANT_DELTA_LIMIT_MM,
              "category_rules": CATEGORY_RULES,
              "bodies": {}}
    failures: list[str] = []
    pieces = wearables()

    male_body = None
    female_body = None

    for body_id in ("male", "female"):
        body = POSE.Body(body_id)
        if body_id == "male":
            male_body = body
        else:
            female_body = body

        head_faces = np.concatenate([faces for zone, faces
                                     in body.zone_faces.items()
                                     if zone in HEAD_ZONES])
        skull_indices = np.unique(head_faces.reshape(-1))
        skin = body.position[skull_indices]
        skull_top = float(skin[:, 1].max())
        skull_normals = vertex_normals(body.position, body.faces, skull_indices)
        scalp_slots = scalp_vertices(body.position, skull_indices, skull_normals)
        skull_adjacency = vertex_neighbours(head_faces, skull_indices)

        body_tree = BVHTree.FromPolygons(
            [tuple(point) for point in body.position],
            [tuple(face) for face in body.faces])
        items: dict[str, dict[str, float | str | bool]] = {}

        for relative in pieces:
            path = variant_path(body_id, relative)
            if not os.path.exists(path):
                failures.append(f"{body_id}: {relative} has no variant")
                continue
            cap = POSE.SkinnedGeometry(path, f"{relative}:{body_id}")
            points = cap.position
            signed_mm = np.empty(len(points), dtype=np.float64)
            for slot, point in enumerate(points):
                location, normal, _, distance = body_tree.find_nearest(
                    Vector((float(point[0]), float(point[1]), float(point[2]))))
                if location is None:
                    signed_mm[slot] = np.inf
                    continue
                outward = (float(point[0]) - location.x,
                           float(point[1]) - location.y,
                           float(point[2]) - location.z)
                inside = (outward[0] * normal.x + outward[1] * normal.y
                          + outward[2] * normal.z) < 0.0
                signed_mm[slot] = distance * 1000.0 * (-1.0 if inside else 1.0)

            nearest_mm = float(signed_mm.min())
            contact = float((np.abs(signed_mm) <= CONTACT_BAND_MM).mean())
            crown_mm = (float(points[:, 1].max()) - skull_top) * 1000.0
            name = os.path.splitext(os.path.basename(relative))[0]
            depth_mm = max(0.0, -nearest_mm)
            holes, covered, probed = scalp_exposure(
                cap, skull_indices, scalp_slots, body.position, skull_normals,
                skull_adjacency)
            cat = get_category(relative)

            items[name] = {"nearest_surface_mm": round(nearest_mm, 3),
                           "max_depth_mm": round(depth_mm, 3),
                           "contact_fraction": round(contact, 4),
                           "crown_clearance_mm": round(crown_mm, 2),
                           "scalp_poke_vertices": holes,
                           "scalp_covered_vertices": covered,
                           "scalp_probed_vertices": probed,
                           "hair": is_hair(relative),
                           "category": cat,
                           "vertices": int(len(points))}

            # Category seating checks
            if cat == "hair":
                if nearest_mm > FLOAT_LIMIT_MM:
                    failures.append(f"{body_id}: {name} never reaches the "
                                    f"scalp ({nearest_mm:.2f} mm clear)")
                elif depth_mm > BURIED_LIMIT_MM:
                    failures.append(f"{body_id}: {name} is buried "
                                    f"{depth_mm:.1f} mm into the body")
                if holes > POKE_LIMIT:
                    failures.append(f"{body_id}: {name} lets the skull through "
                                    f"at {holes} points inside its own cap")
            else:
                rules = CATEGORY_RULES[cat]
                if nearest_mm > rules["standoff_max_mm"]:
                    failures.append(f"{body_id}: {name} ({cat}) standoff {nearest_mm:.1f} mm "
                                    f"exceeds max standoff {rules['standoff_max_mm']:.1f} mm")
                elif nearest_mm < rules["standoff_min_mm"]:
                    failures.append(f"{body_id}: {name} ({cat}) standoff {nearest_mm:.1f} mm "
                                    f"below min standoff {rules['standoff_min_mm']:.1f} mm")
                if depth_mm > rules["burial_limit_mm"]:
                    failures.append(f"{body_id}: {name} ({cat}) burial depth {depth_mm:.1f} mm "
                                    f"exceeds hard limit {rules['burial_limit_mm']:.1f} mm")

        report["bodies"][body_id] = {"skull_top_m": round(skull_top, 5),
                                     "items": items}
        hairs = [v for v in items.values() if v["hair"]]
        seated = sum(1 for v in hairs
                     if v["nearest_surface_mm"] <= FLOAT_LIMIT_MM)
        leaking = sum(1 for v in hairs
                      if v["scalp_poke_vertices"] > POKE_LIMIT)
        print(f"[fitcheck] {body_id}: {len(items)} pieces measured, "
              f"{seated}/{len(hairs)} hairs seated, "
              f"{leaking}/{len(hairs)} leaking scalp")

    male_items = report["bodies"]["male"]["items"]
    female_items = report["bodies"]["female"]["items"]
    for name, male_fit in sorted(male_items.items()):
        female_fit = female_items.get(name)
        if female_fit is None:
            failures.append(f"{name} has no female variant")
            continue
        delta = abs(male_fit["max_depth_mm"] - female_fit["max_depth_mm"])
        if delta > VARIANT_DELTA_LIMIT_MM:
            failures.append(f"{name}: male and female seat {delta:.1f} mm "
                            f"apart ({male_fit['max_depth_mm']:.1f} vs "
                            f"{female_fit['max_depth_mm']:.1f})")

    if male_body and female_body:
        rigid_results, rigid_failures = probe_rigid_mounts(male_body, female_body)
        report["rigid_mounts"] = rigid_results
        failures.extend(rigid_failures)
        print(f"[fitcheck] {len(rigid_results)} rigid weapon/accessory mounts probed")

    report["failures"] = failures
    out = os.path.join(CFG.REPORT_DIR, "wearable_fit.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")

    print(f"[fitcheck] Report written to {out}")

    if failures:
        print(f"[fitcheck] FAIL ({len(failures)})")
        for failure in failures:
            print(f"[fitcheck]   {failure}")
        raise SystemExit(1)
    print("[fitcheck] PASS")


if __name__ == "__main__":
    main()
