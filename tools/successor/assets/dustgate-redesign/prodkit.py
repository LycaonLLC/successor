"""Production asset kit for the starting-settlement building units.

This module is the difference between the first massing study and a shippable
building product. The study authored every piece as an independent cube in
settlement space; that produced untrustworthy pivots and a draw call per trim
bar. Here every unit is authored in **structure-local** coordinates and then
consolidated by functional family and material before export.

Coordinate contract (authored in Blender, Z-up):

    Blender +X  ->  glTF +X   (structure right / world east when yaw 0)
    Blender +Z  ->  glTF +Y   (up; ground contact at exactly 0)
    Blender -Y  ->  glTF +Z   (structure FRONT, the camera-facing side)

`bpy.ops.export_scene.gltf(export_yup=True)` performs that basis change, so a
front wall authored at negative Blender Y lands on positive glTF Z and matches
the repository's `"front": "+Z"` manifest convention. Sidecar boxes are emitted
in glTF metres by `to_gltf_xz`, never by hand.

Origin contract: the footprint centre is (0, 0) in Blender XY and the exported
ground contact is Blender Z = 0, so `footprint.centerX == footprint.centerZ == 0`
and the runtime's X/Z recentre in `bakeGlb` is a no-op. That is what makes a
unit placeable at an arbitrary map anchor without the settlement-space pivots
(8.9, 21.5) the study reported.

Renderer contract honoured here (`client-3d/src/render/props.ts`):

  * `classifyEnterablePart` resolves door > floor > reveal > keep on the mesh or
    ANY ancestor node name, so family empties carry the prefixes and the meshes
    under them stay consolidated.
  * The gameplay door node is named exactly `door_slide`; nothing else in a unit
    may contain the substring `floor` unless it is the walk surface.
  * Enterable entries build one `Mesh` per part per instance -- part count IS
    the draw call count, which is why `consolidate()` joins by family+material.
"""

from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh  # type: ignore
import bpy  # type: ignore
from mathutils import Vector  # type: ignore

import dgkit as dg
import textures as tx
from dgpaths import prod

# --------------------------------------------------------------------------
# families and detail tiers
# --------------------------------------------------------------------------

#: Node-family prefixes the renderer classifies. `mass__` is the only added
#: family: it is non-reveal, so `classifyEnterablePart` keeps it and attached
#: exterior masses survive the cutaway instead of punching a hole in the
#: silhouette. Everything built into the interior uses `interior__`, which is
#: already in the shipped keep set.
FAMILIES = (
    "floor__",
    "interior__",
    "wall_front__",
    "wall_right__",
    "wall_back__",
    "wall_left__",
    "roof__",
    "mass__",
    "door_slide",
)

#: Reveal set actually shipped in `props-mapping.json` for the two facilities.
REVEAL_SET = ("roof__", "wall_front__", "wall_right__")

#: Detail tiers. `CORE` survives every LOD; `MID` is dropped at LOD2; `FINE`
#: is dropped at LOD1. The door, floor, opening and collision silhouette are
#: always CORE so no LOD can break the functional contract.
CORE, MID, FINE = 0, 1, 2

TILE_METRES = tx.TILE_METRES

#: Flat fallback colours, used for the LOD1/LOD2 web variants. The Three client
#: routes any material carrying a `map` to an UNLIT `MeshBasicMaterial`; the
#: maps-free path keeps the authored matcap shading. LOD1 is the web base, so
#: LOD1/LOD2 ship maps-free on purpose. Values are the measured ladder from the
#: direction record: sand > canvas > panel > plinth > ancient > steel > roof.
FLAT_HEX = {
    "panel": "#9a8c72",
    "roof": "#332f2a",
    "canvas": "#ab9f85",
    "plinth": "#5c5449",
    "steel": "#413f3a",
    "oxide": "#8d4a2b",
    "ancient": "#5f6060",
    "sand": "#c1ad8d",
    "reveal": "#1d1a17",
    "amber": "#ffb347",
    "glass": "#2a3538",
}

#: Materials that are authored dark on purpose and have no tiling texture set.
SOLID_ONLY = ("reveal", "amber", "glass")


# --------------------------------------------------------------------------
# materials
# --------------------------------------------------------------------------


