"""Shared paths and constants for the humanoid runtime refit lab.

One place for every path the promotion, refit, validation and proof steps agree
on, so a moved asset breaks loudly in one file instead of silently in five.
"""

from __future__ import annotations

import os

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(LAB_DIR, "..", "..", ".."))

ASSETS = os.path.join(REPO, "client-3d/public/assets")
PAWN_PACK = os.path.join(ASSETS, "pawn-pack")
EQUIPMENT = os.path.join(PAWN_PACK, "equipment")
FACE_KIT_ASSETS = os.path.join(ASSETS, "face-kit/assets")

BUILD_DIR = os.path.join(LAB_DIR, "build")
TEXTURE_DIR = os.path.join(BUILD_DIR, "textures")
REPORT_DIR = os.path.join(LAB_DIR, "reports")
PROOF_DIR = os.path.join(LAB_DIR, "proof")

# The FINAL reviewed bodies from Bunker's `body-refine-20260802` lane. These
# exact geometry-and-skin artifacts carry the hand-shaped shared-topology heads
# and neck grafts, verified SWG hands, and the final body-transition pass. They
# intentionally carry no clips: promotion copies the hash-pinned 47-clip bank
# from `RUNTIME_SHELL` without re-exporting it.
#
# Source commit: d3fdfa2831bf938c0d9c8bf06f8796a00a935af5
SOURCE_DIR = os.path.join(LAB_DIR, "source")
REFINED = {
    "male": os.path.join(SOURCE_DIR, "male/pawn_male_refined.glb"),
    "female": os.path.join(SOURCE_DIR, "female/pawn_female_refined.glb"),
}
REFINED_SIDECAR = {
    "male": os.path.join(SOURCE_DIR, "male/pawn_male_refined.json"),
    "female": os.path.join(SOURCE_DIR, "female/pawn_female_refined.json"),
}
REFINED_SHA = {
    "male": "d5cb14b321a5f6024820e6c49eaa7f4200dca303336c95758792847f34211401",
    "female": "bd99fdb32fc40291780d92b1494f07a428c439204b306a2a6d32d2bc403c0c8b",
}

# The runtime SHELL: the pre-refit male body, whose skeleton order, animation
# bank and node layout the promoted bodies inherit byte-for-byte. It is read
# from the pinned git checkout in `build/reference/` rather than the live path,
# because the male promotion writes over that path.
RUNTIME_SHELL = os.path.join(BUILD_DIR, "reference/male.glb")
RUNTIME_BODY = {
    "male": os.path.join(PAWN_PACK, "pawn_male.glb"),
    "female": os.path.join(PAWN_PACK, "pawn_female.glb"),
}
# `game_pack.json` -> `pawns.male.bare_file`, which `pawns.ts` selects for a male
# with no leg coverage. The refit unified the old accommodation body and its
# full-volume sibling into one male, so the bare path is now the same mesh --
# but it is still a separately loaded GLB, so it needs the same zone primitives
# or masks would silently do nothing on a bare-legged pawn.
RUNTIME_BODY_ALIAS = {
    "male": (os.path.join(PAWN_PACK, "pawn_male_bare.glb"),),
    "female": (),
}
# Skin materials are the canonical coverage zones (`body_zones.ZONES`), one
# primitive each, so the runtime can hide exactly what a garment encloses. Both
# bodies use the same vocabulary; the old `hum_{m,f}_{body,head}` split carried
# no rendering difference (identical PBR) and no runtime meaning.
MATERIALS = {
    "male": {"face": "RB_Face"},
    "female": {"face": "RB_Face"},
}

# `client-3d/src/render/pawns.ts` -> defaultSkinColor. The promoted GLB has to
# read correctly on its own, so its baked default tone is the runtime default.
DEFAULT_SKIN_HEX = "#cc9978"

# Neutral, non-uncanny default from the reviewed style set. `regal` and
# `veteran` eyes are excluded by the 2026-08-02 art review
# (client-3d/src/humanoid-lab/creator.ts REJECTED_EYE_STYLES).
DEFAULT_FACE = {
    "skinColor": DEFAULT_SKIN_HEX,
    "eyeColor": "#7eb7c7",
    "browColor": "#35241e",
    "lipColor": "#74443f",
    "styles": {"eyes": "stoic", "brows": "stoic", "nose": "stoic", "mouth": "stoic"},
}

FACE_ATLASES = {
    "eyes": "face-eyes-v3.png",
    "brows": "face-brows-v3.png",
    "noses": "face-noses-v3.png",
    "mouths": "face-mouths-v3.png",
    "semantic": "face-iris-mask-v3.png",
}

FACE_TEXTURE_SIZE = 256      # matches render/faceDecal.ts FACE_TEXTURE_SIZE

# The reserved `RB_Face` island is a 114.6 x 177 mm shield -- 1 : 1.54, far
# taller than the kit's square canvas. Painting the canvas over the whole panel
# stretches every feature vertically by that ratio. The canvas is drawn into the
# TOP `FACE_PANEL_V_SPAN` of the panel instead, anchored at the brow line the
# panel's own top edge follows; the remainder is flat tone, which is exactly
# what the chin below the mouth should be.
FACE_PANEL_V_SPAN = 0.82
# Keep the static transparent face overlay just proud of its opaque skin base.
# This matches `client-3d/src/render/faceDecal.ts`.
FACE_OVERLAY_INFLATE = 0.0015
SKIN_TEXTURE_SIZE = 512

# Gentle ambient occlusion only: enough tonal definition to read the faceted
# form, never a dirt or pore pass. AO is remapped into [AO_FLOOR, 1].
#
# The ray length is deliberately short. At 0.22 m every neck vertex saw the jaw
# and saturated at the floor, which rendered as a hard brown choker rather than
# contact shading; 0.07 m is about a jaw-to-throat gap, so occlusion falls off
# with the crevice instead of filling it. AO_SMOOTH_PASSES then relaxes the
# field over the surface graph so a single sparse edge loop cannot draw a band.
AO_FLOOR = 0.87
AO_GAMMA = 0.9
AO_DISTANCE = 0.07
AO_SMOOTH_PASSES = 3
AO_SMOOTH_WEIGHT = 0.55


def ensure_dirs() -> None:
    for path in (BUILD_DIR, TEXTURE_DIR, REPORT_DIR, PROOF_DIR):
        os.makedirs(path, exist_ok=True)
