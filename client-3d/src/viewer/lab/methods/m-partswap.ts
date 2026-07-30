import type { CreaseMethod } from "./registry";

const ROOT = "/assets/pawn-pack/crease-methods/partswap";

const PARTSWAP: CreaseMethod = {
  id: "partswap",
  label: "PART SWAP (SYNTY NATIVE)",
  blurb: "Native outfit-02 part replacement on the exact runtime 50-bone pawn skeleton.",
  bodyUrl: `${ROOT}/body_male_partswap.glb`,
  packPatch: async (pack, { loadGlb }) => {
    const [clothed, bare] = await Promise.all([
      loadGlb(`${ROOT}/body_male_partswap.glb`),
      loadGlb(`${ROOT}/body_male_partswap_bare.glb`),
    ]);
    const clips = new Map(pack.clips);
    for (const name of ["walk_f", "run_f", "swing_h1", "mlab_mix2_dig-and-plant-seeds"]) {
      const clip = pack.clips.get(name);
      if (clip) clips.set(name, clip);
    }
    return {
      ...pack,
      bodies: { ...pack.bodies, male: clothed },
      bareBodies: { ...(pack.bareBodies ?? {}), male: bare },
      clips,
    };
  },
};

export default PARTSWAP;