def _image(path: str, colorspace: str) -> bpy.types.Image:
    name = os.path.basename(path)
    existing = bpy.data.images.get(name)
    if existing is not None:
        return existing
    image = bpy.data.images.load(path, check_existing=True)
    image.name = name
    image.colorspace_settings.name = colorspace
    return image


def pbr_material(key: str, textured: bool = True) -> bpy.types.Material:
    """Principled material wired for glTF: base colour, normal, packed ORM.

    The exporter recognises Roughness fed from a texture's G channel and
    Metallic from its B channel and writes a single
    `KHR_materials_pbrSpecularGlossiness`-free metallicRoughness texture, so
    the ORM PNG round-trips as one image instead of three.
    """
    solid = (not textured) or key in SOLID_ONLY
    name = f"KIT_{key}_flat" if solid else f"KIT_{key}"
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing

    hexval = FLAT_HEX[key]
    if solid:
        glow = 3.0 if key == "amber" else 0.0
        return dg.mat(
            name,
            hexval,
            rough=0.35 if key in ("amber", "glass") else 0.82,
            metal=0.6 if key in ("steel", "roof") else 0.0,
            emission=hexval if glow else None,
            emission_strength=glow,
        )

    paths = tx.paths_for(key)
    for role in ("albedo", "normal", "orm"):
        if not os.path.exists(paths[role]):
            raise FileNotFoundError(
                f"missing {role} map for {key}: {paths[role]} -- run textures.py first"
            )

    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.use_backface_culling = True
    tree = material.node_tree
    tree.nodes.clear()

    out = tree.nodes.new("ShaderNodeOutputMaterial")
    out.location = (620, 0)
    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (300, 0)
    tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    uv = tree.nodes.new("ShaderNodeUVMap")
    uv.location = (-820, -200)
    uv.uv_map = "UVMap"

    albedo = tree.nodes.new("ShaderNodeTexImage")
    albedo.location = (-560, 260)
    albedo.image = _image(paths["albedo"], "sRGB")
    tree.links.new(uv.outputs["UV"], albedo.inputs["Vector"])
    tree.links.new(albedo.outputs["Color"], bsdf.inputs["Base Color"])

    orm = tree.nodes.new("ShaderNodeTexImage")
    orm.location = (-560, -40)
    orm.image = _image(paths["orm"], "Non-Color")
    tree.links.new(uv.outputs["UV"], orm.inputs["Vector"])
    split = tree.nodes.new("ShaderNodeSeparateColor")
    split.location = (-280, -40)
    tree.links.new(orm.outputs["Color"], split.inputs["Color"])
    tree.links.new(split.outputs["Green"], bsdf.inputs["Roughness"])
    tree.links.new(split.outputs["Blue"], bsdf.inputs["Metallic"])

    normal = tree.nodes.new("ShaderNodeTexImage")
    normal.location = (-560, -340)
    normal.image = _image(paths["normal"], "Non-Color")
    tree.links.new(uv.outputs["UV"], normal.inputs["Vector"])
    nmap = tree.nodes.new("ShaderNodeNormalMap")
    nmap.location = (-280, -340)
    nmap.inputs["Strength"].default_value = 0.85
    tree.links.new(normal.outputs["Color"], nmap.inputs["Color"])
    tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    return material


# --------------------------------------------------------------------------
# UV0: world-aligned box projection on a shared texel grid
# --------------------------------------------------------------------------


def box_project(obj: bpy.types.Object, tile: float = TILE_METRES) -> None:
    """Per-polygon planar projection onto the plane of its dominant normal.

    Every unit is authored at identity transform in structure-local metres, so
    mesh coordinates ARE the projection coordinates and texel density is
    uniform at `1 / tile` UV units per metre across all three buildings. Repeated
    kit parts intentionally share UV space; these maps tile and are never
    lightmapped.
    """
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    layer = mesh.uv_layers[0].data
    inv = 1.0 / tile
    for poly in mesh.polygons:
        nx, ny, nz = (abs(c) for c in poly.normal)
        if nz >= nx and nz >= ny:
            pick = (0, 1)          # top/bottom  -> XY
        elif nx >= ny:
            pick = (1, 2)          # east/west   -> YZ
        else:
            pick = (0, 2)          # north/south -> XZ
        for loop_index in poly.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            layer[loop_index].uv = (co[pick[0]] * inv, co[pick[1]] * inv)


