"""Region-aware old-body -> new-body deformation field.

Every catalogued garment is skinned to the same 50-joint rig with the same bind
pose, so a refit only has to move bind-pose POSITIONS: joints, weights, indices,
materials and UVs stay untouched and the piece keeps deforming exactly as it was
authored.

The field is RADIAL, not nearest-point. A nearest-point wrap silently collapses
wherever the change is large: the promoted male abdomen stands up to 8 cm
further forward than the reference body, and the nearest patch of new skin to an
old belly vertex is a few millimetres away on a neighbouring facet, so the
measured "displacement" comes out at 4 mm and the trousers end up inside the
pelvis. Instead each body is resampled into per-region rig-space profiles --
r(axial, angle) around a limb axis, r(azimuth, elevation) for the head -- and a
garment vertex is moved by the CHANGE IN PROFILE under it, along its own radial
direction. That is what preserves an authored clearance: cloth 30 mm off a thigh
stays 30 mm off the new thigh, and a pauldron keeps standing proud.

Regions come from the garment's own skin weights, blended, which is the only
body-part signal a garment reliably carries.
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

# ---------------------------------------------------------------- regions

BONE_REGION = {}
for _bone in ("root", "pelvis", "spine_01", "spine_03"):
    BONE_REGION[_bone] = "torso"
BONE_REGION["neck_01"] = "neck"
BONE_REGION["head"] = "head"
for _side in ("l", "r"):
    # The clavicle belongs to the ARM profile, not the trunk. A single vertical
    # torso cylinder cannot describe the shoulder girdle: at shoulder height its
    # radius jumps from the neck to the deltoid tip, so two bodies tessellated
    # differently disagree by 8 cm in the same cell. Measured from the shoulder
    # joint outward along the arm axis, the same surface is a clean profile.
    BONE_REGION[f"clavicle_{_side}"] = f"arm_{_side}"
    BONE_REGION[f"upperarm_{_side}"] = f"arm_{_side}"
    BONE_REGION[f"lowerarm_{_side}"] = f"arm_{_side}"
    BONE_REGION[f"hand_{_side}"] = f"hand_{_side}"
    for _finger in ("index", "middle", "ring", "pinky", "thumb"):
        for _link in ("01", "02", "03"):
            BONE_REGION[f"{_finger}_{_link}_{_side}"] = f"hand_{_side}"
    BONE_REGION[f"thigh_{_side}"] = f"leg_{_side}"
    BONE_REGION[f"calf_{_side}"] = f"leg_{_side}"
    BONE_REGION[f"foot_{_side}"] = f"foot_{_side}"

REGIONS = ("torso", "neck", "head", "arm_l", "arm_r", "hand_l", "hand_r",
           "leg_l", "leg_r", "foot_l", "foot_r")
REGION_INDEX = {name: index for index, name in enumerate(REGIONS)}

#: How each region is parameterised. `cyl` sweeps an axis, `sph` a centre.
REGION_FRAME = {
    "torso": ("cyl", "pelvis", (0.0, 1.0, 0.0)),
    "neck": ("cyl", "neck_01", (0.0, 1.0, 0.0)),
    "head": ("sph", "head", None),
    "arm_l": ("cyl", "upperarm_l", (1.0, 0.0, 0.0)),
    "arm_r": ("cyl", "upperarm_r", (-1.0, 0.0, 0.0)),
    "hand_l": ("cyl", "hand_l", (1.0, 0.0, 0.0)),
    "hand_r": ("cyl", "hand_r", (-1.0, 0.0, 0.0)),
    "leg_l": ("cyl", "thigh_l", (0.0, -1.0, 0.0)),
    "leg_r": ("cyl", "thigh_r", (0.0, -1.0, 0.0)),
    "foot_l": ("cyl", "foot_l", (0.0, 0.0, 1.0)),
    "foot_r": ("cyl", "foot_r", (0.0, 0.0, 1.0)),
}

#: Bone weight below which a region stops claiming a vertex at all.
REGION_WEIGHT_FLOOR = 0.06
#: Profile grid. Coarse on purpose: it must describe a silhouette, not a facet.
AXIAL_CELLS = 30
ANGULAR_CELLS = 32
PROFILE_SMOOTH_PASSES = 1


def region_weights(joint_names: list[str], joints: np.ndarray,
                   weights: np.ndarray) -> np.ndarray:
    """Per-vertex weight in each region, from the skin binding."""
    lookup = np.array([REGION_INDEX[BONE_REGION.get(name, "torso")]
                       for name in joint_names], dtype=np.int64)
    out = np.zeros((len(joints), len(REGIONS)))
    for column in range(joints.shape[1]):
        np.add.at(out, (np.arange(len(joints)), lookup[joints[:, column]]),
                  weights[:, column])
    total = out.sum(1, keepdims=True)
    return out / np.where(total > 1e-9, total, 1.0)


def dominant_region(joint_names: list[str], joints: np.ndarray,
                    weights: np.ndarray) -> np.ndarray:
    return np.argmax(region_weights(joint_names, joints, weights), axis=1)


# ---------------------------------------------------------------- geometry


def point_triangle(points, a, b, c):
    """Closest point on each triangle (Ericson, Real-Time Collision Detection)."""
    ab, ac, ap = b - a, c - a, points - a
    d1 = (ab * ap).sum(1)
    d2 = (ac * ap).sum(1)
    out = np.empty_like(points)
    m1 = (d1 <= 0) & (d2 <= 0)
    out[m1] = a[m1]
    bp = points - b
    d3 = (ab * bp).sum(1)
    d4 = (ac * bp).sum(1)
    m2 = (~m1) & (d3 >= 0) & (d4 <= d3)
    out[m2] = b[m2]
    vc = d1 * d4 - d3 * d2
    m3 = (~m1) & (~m2) & (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    denom = np.where(d1 - d3 == 0, 1.0, d1 - d3)
    out[m3] = (a + (d1 / denom)[:, None] * ab)[m3]
    cp = points - c
    d5 = (ab * cp).sum(1)
    d6 = (ac * cp).sum(1)
    m4 = (~m1) & (~m2) & (~m3) & (d6 >= 0) & (d5 <= d6)
    out[m4] = c[m4]
    vb = d5 * d2 - d1 * d6
    m5 = (~m1) & (~m2) & (~m3) & (~m4) & (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    denom = np.where(d2 - d6 == 0, 1.0, d2 - d6)
    out[m5] = (a + (d2 / denom)[:, None] * ac)[m5]
    va = d3 * d6 - d5 * d4
    m6 = ((~m1) & (~m2) & (~m3) & (~m4) & (~m5) & (va <= 0)
          & ((d4 - d3) >= 0) & ((d5 - d6) >= 0))
    denom = np.where((d4 - d3) + (d5 - d6) == 0, 1.0, (d4 - d3) + (d5 - d6))
    out[m6] = (b + ((d4 - d3) / denom)[:, None] * (c - b))[m6]
    rest = ~(m1 | m2 | m3 | m4 | m5 | m6)
    denom = np.where(np.abs(va + vb + vc) < 1e-20, 1.0, va + vb + vc)
    out[rest] = (a + (vb / denom)[:, None] * ab + (vc / denom)[:, None] * ac)[rest]
    return out


class Surface:
    """Triangle soup with closest-point queries and a signed-distance sign."""

    def __init__(self, vertices: np.ndarray, faces: np.ndarray):
        self.vertices = vertices
        self.faces = faces
        self.a = vertices[faces[:, 0]]
        self.b = vertices[faces[:, 1]]
        self.c = vertices[faces[:, 2]]
        centroid = (self.a + self.b + self.c) / 3.0
        normal = np.cross(self.b - self.a, self.c - self.a)
        lengths = np.linalg.norm(normal, axis=1, keepdims=True)
        self.face_normal = normal / np.where(lengths > 1e-20, lengths, 1.0)
        self.face_area = 0.5 * lengths.reshape(-1)
        self.tree = cKDTree(centroid)
        # Angle-weighted vertex pseudonormals: the sign of a signed distance
        # taken from a single facet normal flips wherever the closest point
        # lands on an edge, which is most of a low-poly body.
        pseudo = np.zeros_like(vertices)
        for column in range(3):
            np.add.at(pseudo, faces[:, column],
                      self.face_normal * self.face_area[:, None])
        lengths = np.linalg.norm(pseudo, axis=1, keepdims=True)
        self.vertex_normal = pseudo / np.where(lengths > 1e-20, lengths, 1.0)

    def closest(self, points: np.ndarray, k: int = 28):
        k = min(k, len(self.faces))
        _, candidates = self.tree.query(points, k=k, workers=-1)
        if candidates.ndim == 1:
            candidates = candidates[:, None]
        best = np.full(len(points), np.inf)
        hit = np.zeros_like(points)
        face = np.zeros(len(points), dtype=np.int64)
        for column in range(candidates.shape[1]):
            index = candidates[:, column]
            projected = point_triangle(points, self.a[index], self.b[index], self.c[index])
            distance = np.linalg.norm(projected - points, axis=1)
            better = distance < best
            best[better] = distance[better]
            hit[better] = projected[better]
            face[better] = index[better]
        return hit, face, best

    def signed(self, points: np.ndarray):
        """(signed distance, closest point, outward direction). Positive = outside."""
        hit, face, distance = self.closest(points)
        triangle = self.faces[face]
        # Barycentric blend of the three pseudonormals, which stays continuous
        # across edges and vertices unlike the facet normal.
        a, b, c = self.a[face], self.b[face], self.c[face]
        normal = interpolate_normal(hit, a, b, c, self.vertex_normal[triangle])
        offset = points - hit
        length = np.linalg.norm(offset, axis=1, keepdims=True)
        direction = np.where(length > 1e-12, offset / np.where(length > 1e-12, length, 1.0),
                             normal)
        sign = np.where((offset * normal).sum(1) >= 0.0, 1.0, -1.0)
        return distance * sign, hit, direction * sign[:, None]


def interpolate_normal(point, a, b, c, normals):
    v0, v1, v2 = b - a, c - a, point - a
    d00 = (v0 * v0).sum(1)
    d01 = (v0 * v1).sum(1)
    d11 = (v1 * v1).sum(1)
    d20 = (v2 * v0).sum(1)
    d21 = (v2 * v1).sum(1)
    denom = d00 * d11 - d01 * d01
    denom = np.where(np.abs(denom) < 1e-20, 1.0, denom)
    v = (d11 * d20 - d01 * d21) / denom
    w = (d00 * d21 - d01 * d20) / denom
    u = 1.0 - v - w
    blended = (normals[:, 0] * u[:, None] + normals[:, 1] * v[:, None]
               + normals[:, 2] * w[:, None])
    lengths = np.linalg.norm(blended, axis=1, keepdims=True)
    return blended / np.where(lengths > 1e-20, lengths, 1.0)


def graph_edges(faces: np.ndarray, welded: np.ndarray, count: int):
    mapped = welded[faces]
    a = np.concatenate([mapped[:, 0], mapped[:, 1], mapped[:, 2]])
    b = np.concatenate([mapped[:, 1], mapped[:, 2], mapped[:, 0]])
    return np.concatenate([a, b]), np.concatenate([b, a])


def relax(values: np.ndarray, edge_a: np.ndarray, edge_b: np.ndarray,
          count: int, passes: int, weight: float) -> np.ndarray:
    degree = np.bincount(edge_a, minlength=count).astype(np.float64)
    degree[degree == 0] = 1.0
    out = values.copy()
    for _ in range(passes):
        total = np.zeros_like(out)
        np.add.at(total, edge_a, out[edge_b])
        out = (1.0 - weight) * out + weight * (total / degree[:, None])
    return out


# ---------------------------------------------------------------- profiles


BARYCENTRIC = np.array([(1 / 6, 1 / 6, 4 / 6), (1 / 6, 4 / 6, 1 / 6),
                        (4 / 6, 1 / 6, 1 / 6), (1 / 3, 1 / 3, 1 / 3),
                        (1 / 2, 1 / 2, 0.0), (0.0, 1 / 2, 1 / 2),
                        (1 / 2, 0.0, 1 / 2), (1.0, 0.0, 0.0),
                        (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)])


def resample(vertices, faces, per_vertex):
    """Barycentric surface samples plus the interpolated per-vertex payload."""
    points, payload = [], []
    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    pa, pb, pc = per_vertex[faces[:, 0]], per_vertex[faces[:, 1]], per_vertex[faces[:, 2]]
    for u, v, w in BARYCENTRIC:
        points.append(a * u + b * v + c * w)
        payload.append(pa * u + pb * v + pc * w)
    return np.concatenate(points), np.concatenate(payload)


class Frame:
    """Rig-space parameterisation of one body region."""

    def __init__(self, kind: str, origin: np.ndarray, axis: np.ndarray | None):
        self.kind = kind
        self.origin = origin
        if kind == "cyl":
            axis = axis / np.linalg.norm(axis)
            helper = np.array([0.0, 0.0, 1.0])
            if abs(float(axis @ helper)) > 0.9:
                helper = np.array([1.0, 0.0, 0.0])
            u = np.cross(helper, axis)
            u /= np.linalg.norm(u)
            self.axis, self.u, self.v = axis, u, np.cross(axis, u)

    def decompose(self, points: np.ndarray):
        """(axial coordinate, angle in [-pi,pi], radius, unit radial direction)."""
        offset = points - self.origin
        if self.kind == "cyl":
            axial = offset @ self.axis
            planar = offset - axial[:, None] * self.axis
            radius = np.linalg.norm(planar, axis=1)
            angle = np.arctan2(planar @ self.v, planar @ self.u)
            direction = planar / np.where(radius > 1e-9, radius, 1.0)[:, None]
            return axial, angle, radius, direction
        radius = np.linalg.norm(offset, axis=1)
        safe = np.where(radius > 1e-9, radius, 1.0)
        direction = offset / safe[:, None]
        return (np.arcsin(np.clip(offset[:, 1] / safe, -1.0, 1.0)),
                np.arctan2(offset[:, 2], offset[:, 0]), radius, direction)


class Profile:
    """r(axial, angle) for one region of one body, on a fixed grid."""

    def __init__(self, frame: Frame, points: np.ndarray, weights: np.ndarray,
                 axial_range: tuple[float, float]):
        self.frame = frame
        self.low, self.high = axial_range
        axial, angle, radius, _ = frame.decompose(points)
        span = max(self.high - self.low, 1e-6)
        row = np.clip(((axial - self.low) / span * AXIAL_CELLS).astype(int),
                      0, AXIAL_CELLS - 1)
        column = np.clip(((angle + np.pi) / (2 * np.pi) * ANGULAR_CELLS).astype(int),
                         0, ANGULAR_CELLS - 1)
        cell = row * ANGULAR_CELLS + column
        size = AXIAL_CELLS * ANGULAR_CELLS
        # Share-weighted mean radius per cell. A max would take the outer hull
        # and lose every concavity a garment has to follow (waist, armpit,
        # crotch); a plain mean would let a half-claimed vertex from the
        # neighbouring region drag the profile.
        total = np.zeros(size)
        share = np.zeros(size)
        np.add.at(total, cell, radius * weights)
        np.add.at(share, cell, weights)
        grid = np.where(share > 1e-9, total / np.where(share > 1e-9, share, 1.0), 0.0)
        filled = share > 1e-3
        self.filled = filled.reshape(AXIAL_CELLS, ANGULAR_CELLS)
        self.grid = self._fill(grid.reshape(AXIAL_CELLS, ANGULAR_CELLS), self.filled)

    @staticmethod
    def _fill(grid: np.ndarray, filled: np.ndarray) -> np.ndarray:
        out = grid.copy()
        known = filled.copy()
        for _ in range(max(AXIAL_CELLS, ANGULAR_CELLS)):
            if known.all():
                break
            total = np.zeros_like(out)
            count = np.zeros_like(out)
            for shift, axis in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
                rolled = np.roll(out, shift, axis=axis)
                mask = np.roll(known, shift, axis=axis)
                if axis == 0:  # axial edges do not wrap
                    if shift == 1:
                        mask[0] = False
                    else:
                        mask[-1] = False
                total += np.where(mask, rolled, 0.0)
                count += mask
            fresh = (~known) & (count > 0)
            out[fresh] = (total[fresh] / count[fresh])
            known |= fresh
        for _ in range(PROFILE_SMOOTH_PASSES):
            neighbours = (np.roll(out, 1, 1) + np.roll(out, -1, 1)
                          + np.vstack([out[:1], out[:-1]])
                          + np.vstack([out[1:], out[-1:]]))
            out = 0.5 * out + 0.5 * neighbours / 4.0
        return out

    def lookup(self, axial: np.ndarray, angle: np.ndarray) -> np.ndarray:
        """Bilinear radius lookup, clamped axially and wrapped angularly."""
        return self._bilinear(self.grid, axial, angle)

    def _bilinear(self, grid: np.ndarray, axial: np.ndarray,
                  angle: np.ndarray) -> np.ndarray:
        span = max(self.high - self.low, 1e-6)
        row = np.clip((axial - self.low) / span * AXIAL_CELLS - 0.5,
                      0.0, AXIAL_CELLS - 1.0)
        column = (angle + np.pi) / (2 * np.pi) * ANGULAR_CELLS - 0.5
        r0 = np.floor(row).astype(int)
        r1 = np.minimum(r0 + 1, AXIAL_CELLS - 1)
        fr = row - r0
        c0 = np.floor(column).astype(int) % ANGULAR_CELLS
        c1 = (c0 + 1) % ANGULAR_CELLS
        fc = column - np.floor(column)
        top = grid[r0, c0] * (1 - fc) + grid[r0, c1] * fc
        bottom = grid[r1, c0] * (1 - fc) + grid[r1, c1] * fc
        return top * (1 - fr) + bottom * fr


#: How far a region's axial extent is allowed to be rescaled. The rest skeleton
#: is identical between the bodies, so any honest change here is small -- a
#: shorter toe box, a slightly deeper heel -- and a wide clamp would only let a
#: sampling artefact stretch a limb.
AXIAL_SCALE_CLAMP = (0.90, 1.10)
#: Only strongly-claimed samples define a region's axial extent.
AXIAL_CORE_SHARE = 0.70
#: Regions whose axial extent is allowed to change at all.
#:
#: Both bodies share one rest skeleton, so every limb's axial extent is pinned
#: by its bone lengths: an arm or a leg CANNOT have got longer, and measuring
#: one as 10 % longer only means the two bodies distribute their skin weights
#: over differently tessellated surfaces. The foot is the exception -- its toe
#: box extends past the last joint, so its length is real free geometry (the
#: promoted male toe is 8 mm shorter, the female 31 mm) and a boot cap that
#: ignores it hangs off the end.
AXIAL_REGIONS = {"foot_l", "foot_r"}


class DeformationField:
    """Radial reference-body -> promoted-body displacement, blended by region."""

    def __init__(self, reference, promoted, joint_origins: dict[str, np.ndarray]):
        self.regions: dict[str, tuple] = {}
        for name in REGIONS:
            kind, anchor, axis = REGION_FRAME[name]
            index = REGION_INDEX[name]
            origin = (joint_origins[anchor] if kind == "cyl"
                      else region_centre(reference, index))
            frame = Frame(kind, origin, np.array(axis, dtype=np.float64)
                          if axis is not None else None)
            axial_range = combined_range(frame, reference, promoted, index)
            if axial_range is None:
                continue
            scale, shift = (axial_map(frame, reference, promoted, index)
                            if name in AXIAL_REGIONS else (1.0, 0.0))
            self.regions[name] = (
                frame,
                Profile(frame, *region_samples(reference, index), axial_range),
                Profile(frame, *region_samples(promoted, index), axial_range),
                scale, shift,
            )

    def sample(self, points: np.ndarray, weights: np.ndarray) -> np.ndarray:
        out = np.zeros_like(points)
        total = np.zeros(len(points))
        for name, (frame, old, new, scale, shift) in self.regions.items():
            share = weights[:, REGION_INDEX[name]]
            active = np.where(share > REGION_WEIGHT_FLOOR)[0]
            if len(active) == 0:
                continue
            axial, angle, _, direction = frame.decompose(points[active])
            mapped = axial * scale + shift
            # No confidence gate. Damping cells by how densely they were
            # sampled measured strictly worse (reference-skin residual 0.89 mm
            # -> 1.15 mm, female feet 8.9 mm -> 13.1 mm): the reference body is
            # coarse, so most cells are legitimately interpolated from their
            # neighbours and discounting those throws away real displacement.
            delta = new.lookup(mapped, angle) - old.lookup(axial, angle)
            displacement = direction * delta[:, None]
            if frame.kind == "cyl":
                # A shorter toe box or a deeper heel is an AXIAL change; radius
                # alone cannot express it and the boot cap would hang past it.
                displacement = displacement + frame.axis * (mapped - axial)[:, None]
            out[active] += displacement * share[active, None]
            total[active] += share[active]
        return out / np.where(total > 1e-9, total, 1.0)[:, None]


def axial_map(frame: Frame, reference, promoted, index: int) -> tuple[float, float]:
    """Robust axial extent mapping between the two bodies for one region."""
    spans = []
    for body in (reference, promoted):
        points, share = region_samples(body, index)
        core = points[share >= AXIAL_CORE_SHARE]
        if len(core) < 8:
            return 1.0, 0.0
        axial, _, _, _ = frame.decompose(core)
        spans.append((float(axial.min()), float(axial.max())))
    (low_old, high_old), (low_new, high_new) = spans
    if high_old - low_old < 1e-6:
        return 1.0, 0.0
    scale = float(np.clip((high_new - low_new) / (high_old - low_old), *AXIAL_SCALE_CLAMP))
    return scale, low_new - low_old * scale


class BodySample:
    """A body resampled once: surface points plus per-region weight."""

    def __init__(self, vertices, faces, weights):
        self.vertex_weights = weights
        self.points, self.weights = resample(vertices, faces, weights)


def region_samples(body: BodySample, index: int):
    share = body.weights[:, index]
    keep = share > REGION_WEIGHT_FLOOR
    return body.points[keep], share[keep]


def region_centre(body: BodySample, index: int) -> np.ndarray:
    points, share = region_samples(body, index)
    if len(points) == 0:
        return np.zeros(3)
    return (points * share[:, None]).sum(0) / share.sum()


def combined_range(frame: Frame, reference: BodySample, promoted: BodySample,
                   index: int):
    values = []
    for body in (reference, promoted):
        points, _ = region_samples(body, index)
        if len(points) == 0:
            continue
        axial, _, _, _ = frame.decompose(points)
        values.append(axial)
    if not values:
        return None
    joined = np.concatenate(values)
    return float(joined.min()), float(joined.max())


def umeyama(source: np.ndarray, destination: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Least-squares similarity transform (rotation + uniform scale + shift)."""
    mu_source = source.mean(0)
    mu_destination = destination.mean(0)
    centred_source = source - mu_source
    centred_destination = destination - mu_destination
    covariance = centred_destination.T @ centred_source / len(source)
    u, sigma, vt = np.linalg.svd(covariance)
    correction = np.eye(3)
    if np.linalg.det(u @ vt) < 0:
        correction[2, 2] = -1.0
    rotation = u @ correction @ vt
    variance = (centred_source ** 2).sum() / len(source)
    scale = float((sigma * np.diag(correction)).sum() / variance) if variance > 1e-18 else 1.0
    shift = mu_destination - scale * rotation @ mu_source
    return scale, rotation, shift
