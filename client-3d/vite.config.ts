import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { client3dManualChunks, isDeferredFeatureAsset } from "./src/build/bundlePolicy";
import type { ServerResponse } from "node:http";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const clientPublicDir = path.resolve(packageDir, "../client/public");
const sharedPublicPrefixes = ["/successor-slice/", "/successor-audio/"];
const gameLabVite = process.env.SUCCESSOR_GAME_LAB === "1";

function clientPublicAssetsPlugin(enabled: boolean): Plugin {
  const middleware = (
    request: { url?: string },
    response: ServerResponse,
    next: () => void,
  ) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!sharedPublicPrefixes.some((prefix) => pathname.startsWith(prefix))) {
      next();
      return;
    }

    let relativePath: string;
    try {
      relativePath = decodeURIComponent(pathname.slice(1));
    } catch {
      response.statusCode = 400;
      response.end("bad asset path");
      return;
    }

    const filePath = path.resolve(clientPublicDir, relativePath);
    if (!isPathInside(filePath, clientPublicDir)) {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }

    fs.realpath(clientPublicDir, (rootError, realRoot) => {
      if (rootError) {
        next();
        return;
      }
      fs.realpath(filePath, (realError, realFilePath) => {
        if (realError || !isPathInside(realFilePath, realRoot)) {
          response.statusCode = realError ? 404 : 403;
          response.end(realError ? "not found" : "forbidden");
          return;
        }
        fs.stat(realFilePath, (statError, stats) => {
          if (statError || !stats.isFile()) {
            next();
            return;
          }
          response.setHeader("Content-Type", contentTypeFor(realFilePath));
          response.setHeader("Cache-Control", "no-cache");
          fs.createReadStream(realFilePath).pipe(response);
        });
      });
    });
  };
  return {
    name: "successor-client-public-assets",
    configureServer(server) {
      if (enabled) server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      if (enabled) server.middlewares.use(middleware);
    },
  };
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

const productionPublicDir = path.resolve(packageDir, ".generated/production-assets");
const productionAssetManifestPath = path.join(productionPublicDir, "production-asset-manifest.json");
const safeClientReleaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*@[a-f0-9]{16,64}$/;

export interface ProductionAssetIdentity {
  releaseId: string;
  contentHash: string;
}

/** Pure empty identity — generator has not written a manifest yet. */
export function emptyProductionAssetIdentity(): ProductionAssetIdentity {
  return { releaseId: "", contentHash: "" };
}

/**
 * Read production asset identity from a manifest path at call time.
 * Real builds run generate-production-assets before vite; config must not
 * snapshot the file at module import (import-order/tests freeze empty).
 */
export function readProductionAssetIdentity(manifestPath: string): ProductionAssetIdentity {
  if (!fs.existsSync(manifestPath)) return emptyProductionAssetIdentity();
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      releaseId?: unknown;
      contentHash?: unknown;
    };
    return {
      releaseId: typeof parsed.releaseId === "string" ? parsed.releaseId : "",
      contentHash: typeof parsed.contentHash === "string" ? parsed.contentHash : "",
    };
  } catch {
    return emptyProductionAssetIdentity();
  }
}

/**
 * Build production `define` bindings from an explicit asset identity plus env.
 * Asset ids and protocol/client release ids stay independent inputs.
 */
export function productionDefineEnv(input: {
  assetIdentity: ProductionAssetIdentity;
  packageMode?: string;
  clientReleaseId?: string;
  storefrontOrigin?: string;
  serverReleaseId?: string;
  gameOrigin?: string;
  chatOrigin?: string;
}): Record<string, string> {
  const packageMode = input.packageMode ?? process.env.SUCCESSOR_PACKAGE_MODE;
  return {
    "import.meta.env.SUCCESSOR_ASSET_CONTENT_HASH": JSON.stringify(input.assetIdentity.contentHash),
    "import.meta.env.SUCCESSOR_ASSET_RELEASE_ID": JSON.stringify(input.assetIdentity.releaseId),
    "import.meta.env.SUCCESSOR_CLIENT_RELEASE_ID": JSON.stringify(
      validateClientReleaseId(input.clientReleaseId ?? process.env.SUCCESSOR_CLIENT_RELEASE_ID, packageMode),
    ),
    "import.meta.env.SUCCESSOR_STOREFRONT_ORIGIN": JSON.stringify(
      validateStorefrontOrigin(input.storefrontOrigin ?? process.env.SUCCESSOR_STOREFRONT_ORIGIN, packageMode),
    ),
    "import.meta.env.SUCCESSOR_SERVER_RELEASE_ID": JSON.stringify(
      input.serverReleaseId ?? process.env.SUCCESSOR_SERVER_RELEASE_ID ?? "",
    ),
    "import.meta.env.SUCCESSOR_GAME_ORIGIN": JSON.stringify(
      validateSocketOrigin(input.gameOrigin ?? process.env.SUCCESSOR_GAME_ORIGIN, "SUCCESSOR_GAME_ORIGIN", packageMode),
    ),
    "import.meta.env.SUCCESSOR_CHAT_ORIGIN": JSON.stringify(
      validateSocketOrigin(input.chatOrigin ?? process.env.SUCCESSOR_CHAT_ORIGIN, "SUCCESSOR_CHAT_ORIGIN", packageMode),
    ),
  };
}