# --------------------------------------------------------------------------
# the unit builder
# --------------------------------------------------------------------------


@dataclass
class Piece:
    obj: bpy.types.Object
    family: str
    matkey: str
    detail: int
    bevel: float


@dataclass
class Unit:
    """Collects authored pieces, then consolidates them into shippable parts."""

    uid: str
    pieces: list[Piece] = field(default_factory=list)
    notes: dict = field(default_factory=dict)
    _serial: int = 0

    # -- authoring ---------------------------------------------------------

    def add(
        self,
        obj: bpy.types.Object,
        family: str,
        matkey: str,
        detail: int = MID,
        bevel: float = 0.014,
    ) -> bpy.types.Object:
        if family not in FAMILIES:
            raise ValueError(f"{self.uid}: unknown node family {family!r}")
        self._serial += 1
        obj.name = f"{family}p{self._serial:03d}_{matkey}"
        obj.data.name = obj.name
        self.pieces.append(Piece(obj, family, matkey, detail, bevel))
        return obj

    def box(
        self,
        family: str,
        matkey: str,
        x0: float,
        x1: float,
        y0: float,
        y1: float,
        z0: float,
        z1: float,
        detail: int = MID,
        bevel: float = 0.014,
        **kw,
    ) -> bpy.types.Object:
        obj = dg.boxm("tmp", x0, x1, y0, y1, z0, z1, self.mat(matkey), **kw)
        return self.add(obj, family, matkey, detail, bevel)

    def slab(
        self,
        family: str,
        matkey: str,
        x0: float,
        x1: float,
        y0: float,
        y1: float,
        z_south: float,
        z_north: float,
        thickness: float,
        detail: int = MID,
        bevel: float = 0.012,
    ) -> bpy.types.Object:
        obj = dg.slab_sloped(
            "tmp", x0, x1, y0, y1, z_south, z_north, thickness, self.mat(matkey)
        )
        return self.add(obj, family, matkey, detail, bevel)

    def drum(
        self,
        family: str,
        matkey: str,
        cx: float,
        cy: float,
        z0: float,
        z1: float,
        radius: float,
        top_radius: float | None = None,
        segments: int = 20,
        detail: int = MID,
        bevel: float = 0.010,
    ) -> bpy.types.Object:
        obj = dg.cylinder(
            "tmp", cx, cy, z0, z1, radius, self.mat(matkey),
            segments=segments,
            top_radius=top_radius if top_radius is not None else radius,
        )
        return self.add(obj, family, matkey, detail, bevel)

    def prism(
        self,
        family: str,
        matkey: str,
        profile,
        axis: str,
        a0: float,
        a1: float,
        detail: int = MID,
        bevel: float = 0.012,
    ) -> bpy.types.Object:
        obj = dg.prism("tmp", profile, axis, a0, a1, self.mat(matkey))
        return self.add(obj, family, matkey, detail, bevel)

    @staticmethod
    def mat(key: str) -> bpy.types.Material:
        return pbr_material(key)

    # -- consolidation -----------------------------------------------------

    def consolidate(self, detail_cap: int = FINE, textured: bool = True) -> dict:
        """Join every piece into one mesh per (family, material) and parent the
        result under a family empty. Returns the export payload."""
        keep = [p for p in self.pieces if p.detail <= detail_cap]
        if not keep:
            raise ValueError(f"{self.uid}: no pieces survive detail cap {detail_cap}")

        for piece in keep:
            self._finish_piece(piece, textured)

        buckets: dict[tuple[str, str], list[bpy.types.Object]] = {}
        for piece in keep:
            buckets.setdefault((piece.family, piece.matkey), []).append(piece.obj)

        empties: dict[str, bpy.types.Object] = {}
        parts: list[bpy.types.Object] = []
        for (family, matkey), objects in sorted(buckets.items()):
            merged = dg.join(f"{family}{matkey}", objects)
            merged.data.name = merged.name
            if family not in empties:
                # `door_slide` already exists as the addressable door node; a
                # second empty would land in the GLB as `door_slide.001` and
                # the renderer's startsWith classifier would treat it as a
                # second door. Reuse the existing node when it is there.
                existing = bpy.context.scene.objects.get(family)
                if existing is not None and existing.type == "EMPTY":
                    empties[family] = existing
                else:
                    empty = bpy.data.objects.new(family, None)
                    empty.empty_display_size = 0.25
                    bpy.context.scene.collection.objects.link(empty)
                    empties[family] = empty
            merged.parent = empties[family]
            merged.matrix_parent_inverse = empties[family].matrix_world.inverted()
            _canonicalize_uvs(merged)
            parts.append(merged)

        return {"empties": empties, "parts": parts}

    def _finish_piece(self, piece: Piece, textured: bool) -> None:
        obj = piece.obj
        if not textured:
            obj.data.materials.clear()
            obj.data.materials.append(pbr_material(piece.matkey, textured=False))
        box_project(obj)
        if piece.bevel > 0.0:
            _apply_bevel(obj, piece.bevel)
        _clean(obj)
        _triangulate(obj)
        _shade(obj)


