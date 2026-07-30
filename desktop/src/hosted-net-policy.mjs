/**
 * Scoped network header policy for the hosted game page.
 *
 * The standalone game/chat sockets require the exact HTTPS storefront Origin,
 * but the desktop renderer would emit its packaged app origin. This policy —
 * bound to ONE webContents and the EXACT game/chat hosts from the armed
 * launch envelope — rewrites Origin to the configured storefront origin for
 * WebSocket upgrades and matchmake/backend HTTP on those hosts only, strips
 * any Cookie/Authorization material so account API credentials can never ride
 * along, and cancels WebSocket connects to unexpected hosts. Everything else
 * (other webContents, other hosts, other schemes) passes untouched.
 *
 * Pure decision logic; Electron session wiring lives in main.mjs.
 */

export function createHostedNetworkPolicy({ storefrontOrigin, appOrigin = "successor://app" }) {
  let boundWebContentsId = null;
  let allowedHosts = new Set();

  function parseUrl(value) {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }

  return {
    /** Bind the policy to the game webContents and the envelope's exact hosts. */
    arm(webContentsId, endpoints) {
      const hosts = [endpoints?.game, endpoints?.chat]
        .map((endpoint) => parseUrl(endpoint)?.host)
        .filter(Boolean);
      if (hosts.length !== 2) throw new Error("hosted network policy requires exact game and chat endpoints");
      boundWebContentsId = webContentsId;
      allowedHosts = new Set(hosts);
    },

    clear() {
      boundWebContentsId = null;
      allowedHosts = new Set();
    },

    armed() {
      return boundWebContentsId !== null;
    },

    /** onBeforeRequest: refuse sockets to hosts outside the armed envelope. */
    decideRequest({ webContentsId, url }) {
      if (boundWebContentsId === null || webContentsId !== boundWebContentsId) return { cancel: false };
      const parsed = parseUrl(url);
      if (!parsed) return { cancel: false };
      if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
        return { cancel: !allowedHosts.has(parsed.host) };
      }
      return { cancel: false };
    },

    /**
     * onBeforeSendHeaders: for the bound webContents talking to an allowed
     * host, present the storefront Origin and drop Cookie/Authorization.
     * Returns null when the request is not ours to touch.
     */
    decideHeaders({ webContentsId, url, requestHeaders }) {
      if (boundWebContentsId === null || webContentsId !== boundWebContentsId) return null;
      const parsed = parseUrl(url);
      if (!parsed) return null;
      const socket = parsed.protocol === "ws:" || parsed.protocol === "wss:";
      const httpish = parsed.protocol === "http:" || parsed.protocol === "https:";
      if (!socket && !httpish) return null;
      if (!allowedHosts.has(parsed.host)) return null;
      const headers = {};
      for (const [name, value] of Object.entries(requestHeaders ?? {})) {
        const lower = name.toLowerCase();
        if (lower === "origin" || lower === "cookie" || lower === "authorization") continue;
        headers[name] = value;
      }
      headers.Origin = storefrontOrigin;
      return { requestHeaders: headers };
    },

    /**
     * onHeadersReceived: because the outbound Origin is the storefront, the
     * server's CORS echo can no longer match the renderer's real origin.
     * For the bound webContents talking to an allowed host we grant the
     * renderer's true origin (the game client fetches with credentials mode
     * "include", which forbids a wildcard) — safe here because every cookie
     * and Authorization header was stripped outbound and the grant is scoped
     * to these two hosts only. Returns null when not ours to touch.
     */
    decideResponseHeaders({ webContentsId, url, responseHeaders }) {
      if (boundWebContentsId === null || webContentsId !== boundWebContentsId) return null;
      const parsed = parseUrl(url);
      if (!parsed) return null;
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (!allowedHosts.has(parsed.host)) return null;
      const headers = {};
      for (const [name, value] of Object.entries(responseHeaders ?? {})) {
        if (name.toLowerCase().startsWith("access-control-allow-")) continue;
        headers[name] = value;
      }
      headers["Access-Control-Allow-Origin"] = [appOrigin];
      headers["Access-Control-Allow-Credentials"] = ["true"];
      headers["Access-Control-Allow-Methods"] = ["GET, POST, OPTIONS"];
      headers["Access-Control-Allow-Headers"] = ["content-type"];
      headers["Access-Control-Allow-Private-Network"] = ["true"];
      return { responseHeaders: headers };
    },
  };
}
