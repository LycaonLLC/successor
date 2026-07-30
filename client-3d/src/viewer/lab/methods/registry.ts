// methods/registry.ts — crease-fix method bench (owner order 2026-07-21):
// twelve foundationally different fixes for the deep-flexion garment collapse,
// each a self-contained plugin the lab can hot-swap for side-by-side judging.
//
// CONTRACT (one file per method, `m-<id>.ts`, default-exports a CreaseMethod):
//   - Asset-fork methods provide GLB overrides under
//     /assets/pawn-pack/crease-methods/<id>/ (Under/<item>.glb per garment,
//     body_male.glb for body forks). Missing files fall back to the shipped
//     pack asset — a method only overrides what it changes.
//   - Runtime methods implement install()/perFrame()/uninstall() against the
//     live LabPawn (body + attached equipment). install runs AFTER the pawn is
//     built and dressed; uninstall runs before the next rebuild or method
//     switch. NOTHING here may touch game-runtime modules — lab-only.
//   - Every method is judged on the DENSE GAIT GATE: full scrub of walk_f,
//     run_f, swing_h1, and mlab_mix2_dig-and-plant-seeds — not a hero frame.
import type { AnimationClip, Group, Scene } from "three";
import type { PawnPack } from "../../../assets/pawnPack";
import type { LabPawn, LabStage } from "../stage";

export interface CreaseMethodCtx {
  pawn: LabPawn;
  stage: LabStage;
  scene: Scene;
  pack: PawnPack;
  wornIds: readonly string[];
}

export interface CreaseMethod {
  /** kebab id; also the crease-methods/<id>/ asset dir name. */
  id: string;
  /** short UI label (uppercase-friendly). */
  label: string;
  /** one-line foundation description for the method chip tooltip/status. */
  blurb: string;
  /**
   * Garment GLB override root ("/assets/pawn-pack/crease-methods/<id>").
   * For each worn item the lab tries `<root>/Under/<file>` first, falling
   * back to the shipped pack scene on 404.
   */
  assetRoot?: string;
  /** Replacement male body GLB url (accommodation slot). Optional. */
  bodyUrl?: string;
  /** Replacement clip set url (52-bone rebaked packs etc.). Optional. */
  clipsUrl?: string;
  install?(ctx: CreaseMethodCtx): void | Promise<void>;
  perFrame?(ctx: CreaseMethodCtx, dtSeconds: number): void;
  uninstall?(ctx: CreaseMethodCtx): void;
  /**
   * Radical escape hatch (52-bone rigs, union meshes): transform the whole
   * pack before the pawn is built. Runs after assetRoot/bodyUrl sugar.
   * MUST return a NEW object (never mutate the shipped pack).
   */
  packPatch?(pack: PawnPack, tools: { loadGlb: (url: string) => Promise<Group> }): PawnPack | Promise<PawnPack>;
}

export const BASELINE_METHOD_ID = "baseline";

const BASELINE: CreaseMethod = {
  id: BASELINE_METHOD_ID,
  label: "BASELINE",
  blurb: "Shipped state: accommodation body + reverted pants, plain LBS.",
};

/** Auto-discover `m-*.ts` siblings — lanes add methods with zero shared-file edits. */
const discovered = import.meta.glob<{ default: CreaseMethod }>("./m-*.ts", { eager: true });

export const CREASE_METHODS: readonly CreaseMethod[] = [
  BASELINE,
  ...Object.keys(discovered)
    .sort()
    .map((key) => discovered[key]!.default)
    .filter((method): method is CreaseMethod => !!method && typeof method.id === "string"),
];

export function creaseMethodById(id: string | null): CreaseMethod {
  return CREASE_METHODS.find((method) => method.id === id) ?? BASELINE;
}

// ── shared helpers for method lanes ─────────────────────────────────────────

/** Fetch-with-fallback: resolve a method override GLB url or null (404/HTML). */
export async function methodOverrideExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return false;
    const type = response.headers.get("content-type") ?? "";
    // Vite serves index.html for absent public files.
    return !type.includes("text/html");
  } catch {
    return false;
  }
}

/** Clip names of the mandatory dense-gait gate (methods self-test on these). */
export const DENSE_GAIT_CLIPS: readonly string[] = [
  "walk_f",
  "run_f",
  "swing_h1",
  "mlab_mix2_dig-and-plant-seeds",
];