def _clean(obj: bpy.types.Object) -> None:
    """Weld coincident verts and dissolve zero-length edges.

    Bevelling a thin member can leave slivers whose triangles have no area; the
    exporter then writes a zero-length TANGENT and the Khronos validator raises
    ACCESSOR_VECTOR3_NON_UNIT as a hard ERROR. Cleaning here is cheaper than
    hunting the one sliver per building that causes it."""
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=bm.edges[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def _triangulate(obj: bpy.types.Object) -> None:
    """glTF stores triangles, and Blender only computes export tangents for
    triangulated geometry: the first tangent-enabled export still raised eight
    MESH_PRIMITIVE_GENERATED_TANGENT_SPACE warnings on the meshes that still
    carried n-gon loft caps. Triangulating here removes the ambiguity and makes
    the reported triangle count the real one."""
    modifier = obj.modifiers.new("KIT_tri", "TRIANGULATE")
    for attr, value in (("quad_method", "FIXED"), ("ngon_method", "CLIP"),
                        ("keep_custom_normals", True), ("min_vertices", 4)):
        if hasattr(modifier, attr):
            setattr(modifier, attr, value)
    _apply_modifiers(obj)


def _apply_bevel(obj: bpy.types.Object, width: float) -> None:
    """A real chamfer on every hard arris. Without it a 60-degree top-down
    camera returns zero specular edge information and the massing reads as
    untextured cardboard no matter how good the albedo is."""
    modifier = obj.modifiers.new("KIT_bevel", "BEVEL")
    for attr, value in (
        ("width", width),
        ("segments", 2),
        ("limit_method", "ANGLE"),
        ("angle_limit", math.radians(35.0)),
        ("miter_outer", "MITER_ARC"),
        ("use_clamp_overlap", True),
        ("clamp_overlap", True),
        ("harden_normals", False),
    ):
        if hasattr(modifier, attr):
            setattr(modifier, attr, value)
    _apply_modifiers(obj)


def _apply_modifiers(obj: bpy.types.Object) -> None:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated)
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    mesh.name = old.name
    bpy.data.meshes.remove(old)


def _shade(obj: bpy.types.Object) -> None:
    """Smooth-by-angle so bevels catch light while flats stay flat."""
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.set_sharp_from_angle(angle=math.radians(38.0))


def _canonicalize_uvs(obj: bpy.types.Object, decimals: int = 5) -> None:
    """Remove sub-texel modifier interpolation noise from exported UVs.

    Blender 5.2 can vary a few post-bevel UV float bits between otherwise
    identical factory-startup builds. Rounding after all joins/modifiers keeps
    the source mesh deterministic; five decimal UV precision is still about
    1/200th of a texel at this kit's 1024 px texture period.
    """
    for layer in obj.data.uv_layers:
        for loop in layer.data:
            loop.uv = tuple(
                0.0 if abs(float(value)) < 0.5 * (10 ** -decimals)
                else round(float(value), decimals)
                for value in loop.uv
            )


# --------------------------------------------------------------------------
# the sliding door
# --------------------------------------------------------------------------


DOOR_NODE = "door_slide"
DOOR_CLIP_SECONDS = 0.8
DOOR_FPS = 30


@dataclass
class DoorSpec:
    """Measured door contract, in Blender structure-local metres.

    `axis_local` is the normalized glTF-space slide direction the runtime
    applies as a node-local translation; the closed pose is the authored
    default transform of the `door_slide` node.
    """

    x0: float
    x1: float
    y_front: float
    y_back: float
    z0: float
    z1: float
    travel: float
    axis_local: tuple[float, float, float] = (-1.0, 0.0, 0.0)
    park_x0: float = 0.0
    park_x1: float = 0.0

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.z1 - self.z0


