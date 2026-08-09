"""Split the humanoid skin into the canonical hidden-coverage body zones.

Apparel is fitted to the skin with a millimetre of clearance, so any pose that
compresses a joint pushes skin through fabric. The runtime fix is the standard
one: an equipped item declares which body zones it encloses and the renderer
hides exactly those skin primitives. That needs the skin cut into primitives
named after the shared vocabulary in `client-3d/src/assets/pawnPack.ts`
(`PAWN_BODY_ZONES`), mirrored here as `ZONES` and re-checked against the
TypeScript source by `verify_body_zones.py`.

The cut is derived from the rig, never authored. Every joint maps to exactly one
zone (`JOINT_ZONE`), so a vertex's zone share is its skin weight regrouped, and
the zones form a tree rooted at the pelvis (`ZONE_TREE`) that mirrors the
skeleton. One cut is then solved per tree edge:

    f(edge) = 2 * (share of everything past the edge) - 1

`f > 0` means "this triangle belongs past that joint". A triangle's zone is
found by walking down from the pelvis while some child edge is still positive.
That construction is what makes the result well formed rather than merely
plausible:

  * a seam sits exactly where two bones trade influence, which on this rig is
    the joint -- the same place a garment's own seam sits (shoulder, elbow,
    wrist, waist, hip, knee, ankle), so a hidden zone matches what the fabric
    actually encloses;
  * child subtrees are disjoint, so at most one child edge can exceed 0.5 of the
    weight and the descent is unambiguous;
  * `f` is monotonically non-increasing down the tree, so a triangle can never
    be past the wrist without also being past the elbow. Zones therefore come
    out as bands in skeleton order and a seam can only ever join anatomical
    neighbours. `assert_adjacency` re-checks this on the finished labels;
  * Laplacian relaxation over the welded dual graph is applied to every field
    with the same non-negative stencil, so it straightens the single-triangle
    teeth a raw threshold leaves along a low-poly seam without breaking that
    ordering.

Stray specks -- patches too small to read as skin, where one facet's weights
disagree with its neighbourhood -- are then folded into the neighbour that owns
most of their boundary. Zones are NOT forced to a single patch: these bodies are
assembled from disjoint chunks (every finger link is its own closed box, the
forearms are separate tubes) and the low-poly neck is a band whose front and
back strips only meet through faces the head or torso claims, so a zone
legitimately arrives in several pieces. What matters for hiding is that a seam
is always a joint, which the tree construction guarantees and the assertions
re-check.

`RB_Face` is never part of this: it is the authored face panel, it carries the
only trustworthy UV island on the body, and no garment may hide it.
"""

from __future__ import annotations

import numpy as np

#: Canonical skin-coverage vocabulary. Order matches `PAWN_BODY_ZONES`.
ZONES = (
    "torso",
    "pelvis",
    "neck",
    "head",
    "left_upper_arm",
    "right_upper_arm",
    "left_forearm",
    "right_forearm",
    "left_hand",
    "right_hand",
    "left_thigh",
    "right_thigh",
    "left_calf",
    "right_calf",
    "left_foot",
    "right_foot",
)
ZONE_INDEX = {zone: index for index, zone in enumerate(ZONES)}

#: Runtime material name for one zone's skin primitive.
MATERIAL_PREFIX = "BodyZone_"
#: The authored face panel. Not a zone, never hidden, never renamed.
FACE_MATERIAL = "RB_Face"


def material_name(zone: str) -> str:
    return f"{MATERIAL_PREFIX}{zone}"


#: Rig side suffix -> zone side prefix. The rig is `_l`/`_r`; +x is the pawn's
#: left, which `assert_sides` re-checks against the finished labels.
SIDE = {"l": "left", "r": "right"}

#: Every one of the 50 joints belongs to exactly one zone.
#:
#: `root` sits on the floor under the pelvis and carries no skin weight on
#: either body; it is mapped to `pelvis` so the table is total rather than
#: because it shades anything, and `segment` asserts its share stays at zero.
#:
#: The clavicle is TORSO, not arm. It drives the trapezius and the top of the
#: shoulder -- the surface a garment's shoulder seam runs over -- while the
#: deltoid cap is already `upperarm`. Putting it in the arm would make a
#: sleeveless top's hidden torso stop at the collarbone and leave a ridge of
#: skin standing above the neckline.
JOINT_ZONE: dict[str, str] = {"root": "pelvis", "pelvis": "pelvis",
                              "spine_01": "torso", "spine_03": "torso",
                              "neck_01": "neck", "head": "head"}
