// m-charfix.ts — CHAR FIX: the combined character repair (RUN FIX + BODY FIX).
//
// One method so the owner can judge the full fix in a single dropdown flip:
//   - bodyfix fork body: rebuilt glute mass (+22mm apex, trailing-thigh posterior
//     depth 9.1→63.2mm at push-off), 6 thigh-root rings, creasebody's densified
//     crease band + flexion ramp, seat weights that follow the leg back
//     (denim seat mean 0.43 thigh), band-agreed gate pants, zero poke;
//   - runfix tuned run_f clip (pelvis upright 82.7-88°, thigh peaks capped
//     symmetric, chest keeps the sprint attack, footfalls exact; crease closure
//     ≤50.4° vs 93.7° shipped).
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CreaseMethod } from "./registry";

const BODYFIX_ROOT = "/assets/pawn-pack/crease-methods/bodyfix";
const CLIP_URL = "/assets/pawn-pack/crease-methods/runfix/run_f_tuned.glb";

const CHARFIX: CreaseMethod = {
  id: "charfix",
  label: "CHAR FIX (RUN+BODY)",
  blurb: "Combined: retuned run_f posture + rebuilt glutes/crease band with leg-following seat weights.",
  bodyUrl: `${BODYFIX_ROOT}/body_male_bodyfix.glb`,
  assetRoot: BODYFIX_ROOT,
  packPatch: async (pack) => {
    try {
      const gltf = await new GLTFLoader().loadAsync(CLIP_URL);
      const tuned = gltf.animations.find((clip) => clip.name === "run_f") ?? gltf.animations[0];
      if (!tuned) return pack;
      tuned.name = "run_f";
      const clips = new Map(pack.clips);
      clips.set("run_f", tuned);
      return { ...pack, clips };
    } catch (error) {
      console.warn("charfix: tuned clip GLB failed to load, using shipped run_f", error);
      return pack;
    }
  },
};

export default CHARFIX;