def build_door(unit: Unit, spec: DoorSpec) -> bpy.types.Object:
    """Author one sliding leaf plus the addressable `door_slide` node.

    Single leaf, not bi-part: `advanceDoors` translates the WHOLE door node
    rigidly along one axis, so a two-leaf door would drive both leaves the same
    way and shear the opening. The leaf therefore hangs on the outside face of
    the front wall, runs on an exposed top track, and parks over a blank wall
    panel -- honest industrial construction that also gives the runtime a legal
    single-axis travel.

    The empty sits at the leaf's closed pose with identity rotation, so the
    node-local slide axis equals the glTF world axis and the closed pose is the
    authored default transform.
    """
    mid_x = (spec.x0 + spec.x1) * 0.5
    mid_y = (spec.y_front + spec.y_back) * 0.5

    empty = bpy.data.objects.new(DOOR_NODE, None)
    empty.empty_display_size = 0.4
    empty.location = (mid_x, mid_y, spec.z0)
    bpy.context.scene.collection.objects.link(empty)

    face = spec.y_front
    back = spec.y_back
    # Leaf skin, kick plate, two stiles, a rail, a vision slot and a pull.
    unit.box(DOOR_NODE, "panel", spec.x0, spec.x1, face + 0.035, back,
             spec.z0 + 0.16, spec.z1, detail=CORE, bevel=0.014)
    unit.box(DOOR_NODE, "steel", spec.x0, spec.x1, face, back,
             spec.z0, spec.z0 + 0.16, detail=CORE, bevel=0.010)
    for sx in (spec.x0, spec.x1 - 0.16):
        unit.box(DOOR_NODE, "steel", sx, sx + 0.16, face, back,
                 spec.z0 + 0.16, spec.z1, detail=CORE, bevel=0.010)
    rail_z = spec.z0 + spec.height * 0.58
    unit.box(DOOR_NODE, "steel", spec.x0, spec.x1, face + 0.012, back,
             rail_z, rail_z + 0.13, detail=MID, bevel=0.008)
    slot_w = min(0.62, spec.width * 0.28)
    slot_cx = mid_x + spec.width * 0.16
    unit.box(DOOR_NODE, "reveal", slot_cx - slot_w * 0.5, slot_cx + slot_w * 0.5,
             face, face + 0.05, rail_z + 0.30, spec.z1 - 0.22,
             detail=MID, bevel=0.006)
    pull_x = spec.x0 + 0.30
    unit.box(DOOR_NODE, "oxide", pull_x, pull_x + 0.09, face - 0.05, face,
             rail_z - 0.34, rail_z + 0.06, detail=FINE, bevel=0.006)
    # Hanger shoes: what the leaf actually rolls on. Two, at the stile lines.
    for cx in (spec.x0 + 0.42, spec.x1 - 0.42):
        unit.box(DOOR_NODE, "steel", cx - 0.09, cx + 0.09, face - 0.04, back,
                 spec.z1, spec.z1 + 0.13, detail=FINE, bevel=0.006)
    return empty


def parent_door(door_empty: bpy.types.Object, parts: list[bpy.types.Object]) -> None:
    """Re-parent the consolidated door parts under the addressable empty."""
    for part in parts:
        if not part.name.startswith(DOOR_NODE):
            continue
        part.parent = door_empty
        part.matrix_parent_inverse = door_empty.matrix_world.inverted()


