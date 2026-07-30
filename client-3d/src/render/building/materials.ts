import {
  CanvasTexture,
  Color,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  SRGBColorSpace,
  type Material,
  type Texture,
} from "three";
import type { BuildingPalette } from "./types";

/**
 * Building materials are UNLIT — the Successor scene deliberately has no
 * lights (environment/sunShadow.ts), so anything MeshStandard renders as a
 * flat black silhouette. Buildings ride the same MeshMatcap path as pawns
 * and props: sculptural shading from the matcap gradient, fog on, and the
 * same dark-color luminance lift props.ts uses so authored near-black
 * palettes never collapse into void surfaces at iso distance.
 */
export const DEFAULT_BUILDING_PALETTE: Required<BuildingPalette> = {
  primary: "#8b8274", // sun-worn plaster/timber body
  secondary: "#565d63", // weathered metal/glazing
  accent: "#c58d48", // trim, sills, door hardware
};

export interface BuildingMaterials {
  primary: MeshMatcapMaterial;
  secondary: MeshMatcapMaterial;
  accent: MeshMatcapMaterial;
}

/**
 * Shared matcap for all building modules (renderer-owned, dispose with the
 * renderer). Same OUTER-RING trap as pawns/props: the steep iso camera
 * samples the ring for most visible faces — keep it light or every wall
 * renders near-black. Returns null when no DOM (node tests); three's matcap
 * shader falls back to a built-in vertical gradient in that case.
 */
export function createBuildingMatcapTexture(): Texture | null {
  if (typeof document === "undefined") return null;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size * 0.38, size * 0.32, size * 0.06, size * 0.5, size * 0.5, size * 0.68);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.4, "#eef0f2");
    gradient.addColorStop(0.75, "#ccd2d7");
    gradient.addColorStop(1, "#b3bac1");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

const liftColor = new Color("#b0a893");

/** Stronger cousin of props.ts convertMaterial's guard: the matcap RING is
 *  what steep-iso wall faces sample, and it MULTIPLIES the palette color —
 *  so anything under ~0.3 luminance still lands near-black on screen. Lift
 *  dark authored colors toward a medium warm neutral so persisted dark
 *  palettes stay readable at dusk while keeping their hue separation. */
function liftedColor(value: string): Color {
  const color = new Color(value);
  const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  if (luminance < 0.3) color.lerp(liftColor, ((0.3 - luminance) / 0.3) * 0.85);
  return color;
}

export function createBuildingMaterials(
  palette?: BuildingPalette | null,
  ghost = false,
  valid = true,
  matcap: Texture | null = null,
): BuildingMaterials {
  const resolved = { ...DEFAULT_BUILDING_PALETTE, ...(palette ?? {}) };
  const tint = ghost ? (valid ? "#4ddc85" : "#df5360") : undefined;
  const opacity = ghost ? 0.38 : 1;
  const make = (value: string): MeshMatcapMaterial => {
    const material = new MeshMatcapMaterial({
      color: tint ? new Color(tint) : liftedColor(value),
      flatShading: true,
      fog: true,
      transparent: ghost,
      opacity,
      depthWrite: !ghost,
    });
    if (matcap) material.matcap = matcap;
    return material;
  };
  return {
    primary: make(resolved.primary),
    secondary: make(resolved.secondary),
    accent: make(resolved.accent),
  };
}

export function cloneMaterialForFade(material: Material): { material: Material; opacity: number; transparent: boolean; depthWrite: boolean } {
  const clone = material.clone();
  return { material: clone, opacity: clone.opacity, transparent: clone.transparent, depthWrite: clone.depthWrite };
}

export function createOverlayMaterial(colorHex: number, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: colorHex, transparent: true, opacity, depthWrite: false });
}
