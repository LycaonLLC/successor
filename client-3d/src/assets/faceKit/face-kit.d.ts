export type FaceStyle = "stoic" | "rogue" | "youth" | "ghost" | "sharp" | "feral" | "regal" | "veteran";
export type FaceFeature = "eyes" | "brows" | "nose" | "mouth";
export type RGB = [number, number, number];
export type PixelImage = { width: number; height: number; data: Uint8ClampedArray };
export type FaceAssets = {
  eyes: PixelImage;
  brows: PixelImage;
  noses: PixelImage;
  mouths: PixelImage;
  semantic: PixelImage;
};
export type FaceTransform = { offsetY: number; scaleX: number; scaleY: number; rotation: number };
export type FacePairTransform = FaceTransform & { spacing: number };
export type EyeTransform = FacePairTransform & { irisScale: number };
export type PaintPoint = { u: number; v: number; mirrorU?: number; mirrorV?: number };
export type PaintStroke = {
  id?: string;
  tool: "brush" | "erase";
  color: string;
  size: number;
  opacity: number;
  mirror: boolean;
  points: PaintPoint[];
};
export type FaceConfig = {
  skinColor: string;
  eyeColor: string;
  browColor: string;
  lipColor: string;
  styles: Record<FaceFeature, FaceStyle>;
  eyes: EyeTransform;
  brows: FacePairTransform;
  nose: FaceTransform;
  mouth: FaceTransform;
  paint: PaintStroke[];
};
export type FaceConfigInput = Partial<Omit<FaceConfig, "styles" | "eyes" | "brows" | "nose" | "mouth">> & {
  styles?: Partial<Record<FaceFeature, FaceStyle>>;
  eyes?: Partial<EyeTransform>;
  brows?: Partial<FacePairTransform>;
  nose?: Partial<FaceTransform>;
  mouth?: Partial<FaceTransform>;
};
export type FaceRenderOptions = {
  size?: number;
  transparent?: boolean;
  canvas?: HTMLCanvasElement;
};

export const FACE_STYLE_ORDER: readonly FaceStyle[];
export const FACE_STYLE_LABELS: Readonly<Record<FaceStyle, string>>;
export const FACE_SEMANTIC_LAYOUT: Readonly<Record<FaceStyle, { eyes: readonly [{ u: number; v: number; radiusU: number; radiusV: number; pupilRatioU: number; pupilRatioV: number; pupilOffsetU?: number; pupilOffsetV?: number }, { u: number; v: number; radiusU: number; radiusV: number; pupilRatioU: number; pupilRatioV: number; pupilOffsetU?: number; pupilOffsetV?: number }] }>>;
export const FACE_ASSET_FILES: Readonly<Record<string, string>>;
export const SKIN_TONES: readonly string[];
export const EYE_COLORS: readonly string[];
export const BROW_COLORS: readonly string[];
export const LIP_COLORS: readonly string[];
export const DEFAULT_FACE_CONFIG: Readonly<FaceConfig>;

export function normalizeFaceConfig(input?: FaceConfigInput): FaceConfig;
export function loadFaceAssets(baseUrl?: string | URL): Promise<FaceAssets>;
export function composeFacePixels(assets: FaceAssets, inputConfig?: FaceConfigInput, options?: FaceRenderOptions): PixelImage & { config: FaceConfig };
export function renderFaceTexture(assets: FaceAssets, inputConfig?: FaceConfigInput, options?: FaceRenderOptions): HTMLCanvasElement;
export function makeThreeTexture(THREE: any, canvas: HTMLCanvasElement, options?: { pixelated?: boolean; mipmaps?: boolean; flipY?: boolean }): any;
export function updateThreeTexture(texture: any, assets: FaceAssets, config: FaceConfigInput, options?: FaceRenderOptions): any;
export function downloadFacePNG(canvas: HTMLCanvasElement, filename?: string): void;
export function randomFaceConfig(random?: () => number): FaceConfig;