export function validateClientReleaseId(
  clientReleaseId: string | undefined,
  packageMode: string | undefined = process.env.SUCCESSOR_PACKAGE_MODE,
): string {
  if (packageMode !== "hosted-release") return clientReleaseId ?? "";
  if (!clientReleaseId || !safeClientReleaseIdPattern.test(clientReleaseId)) {
    throw new Error("SUCCESSOR_CLIENT_RELEASE_ID must be a safe base@hash release id for hosted-release builds");
  }
  return clientReleaseId;
}

export function validateStorefrontOrigin(origin: string | undefined, packageMode: string | undefined = process.env.SUCCESSOR_PACKAGE_MODE): string {
  if (packageMode !== "hosted-release") return origin ?? "";
  if (!origin) throw new Error("SUCCESSOR_STOREFRONT_ORIGIN is required for hosted-release builds");
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("SUCCESSOR_STOREFRONT_ORIGIN must be an exact HTTPS origin"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.hostname.includes("*") || origin !== parsed.origin) throw new Error("SUCCESSOR_STOREFRONT_ORIGIN must be an exact HTTPS origin");
  return parsed.origin;
}

export function validateSocketOrigin(origin: string | undefined, field: string, packageMode: string | undefined = process.env.SUCCESSOR_PACKAGE_MODE): string {
  if (packageMode !== "hosted-release") return origin ?? "";
  if (!origin) throw new Error(`${field} is required for hosted-release builds`);
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error(`${field} must be an exact WSS origin`); }
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.hostname.includes("*") || origin !== parsed.origin) throw new Error(`${field} must be an exact WSS origin`);
  return parsed.origin;
}

export function rollupInputForMode(mode: string) {
  const inputs = {
    main: path.resolve(packageDir, "index.html"),
  };
  return mode === "production"
    ? inputs
    : { ...inputs, viewer: path.resolve(packageDir, "viewer.html") };
}

export default defineConfig(({ mode }) => {
  // Read generated manifest at config invocation (after generate-production-assets
  // for real builds). Never freeze identity at module import time.
  const productionAssetIdentity = mode === "production"
    ? readProductionAssetIdentity(productionAssetManifestPath)
    : emptyProductionAssetIdentity();
  return {
    base: "./",
    publicDir: mode === "production" ? productionPublicDir : path.resolve(packageDir, "public"),
    define: mode === "production"
      ? productionDefineEnv({ assetIdentity: productionAssetIdentity })
      : {},
    server: {
      host: "127.0.0.1",
      port: 5179,
      strictPort: true,
      watch: { ignored: ["**/.game-lab/**", "../.game-lab/**"] },
      ...(gameLabVite ? { hmr: false as const } : {}),
    },
    preview: {
      host: "127.0.0.1",
      port: 5179,
      strictPort: true,
    },
    plugins: [clientPublicAssetsPlugin(mode !== "production")],
    build: {
      chunkSizeWarningLimit: 900,
      // Only preload eager vendor deps of the entry (three). Never modulepreload
      // feature-* chunks — those load on first open / idle preload after world ready.
      modulePreload: {
        resolveDependencies: (_filename, deps) => deps.filter((dep) => !isDeferredFeatureAsset(dep)),
      },
      rollupOptions: {
        input: rollupInputForMode(mode),
        output: {
          // Keep shared/eager modules out of feature chunks so dynamic import()
          // stays a real cold-path boundary (not cosmetic relocation).
          onlyExplicitManualChunks: true,
          // Stable named vendor chunk for Three.js; feature windows split via
          // static import() boundaries in deferredWindows (no tiny-chunk spray).
          manualChunks: client3dManualChunks,
        },
      },
    },
  };
});