for _side, _zone_side in SIDE.items():
    JOINT_ZONE[f"clavicle_{_side}"] = "torso"
    JOINT_ZONE[f"upperarm_{_side}"] = f"{_zone_side}_upper_arm"
    JOINT_ZONE[f"lowerarm_{_side}"] = f"{_zone_side}_forearm"
    JOINT_ZONE[f"hand_{_side}"] = f"{_zone_side}_hand"
    for _finger in ("index", "middle", "ring", "pinky", "thumb"):
        for _link in ("01", "02", "03"):
            JOINT_ZONE[f"{_finger}_{_link}_{_side}"] = f"{_zone_side}_hand"
    JOINT_ZONE[f"thigh_{_side}"] = f"{_zone_side}_thigh"
    JOINT_ZONE[f"calf_{_side}"] = f"{_zone_side}_calf"
    JOINT_ZONE[f"foot_{_side}"] = f"{_zone_side}_foot"

#: The zone tree, rooted where the skeleton is: the pelvis. Child order only
#: affects report ordering, never the labels.
ZONE_ROOT = "pelvis"
ZONE_TREE: dict[str, tuple[str, ...]] = {
    "pelvis": ("torso", "left_thigh", "right_thigh"),
    "torso": ("neck", "left_upper_arm", "right_upper_arm"),
    "neck": ("head",),
    "head": (),
}
for _zone_side in SIDE.values():
    ZONE_TREE[f"{_zone_side}_upper_arm"] = (f"{_zone_side}_forearm",)
    ZONE_TREE[f"{_zone_side}_forearm"] = (f"{_zone_side}_hand",)
    ZONE_TREE[f"{_zone_side}_hand"] = ()
    ZONE_TREE[f"{_zone_side}_thigh"] = (f"{_zone_side}_calf",)
    ZONE_TREE[f"{_zone_side}_calf"] = (f"{_zone_side}_foot",)
    ZONE_TREE[f"{_zone_side}_foot"] = ()


def _subtree(zone: str) -> tuple[str, ...]:
    out = [zone]
    for child in ZONE_TREE[zone]:
        out.extend(_subtree(child))
    return tuple(out)


#: `zone -> the zone and everything further from the pelvis`.
SUBTREE = {zone: _subtree(zone) for zone in ZONES}
#: One cut per tree edge, parent-first so a descent can follow the list.
TREE_EDGES = tuple((parent, child) for parent in ZONES
                   for child in ZONE_TREE[parent])
#: Which zones may share a seam: exactly the tree edges.
ADJACENCY: dict[str, frozenset[str]] = {
    zone: frozenset([child for child in ZONE_TREE[zone]]
                    + [parent for parent, child in TREE_EDGES if child == zone])
    for zone in ZONES
}

#: Position rounding used to weld shading-split vertices back into one surface.
#: The bodies are authored in metres, so this is a micrometre.
WELD_DECIMALS = 6
#: Cut relaxation. Three passes at 0.5 straightens the teeth a raw threshold
#: leaves on a low-poly seam; the field is already monotonic across a joint, so
#: relaxation only re-decides the tied ring rather than moving the seam.
RELAX_PASSES = 3
RELAX_WEIGHT = 0.5
#: A same-zone patch smaller than this is a speck, not skin: 2 cm2 is a 1.4 cm
#: square on a body with roughly 1.8 m2 of surface. Anything at that scale is a
#: facet whose weights disagree with its neighbourhood, and shipping it as its
#: own primitive would make a stray triangle blink when its zone is hidden.
SPECK_AREA_M2 = 2.0e-4


def zone_shares(joint_names: list[str], joints: np.ndarray,
                weights: np.ndarray) -> np.ndarray:
    """Per-vertex weight in each zone, from the skin binding alone."""
    out = np.zeros((len(joints), len(ZONES)), dtype=np.float64)
    columns = np.array([ZONE_INDEX[JOINT_ZONE[name]] for name in joint_names])
    rows = np.arange(len(joints))
    for slot in range(joints.shape[1]):
        np.add.at(out, (rows, columns[joints[:, slot]]), weights[:, slot])
    total = out.sum(axis=1, keepdims=True)
    return out / np.where(total > 1e-12, total, 1.0)


def weld(positions: np.ndarray) -> np.ndarray:
    """Map every vertex onto its welded surface point."""
    _, inverse = np.unique(np.round(positions, WELD_DECIMALS), axis=0,
                           return_inverse=True)
    return inverse.reshape(-1)


