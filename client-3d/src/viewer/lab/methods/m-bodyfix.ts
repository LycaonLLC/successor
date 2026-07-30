import type { CreaseMethod } from "./registry";

const ROOT = "/assets/pawn-pack/crease-methods/bodyfix";

/**
 * BODY FIX — rebuilt pelvis/glute/upper-thigh REGION STRUCTURE on a fork of
 * the creasebody body: real sculpted glute mass (+22mm apex vs the shipped
 * straight taper, donor-silhouette guided), 6 thigh-root rings crotch→mid-
 * thigh, butt-crease loop at z=0.795, lateral glute loops, and a posterior-
 * aware weight field authored for EXTENSION (glute apex ~0.42 thigh,
 * hamstring-top 0.6-0.7) so the trailing-leg top keeps mass at push-off.
 * Gate pants re-agreed byte-surgically over the same field so the seat
 * travels back with the leg. Poke-checked: >=+3.9mm clearance through run_f.
 */
const BODYFIX: CreaseMethod = {
  id: "bodyfix",
  label: "BODY FIX",
  blurb: "Sculpted glute mass + thigh-root rings + extension-authored posterior weights on body and gate pants.",
  bodyUrl: `${ROOT}/body_male_bodyfix.glb`,
  assetRoot: ROOT,
};

export default BODYFIX;
