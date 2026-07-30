// m-runfix.ts — RUN FIX: retuned run_f clip merged over the pack clip by name.
//
// The shipped run_f violates the wardrobe envelope: pelvis pitch 64.8-70.9°
// (forward slump) + peak world thigh flexion 65.2°(L)/72.0°(R) = local crease
// closure ~92°, far past the garments' ~43° authored max. The tuned clip
// (Blender rebake at the EXACT original 22 key times, 0.7333s, no retiming):
//   - pelvis pitch 82.7-88.0° (touchdown-boosted, rate-limited 2°/key);
//   - sprint attack moved to the upper spine (chest keeps original lean +6°);
//   - forward thigh flexion shape-preserving remap, both peaks at 43°;
//   - backward extension (push-off / butt-kick) fully preserved;
//   - feet re-planted via 2-bone IK: contact heights exact (dz=0), plant
//     pull-in <=5.2cm, root/pelvis translation untouched.
// Result: crease closure <=50.4° at all frames (worst single touchdown key).
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CreaseMethod } from "./registry";

const CLIP_URL = "/assets/pawn-pack/crease-methods/runfix/run_f_tuned.glb";

const RUNFIX: CreaseMethod = {
  id: "runfix",
  label: "RUN FIX",
  blurb: "Retuned run_f: pelvis upright, thigh peaks capped 43°, chest keeps sprint attack, footfalls exact.",
  // The registry's loadGlb sugar returns only gltf.scene (animations dropped),
  // so this method loads its clips GLB with its own loader.
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
      console.warn("runfix: tuned clip GLB failed to load, using shipped run_f", error);
      return pack;
    }
  },
};

export default RUNFIX;