def dual_edges(faces: np.ndarray, welded: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Face pairs sharing a welded edge, both directions."""
    corners = welded[faces]
    edges = np.concatenate([corners[:, [0, 1]], corners[:, [1, 2]],
                            corners[:, [2, 0]]])
    owner = np.tile(np.arange(len(faces)), 3)
    keys = np.sort(edges, axis=1)
    order = np.lexsort((keys[:, 1], keys[:, 0]))
    keys, owner = keys[order], owner[order]
    same = np.flatnonzero((keys[:-1] == keys[1:]).all(axis=1))
    a, b = owner[same], owner[same + 1]
    return np.concatenate([a, b]), np.concatenate([b, a])


def relax(values: np.ndarray, edge_a: np.ndarray, edge_b: np.ndarray) -> np.ndarray:
    """Laplacian smoothing over the dual graph, columnwise."""
    degree = np.bincount(edge_a, minlength=len(values)).astype(np.float64)
    degree[degree == 0] = 1.0
    out = values.copy()
    for _ in range(RELAX_PASSES):
        total = np.zeros_like(out)
        np.add.at(total, edge_a, out[edge_b])
        out = (1.0 - RELAX_WEIGHT) * out + RELAX_WEIGHT * (total / degree[:, None])
    return out


def triangle_areas(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def descend(cuts: np.ndarray) -> np.ndarray:
    """Zone index per face, from one relaxed cut field per tree edge.

    `cuts[:, i]` is edge `TREE_EDGES[i]`'s field. Walk down from the root while
    some child edge is positive; the subtrees are disjoint so at most one can be.
    """
    edge_column = {pair: index for index, pair in enumerate(TREE_EDGES)}
    labels = np.full(len(cuts), ZONE_INDEX[ZONE_ROOT], dtype=np.int64)
    frontier = [ZONE_ROOT]
    while frontier:
        zone = frontier.pop()
        here = labels == ZONE_INDEX[zone]
        if not here.any():
            continue
        for child in ZONE_TREE[zone]:
            past = here & (cuts[:, edge_column[(zone, child)]] > 0.0)
            if past.any():
                labels[past] = ZONE_INDEX[child]
                frontier.append(child)
    return labels


def components(labels: np.ndarray, edge_a: np.ndarray,
               edge_b: np.ndarray) -> np.ndarray:
    """Root index of each face's connected same-zone patch.

    Min-label propagation with pointer jumping: every face starts as its own
    root and repeatedly takes the smallest root among itself and its same-zone
    neighbours until nothing moves.
    """
    keep = labels[edge_a] == labels[edge_b]
    a, b = edge_a[keep], edge_b[keep]
    component = np.arange(len(labels))
    while True:
        merged = component.copy()
        np.minimum.at(merged, a, component[b])
        merged = np.minimum(merged, merged[merged])
        if np.array_equal(merged, component):
            return component
        component = merged


def allowed_pairs() -> np.ndarray:
    """`allowed[a, b]` -- may zones `a` and `b` share a seam?"""
    allowed = np.eye(len(ZONES), dtype=bool)
    for zone, neighbours in ADJACENCY.items():
        for neighbour in neighbours:
            allowed[ZONE_INDEX[zone], ZONE_INDEX[neighbour]] = True
    return allowed


def absorb_specks(labels: np.ndarray, areas: np.ndarray, edge_a: np.ndarray,
                  edge_b: np.ndarray) -> tuple[np.ndarray, list[dict]]:
    """Fold negligible patches into the neighbour that owns most of their edge.

    A zone is NOT forced to a single patch. These bodies are assembled from
    disjoint chunks -- each finger link is its own closed box, the forearms are
    separate tubes -- so a zone legitimately arrives in several pieces, and the
    low-poly neck is a band whose front and back strips are only connected
    through faces the head or the torso claims. Collapsing a zone to its largest
    patch would delete most of that neck.

    What is worth removing is a speck: a patch too small to read as skin, which
    would otherwise ship as a stray two-triangle primitive that pops when its
    zone is hidden. A speck is only moved to an anatomical neighbour, and only
    when that move leaves every seam it touches anatomical -- so absorption can
    never invent a seam the skeleton does not have.
    """
    labels = labels.copy()
    absorbed: list[dict] = []
    allowed = allowed_pairs()
    while True:
        component = components(labels, edge_a, edge_b)
        mass = np.zeros(len(labels))
        np.add.at(mass, component, areas)
        changed = False
        for root in np.unique(component):
            if mass[root] > SPECK_AREA_M2:
                continue
            island = component == root
            cross = island[edge_a] & ~island[edge_b]
            if not cross.any():
                continue                      # a detached chunk, not a speck
            zone = int(labels[root])
            outside = labels[edge_b[cross]]
            shares = np.zeros(len(ZONES))
            np.add.at(shares, outside, areas[edge_b[cross]])
            for target in np.argsort(-shares):
                target = int(target)
                if shares[target] <= 0.0 or target == zone:
                    break
                if allowed[zone, target] and allowed[target, outside].all():
                    absorbed.append({"from": ZONES[zone], "to": ZONES[target],
                                     "faces": int(island.sum()),
                                     "area_cm2": round(float(mass[root]) * 1.0e4, 4)})
                    labels[island] = target
                    changed = True
                    break
        if not changed:
            return labels, absorbed


def assert_adjacency(labels: np.ndarray, edge_a: np.ndarray,
                     edge_b: np.ndarray, body_id: str) -> list[list[str]]:
    """Every seam has to be between anatomically neighbouring zones."""
    seams = sorted({tuple(sorted((ZONES[int(x)], ZONES[int(y)])))
                    for x, y in zip(labels[edge_a], labels[edge_b]) if x != y})
    illegal = [pair for pair in seams if pair[1] not in ADJACENCY[pair[0]]]
    if illegal:
        raise SystemExit(f"{body_id}: non-anatomical zone seams {illegal}")
    return [list(pair) for pair in seams]


def assert_sides(labels: np.ndarray, centroids: np.ndarray, body_id: str) -> None:
    """`left_*` lives at +x, `right_*` at -x, with no crossing triangle."""
    for index, zone in enumerate(ZONES):
        if not zone.startswith(("left_", "right_")):
            continue
        picked = labels == index
        if not picked.any():
            continue
        x = centroids[picked, 0]
        wrong = int((x <= 0.0).sum() if zone.startswith("left_")
                    else (x >= 0.0).sum())
        if wrong:
            raise SystemExit(f"{body_id}: {wrong} {zone} triangles on the wrong side")


def segment(positions: np.ndarray, faces: np.ndarray, joint_names: list[str],
            joints: np.ndarray, weights: np.ndarray,
            body_id: str) -> tuple[np.ndarray, dict]:
    """Label every skin triangle with one canonical zone.

    `positions`/`joints`/`weights` are the merged skin soup (face panel
    excluded) and `faces` indexes it. Returns the per-triangle zone index plus a
    report describing the cut.
    """
    root_share = float(sum(weights[joints == slot].sum()
                           for slot, name in enumerate(joint_names)
                           if name == "root"))
    if root_share > 1.0e-6:
        raise SystemExit(f"{body_id}: `root` carries {root_share:.6f} skin weight; "
                         "the joint -> zone table assumes none")

    shares = zone_shares(joint_names, joints, weights)[faces].mean(axis=1)
    welded = weld(positions)
    edge_a, edge_b = dual_edges(faces, welded)
    areas = triangle_areas(positions, faces)
    centroids = positions[faces].mean(axis=1)

    cuts = np.empty((len(faces), len(TREE_EDGES)))
    for column, (_, child) in enumerate(TREE_EDGES):
        past = [ZONE_INDEX[zone] for zone in SUBTREE[child]]
        cuts[:, column] = 2.0 * shares[:, past].sum(axis=1) - 1.0
    labels = descend(relax(cuts, edge_a, edge_b))
    labels, absorbed = absorb_specks(labels, areas, edge_a, edge_b)

    seams = assert_adjacency(labels, edge_a, edge_b, body_id)
    assert_sides(labels, centroids, body_id)

    counts = np.bincount(labels, minlength=len(ZONES))
    missing = [ZONES[index] for index in range(len(ZONES)) if counts[index] == 0]
    if missing:
        raise SystemExit(f"{body_id}: zones with no skin: {missing}")
    component = components(labels, edge_a, edge_b)
    report = {
        "welded_points": int(welded.max()) + 1,
        "boundary_edges": int(len(faces) * 3 - len(edge_a)),
        "relax_passes": RELAX_PASSES,
        "relax_weight": RELAX_WEIGHT,
        "speck_area_cm2": round(SPECK_AREA_M2 * 1.0e4, 4),
        "specks_absorbed": absorbed,
        "seams": seams,
        "zones": {ZONES[index]: {
            "triangles": int(counts[index]),
            "patches": int(len(np.unique(component[labels == index]))),
            "area_cm2": round(float(areas[labels == index].sum()) * 1.0e4, 3),
            "centroid_y_range_m": [
                round(float(centroids[labels == index, 1].min()), 4),
                round(float(centroids[labels == index, 1].max()), 4)],
        } for index in range(len(ZONES))},
    }
    return labels, report