def author_door_clips(door_empty: bpy.types.Object, spec: DoorSpec) -> list[str]:
    """`door_open` / `door_close` translation clips for interchange parity.

    The Three runtime never evaluates these -- it drives the node directly from
    `propStates[propId].doorOpen` via `axisLocal * distance`. They exist so a
    DCC or Unity import of the standalone GLB reproduces the same travel, and
    so the authored travel is verifiable inside the file itself.
    """
    # glTF axis -> Blender axis: glTF (x, y, z) == Blender (x, z, -y).
    ax, ay, az = spec.axis_local
    delta = Vector((ax, -az, ay)) * spec.travel
    closed = Vector(door_empty.location)
    opened = closed + delta
    frames = int(round(DOOR_CLIP_SECONDS * DOOR_FPS))

    names: list[str] = []
    for name, (a, b) in (("door_open", (closed, opened)), ("door_close", (opened, closed))):
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        if hasattr(action, "slots"):                       # Blender 4.4+ layered actions
            slot = action.slots.new(id_type="OBJECT", name=door_empty.name)
            layer = action.layers.new("base")
            strip = layer.strips.new(type="KEYFRAME")
            channelbag = strip.channelbag(slot, ensure=True)
            curves = [channelbag.fcurves.new("location", index=i) for i in range(3)]
        else:                                              # pragma: no cover
            curves = [action.fcurves.new("location", index=i) for i in range(3)]
        for index, curve in enumerate(curves):
            for frame, value in ((1, a[index]), (1 + frames, b[index])):
                key = curve.keyframe_points.insert(frame, value)
                key.interpolation = "BEZIER"
                key.easing = "EASE_IN_OUT"
        names.append(name)

    _stash_actions(door_empty, names)
    # The exporter unmutes and samples every NLA track, and Blender leaves the
    # object wherever the last sampled strip put it. Round 2 shipped three GLBs
    # whose door node was baked at its OPEN pose because of exactly this: the
    # closed pose is the contract, so restore it explicitly and stash it for the
    # exporter to re-apply immediately before writing.
    door_empty.location = closed
    door_empty["dg_closed_pose"] = tuple(closed)
    bpy.context.view_layer.update()
    return names


def _stash_actions(obj: bpy.types.Object, names: list[str]) -> None:
    """Park each clip on its own NLA track so the exporter emits both clips and
    the authored closed pose survives as the node's default transform.

    Two things matter and both were learned the hard way. `extrapolation` must
    be NOTHING: with the default HOLD, the strip's first keyframe leaks onto
    every frame before it, so `door_close` (which STARTS open) pinned the node
    open and the exporter baked that into the node TRS. And the strips must not
    overlap frame 1, so the scene's rest frame evaluates to no animation at
    all."""
    if obj.animation_data is None:
        obj.animation_data_create()
    anim = obj.animation_data
    anim.action = None
    start = 10
    for name in names:
        action = bpy.data.actions[name]
        track = anim.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, start, action)
        strip.name = name
        strip.extrapolation = "NOTHING"
        if hasattr(action, "slots") and action.slots:
            strip.action_slot = action.slots[0]
        track.mute = True
        start += int(DOOR_CLIP_SECONDS * DOOR_FPS) + 20
    bpy.context.scene.frame_set(1)


# --------------------------------------------------------------------------
# coordinate conversion and measurement
# --------------------------------------------------------------------------


def to_gltf_xz(x0: float, x1: float, y0: float, y1: float) -> dict:
    """Blender XY rect -> glTF XZ box. Blender -Y is the glTF +Z front, so the
    Z interval flips: minZ = -max(y), maxZ = -min(y)."""
    return {
        "minX": round(min(x0, x1), 4),
        "maxX": round(max(x0, x1), 4),
        "minZ": round(-max(y0, y1), 4),
        "maxZ": round(-min(y0, y1), 4),
    }


def collision_box(x0: float, x1: float, y0: float, y1: float, box_id: str) -> dict:
    box = to_gltf_xz(x0, x1, y0, y1)
    if not (box["maxX"] > box["minX"] and box["maxZ"] > box["minZ"]):
        raise ValueError(f"degenerate collision box {box_id}: {box}")
    return {"id": box_id, **box}


def boxes_overlap(a: dict, b: dict, epsilon: float = 1e-9) -> bool:
    return (
        min(a["maxX"], b["maxX"]) - max(a["minX"], b["minX"]) > epsilon
        and min(a["maxZ"], b["maxZ"]) - max(a["minZ"], b["minZ"]) > epsilon
    )


def assert_inside(box: dict, footprint: dict, label: str) -> None:
    epsilon = 1e-6
    if (
        box["minX"] < footprint["minX"] - epsilon
        or box["maxX"] > footprint["maxX"] + epsilon
        or box["minZ"] < footprint["minZ"] - epsilon
        or box["maxZ"] > footprint["maxZ"] + epsilon
    ):
        raise ValueError(f"{label} lies outside the footprint: {box} vs {footprint}")


