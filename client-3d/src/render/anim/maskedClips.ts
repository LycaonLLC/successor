// maskedClips.ts — per-bone track filtering with conflict subtraction.
//
// Port of the pawn-forge anim_preview compositor's masked-clip construction
// (viewer/anim_preview/app.js): a layer's played clip is rebuilt by filtering
// its source tracks to (layer mask) MINUS (union of higher-priority ACTIVE
// layers' masks), so every bone has EXACTLY ONE driver — no weight race.
//
// Masked AnimationClips are pure data (track subsets of the shared source
// clips) and are cached ONCE for the whole pawn population: every pawn shares
// the same skeleton bone set, so the cache key only depends on the source clip
// and the subtraction fingerprint, never on the pawn instance.
import { AnimationClip } from "three";
import { sane } from "../../assets/pawnRigTypes";

export class MaskedClipCache {
  private readonly cache = new Map<string, AnimationClip>();

  /**
   * @param srcClip shared source clip from the pack
   * @param keepSet sanitized bone names allowed to keep their tracks
   * @param fingerprint stable description of the subtraction combo (cache key part)
   */
  get(srcClip: AnimationClip, keepSet: ReadonlySet<string>, fingerprint: string): AnimationClip {
    const key = `${srcClip.name}|${fingerprint}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const tracks = srcClip.tracks.filter((track) => keepSet.has(sane(track.name.split(".")[0] ?? "")));
    const clip = new AnimationClip(`${srcClip.name}__${fingerprint}`, srcClip.duration, tracks);
    this.cache.set(key, clip);
    return clip;
  }
}
