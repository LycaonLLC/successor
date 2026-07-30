import type { MeshMatcapMaterial } from "three";
import { Vector3 } from "three";
import { FX_CONFIG } from "./fx/config";

/**
 * Pawn rim light (shader overhaul 2026-07-08) — the surface-tier signature.
 *
 * The matcap conversion gives pawns clean sculptural shading but they sit
 * flat against the desert at iso distance. This injects a fresnel rim into
 * the matcap fragment: a cool sky-bounce edge that lifts every silhouette
 * off the ground the way PS2-era character shading faked bounce light. The
 * term is additive, subtle by default, and rides the SAME posterize/dither
 * grade as everything else, so it reads as "the game's light", not a sticker.
 *
 * Composition contract: pawn-family materials have a free onBeforeCompile
 * (sun-shadow receivers are terrain/props only — see environment/sunShadow).
 * The patch still guards against double-install and sets a
 * customProgramCacheKey so three's program cache stays shared across the
 * pooled body/equipment materials.
 *
 * All dials live in FX_CONFIG.pawnRim.
 */

const rimColor = new Vector3(
  ((FX_CONFIG.pawnRim.color >> 16) & 255) / 255,
  ((FX_CONFIG.pawnRim.color >> 8) & 255) / 255,
  (FX_CONFIG.pawnRim.color & 255) / 255,
);

const sharedUniforms = {
  uDwRimColor: { value: rimColor },
  uDwRimStrength: { value: FX_CONFIG.pawnRim.strength },
  uDwRimPower: { value: FX_CONFIG.pawnRim.power },
};

/** Install the rim term on a pawn-family matcap material (idempotent). */
export function installPawnRim(material: MeshMatcapMaterial): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    if (shader.fragmentShader.includes("uDwRimColor")) return;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec3 uDwRimColor;
        uniform float uDwRimStrength;
        uniform float uDwRimPower;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `{
          // Sky-bounce fresnel rim: vViewPosition points surface->camera in
          // view space; 'normal' is the shaded fragment normal. Grazing
          // fragments catch the rim, faces toward the eye stay untouched.
          float dwNdv = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
          float dwRim = pow(1.0 - dwNdv, uDwRimPower);
          outgoingLight += uDwRimColor * dwRim * uDwRimStrength;
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "successor-pawn-rim-v1";
  material.needsUpdate = true;
}