def part_census(parts: list[bpy.types.Object]) -> dict:
    families: dict[str, int] = {}
    materials: set[str] = set()
    triangles = 0
    verts = 0
    for part in parts:
        for family in FAMILIES:
            if part.name.startswith(family):
                families[family] = families.get(family, 0) + 1
                break
        for slot in part.data.materials:
            if slot is not None:
                materials.add(slot.name)
        verts += len(part.data.vertices)
        for poly in part.data.polygons:
            triangles += max(0, len(poly.vertices) - 2)
    return {
        "renderer_primitives": len(parts),
        "draw_calls_per_instance": len(parts),
        "materials": sorted(materials),
        "material_count": len(materials),
        "triangles": triangles,
        "vertices": verts,
        "node_families": dict(sorted(families.items())),
    }


def uv_report(parts: list[bpy.types.Object]) -> dict:
    missing = [p.name for p in parts if not p.data.uv_layers]
    layers = sorted({p.data.uv_layers[0].name for p in parts if p.data.uv_layers})
    area_ratio = []
    for part in parts:
        if not part.data.uv_layers:
            continue
        uvs = part.data.uv_layers[0].data
        mesh_area = sum(p.area for p in part.data.polygons)
        uv_area = 0.0
        for poly in part.data.polygons:
            loops = [uvs[i].uv for i in poly.loop_indices]
            acc = 0.0
            for i in range(len(loops)):
                a, b = loops[i], loops[(i + 1) % len(loops)]
                acc += a[0] * b[1] - b[0] * a[1]
            uv_area += abs(acc) * 0.5
        if mesh_area > 1e-6:
            area_ratio.append(uv_area / mesh_area)
    return {
        "uv0_layer_names": layers,
        "meshes_without_uv0": missing,
        "texels_per_metre": tx.TEXELS_PER_METRE,
        "uv_units_per_metre": round(1.0 / TILE_METRES, 6),
        "measured_uv_area_per_mesh_area_min": round(min(area_ratio), 5) if area_ratio else None,
        "measured_uv_area_per_mesh_area_max": round(max(area_ratio), 5) if area_ratio else None,
        "overlap_intent": (
            "box-projected trim UVs on a shared grid; repeated kit parts share "
            "UV space by design and must never be lightmapped"
        ),
    }


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------


def export_unit(path: str, roots: list[bpy.types.Object], animations: bool) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    selected: list[bpy.types.Object] = []
    for root in roots:
        root.select_set(True)
        selected.append(root)
        for child in root.children_recursive:
            child.select_set(True)
            selected.append(child)
    bpy.context.view_layer.objects.active = selected[0] if selected else None
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=animations,
        export_animation_mode="ACTIONS",
        export_nla_strips=True,
        export_bake_animation=False,
        export_optimize_animation_size=False,
        export_texcoords=True,
        export_normals=True,
        # Normal-mapped materials without tangents raise
        # MESH_PRIMITIVE_GENERATED_TANGENT_SPACE in the Khronos validator (101
        # warnings across the first nine exports) and leave the tangent basis to
        # each runtime. Export them.
        export_tangents=True,
    )
    while True:
        try:
            bpy.ops.export_scene.gltf(**kwargs)
            break
        except TypeError as error:
            # Drop only the exact option this Blender build does not expose, so
            # an exporter rename can never silently change the export basis.
            key = next(
                (k for k in str(error).split("'") if k in kwargs and k != "filepath"),
                None,
            )
            if key is None:
                raise
            kwargs.pop(key)
    # Blender's exporter samples every NLA action to emit `door_open` and
    # `door_close`, then writes the node TRS from the sampled state instead of
    # from the object: the scene stays closed through export and only the FILE
    # comes out open. The child transforms it writes are already correct for the
    # closed pose, so restoring this one translation restores the contract.
    for obj in selected:
        if "dg_closed_pose" in obj:
            bx, by, bz = tuple(obj["dg_closed_pose"])
            force_node_translation(path, obj.name, (bx, bz, -by))
    return path


