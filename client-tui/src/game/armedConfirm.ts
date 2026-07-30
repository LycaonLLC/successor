/**
 * Armed-confirm — the text twin of a destructive-confirm dialog.
 *
 * First invocation arms a keyed warning with a TTL; repeating the SAME key
 * inside the window confirms; any OTHER armed-confirm interaction (or the
 * caller's explicit disarm on unrelated input) drops the arm. One primitive
 * shared by /extractor packup (yield forfeit) and /craft cancel (lossy).
 */

export interface ArmedConfirm {
  /** Arm `key`; returns false if it was already armed (caller confirms). */
  arm(key: string, ttlMs?: number, now?: number): boolean;
  /** True and consumes when `key` is currently armed. */
  confirm(key: string, now?: number): boolean;
  disarm(): void;
  armedKey(now?: number): string | null;
}

const DEFAULT_TTL_MS = 10_000;

export function createArmedConfirm(): ArmedConfirm {
  let key: string | null = null;
  let untilMs = 0;

  return {
    arm(nextKey, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
      if (key === nextKey && now < untilMs) return false;
      key = nextKey;
      untilMs = now + ttlMs;
      return true;
    },
    confirm(candidate, now = Date.now()) {
      if (key !== candidate || now >= untilMs) return false;
      key = null;
      untilMs = 0;
      return true;
    },
    disarm() {
      key = null;
      untilMs = 0;
    },
    armedKey(now = Date.now()) {
      if (key === null || now >= untilMs) return null;
      return key;
    },
  };
}
