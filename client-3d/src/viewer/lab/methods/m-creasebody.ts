import type { CreaseMethod } from "./registry";

const ROOT = "/assets/pawn-pack/crease-methods/creasebody";

/**
 * CREASE BODY — rebuilt hip-crease band on a fork of the runtime body:
 * 4 new ring-coherent edge loops through the starved upper-thigh column
 * (crease-line loop at z=0.886 so the fold lands ON an edge), plus a
 * source-faithful symmetric thigh-weight ramp (t=-0.05→0.10 … 0.35→0.90)
 * applied to both the body and the three gate pants (band agreement).
 */
const CREASEBODY: CreaseMethod = {
  id: "creasebody",
  label: "CREASE BODY",
  blurb: "Densified hip-crease band + source-faithful symmetric thigh ramp on body and gate pants.",
  bodyUrl: `${ROOT}/body_male_creasebody.glb`,
  assetRoot: ROOT,
};

export default CREASEBODY;
