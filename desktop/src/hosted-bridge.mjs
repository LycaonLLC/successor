/**
 * Renderer-facing trust boundary for the hosted flow.
 *
 * The launch envelope crosses to the game renderer exactly once, over a
 * context-isolated IPC invoke, bound to one webContents. Shell-control IPC is
 * accepted only from the desktop-owned shell pages. Nothing here touches the
 * network or Electron directly, so the rules are testable as plain functions.
 */

export const SHELL_PAGE_URL_PREFIX = "successor://shell/";
export const APP_PAGE_URL_PREFIX = "successor://app/";

export function isShellSenderUrl(url) {
  return typeof url === "string" && url.startsWith(SHELL_PAGE_URL_PREFIX);
}

export function isGameSenderUrl(url, allowedDevOrigins = []) {
  if (typeof url !== "string") return false;
  if (url.startsWith(APP_PAGE_URL_PREFIX)) return true;
  try {
    return allowedDevOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * One-use launch handoff. `arm` binds an envelope to the webContents that is
 * about to load the game page; `take` releases it once to exactly that
 * webContents and clears it. Wrong sender takes nothing and does NOT burn the
 * pending launch (the trusted window can still collect it).
 */
export function createLaunchHandoff() {
  let pending = null;

  return {
    arm(envelope, webContentsId) {
      pending = { envelope, webContentsId };
    },

    disarm() {
      pending = null;
    },

    armed() {
      return pending !== null;
    },

    take(webContentsId) {
      if (!pending || pending.webContentsId !== webContentsId) return null;
      const { envelope } = pending;
      pending = null;
      return envelope;
    },
  };
}
