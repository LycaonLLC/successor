import { successorDesktopEnv } from "./env.mjs";

/**
 * Desktop runtime mode.
 *
 * "hosted" (the release default) signs in through the standalone account
 * device flow and joins the hosted shared world. No local shard ever starts.
 *
 * "offline" is the explicit developer/legacy mode: the packaged app spawns
 * the bundled local shard exactly as before the hosted cutover. It exists
 * only behind SUCCESSOR_DESKTOP_MODE=offline.
 */
export const DESKTOP_MODE_HOSTED = "hosted";
export const DESKTOP_MODE_OFFLINE = "offline";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function resolveDesktopMode(env = successorDesktopEnv) {
  const raw = env("MODE");
  if (raw === undefined || raw === "" || raw === DESKTOP_MODE_HOSTED) return DESKTOP_MODE_HOSTED;
  if (raw === DESKTOP_MODE_OFFLINE) return DESKTOP_MODE_OFFLINE;
  throw new Error(`SUCCESSOR_DESKTOP_MODE must be "hosted" or "offline"; got "${raw}"`);
}

export function shouldStartLocalShard(mode) {
  return mode === DESKTOP_MODE_OFFLINE;
}

/**
 * Hosted account API configuration. The origin must be HTTPS; plain HTTP is
 * accepted only for loopback hosts so the packaged smoke harness can stand in
 * for the real site. The approval page never carries the code — the player
 * types it in their signed-in browser.
 */
export function resolveHostedConfig(env = successorDesktopEnv, packagedReleaseId = "successor-alpha") {
  const rawOrigin = env("API_ORIGIN") || "https://www.successorgame.com";
  let url;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error("SUCCESSOR_DESKTOP_API_ORIGIN must be an absolute http(s) origin");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("SUCCESSOR_DESKTOP_API_ORIGIN must be a bare origin without path, query, or credentials");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname))) {
    throw new Error("SUCCESSOR_DESKTOP_API_ORIGIN must use https (plain http is allowed only for loopback test harnesses)");
  }
  const origin = url.origin;
  const releaseId = env("RELEASE_ID") || packagedReleaseId;
  if (typeof releaseId !== "string" || !releaseId.trim() || /[\s/?#\\]/u.test(releaseId)) {
    throw new Error("Successor desktop hosted release id is invalid");
  }
  return Object.freeze({
    apiOrigin: origin,
    connectUrl: `${origin}/connect`,
    clientId: "successor-desktop",
    releaseId,
    scopes: Object.freeze(["character:list", "play-ticket"]),
  });
}