def force_node_translation(path: str, node_name: str,
                           translation: tuple[float, float, float]) -> dict:
    """Rewrite one node's translation inside an exported GLB.

    `translation` is in glTF axes (X right, Y up, Z front)."""
    with open(path, "rb") as handle:
        blob = handle.read()
    if blob[:4] != b"glTF":
        raise ValueError(f"{path} is not a GLB")
    offset = 12
    chunks: list[list] = []
    while offset < len(blob):
        length = int.from_bytes(blob[offset:offset + 4], "little")
        kind = blob[offset + 4:offset + 8]
        chunks.append([kind, blob[offset + 8:offset + 8 + length]])
        offset += 8 + length
    if not chunks or chunks[0][0] != b"JSON":
        raise ValueError(f"{path} has no JSON chunk")

    document = json.loads(chunks[0][1].decode("utf-8"))
    matches = [n for n in document.get("nodes", []) if n.get("name") == node_name]
    if len(matches) != 1:
        raise ValueError(f"{path}: expected exactly one {node_name!r} node, "
                         f"found {len(matches)}")
    before = list(matches[0].get("translation", [0.0, 0.0, 0.0]))
    matches[0]["translation"] = [float(v) for v in translation]
    matches[0].pop("matrix", None)

    encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    chunks[0][1] = encoded
    body = b"".join(
        len(data).to_bytes(4, "little") + kind + data for kind, data in chunks
    )
    with open(path, "wb") as handle:
        handle.write(b"glTF" + (2).to_bytes(4, "little")
                     + (12 + len(body)).to_bytes(4, "little") + body)
    return {"node": node_name, "before": before, "after": list(translation)}


def glb_document(path: str) -> dict:
    """The JSON chunk of a GLB, as the file actually stores it."""
    with open(path, "rb") as handle:
        blob = handle.read()
    offset = 12
    while offset < len(blob):
        length = int.from_bytes(blob[offset:offset + 4], "little")
        if blob[offset + 4:offset + 8] == b"JSON":
            return json.loads(blob[offset + 8:offset + 8 + length].decode("utf-8"))
        offset += 8 + length
    raise ValueError(f"{path} has no JSON chunk")


def rest_pose_from_glb(path: str, objects) -> dict:
    """Undo the glTF importer's animation application.

    `bpy.ops.import_scene.gltf` builds actions for every clip and leaves the
    imported objects posed on one of them, so a freshly imported unit shows its
    door OPEN even though the file's node translation is the closed pose. The
    file is the contract; this restores what the file says and drops the
    imported animation so nothing re-poses it.
    """
    document = glb_document(path)
    translations = {
        node["name"]: node.get("translation", [0.0, 0.0, 0.0])
        for node in document.get("nodes", []) if "name" in node
    }
    restored = {}
    for obj in objects:
        if obj.animation_data is not None:
            obj.animation_data_clear()
        gltf = translations.get(obj.name)
        if gltf is None:
            continue
        # glTF (x, y, z) -> Blender (x, -z, y).
        obj.location = (gltf[0], -gltf[2], gltf[1])
        restored[obj.name] = list(gltf)
    bpy.context.view_layer.update()
    return restored


def write_json(path: str, payload: dict) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return path


def sha256(path: str) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# scene dressing shared by every render entry point
# --------------------------------------------------------------------------


def dressed_scene(ground: bool = True, ground_size: float = 90.0) -> None:
    dg.setup_world()
    dg.add_sun()
    # Cool sky bounce so north-facing planes do not go dead black under AgX.
    fill = bpy.data.lights.new("KIT_Fill", type="SUN")
    fill.energy = 0.55
    fill.color = dg.hex_rgb("#9fb6cf")
    fill_obj = bpy.data.objects.new("KIT_Fill", fill)
    bpy.context.scene.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = (math.radians(34.0), 0.0, math.radians(200.0))
    if ground:
        plane = dg.ground_plane("ground_sand", ground_size, pbr_material("sand"))
        box_project(plane, tile=6.0)


def capsule_proxy(name: str, x: float, y: float, height: float = 1.75) -> bpy.types.Object:
    return dg.capsule(name, x, y, 0.0, 0.28, height, pbr_material("panel", textured=False))


__all__ = [
    "CORE", "MID", "FINE", "FAMILIES", "REVEAL_SET", "DOOR_NODE",
    "DoorSpec", "Unit", "assert_inside", "author_door_clips", "box_project",
    "boxes_overlap", "build_door", "capsule_proxy", "collision_box",
    "dressed_scene", "export_unit", "parent_door", "part_census",
    "pbr_material", "prod", "sha256", "to_gltf_xz", "uv_report", "write_json",
]
