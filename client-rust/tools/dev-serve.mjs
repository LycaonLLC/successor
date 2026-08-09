#!/usr/bin/env node
// Loopback-only development server for the Rust web client. Serves the built
// shim/wasm from --root and maps asset URL prefixes straight to repo sources,
// so `make web` never copies the asset tree. `--release <dir>` instead serves
// an assembled out/web-release verbatim (verification of the real artifact).
// With --launch dev (default) the served index.html carries a dev-identity
// launch context pointing at a local authority (default 127.0.0.1:28093).
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { deriveBootClosure } from "./boot-closure.mjs";

const CLIENT_RUST = resolve(import.meta.dirname, "..");
const REPO = resolve(CLIENT_RUST, "..");

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript"],
  [".mjs", "application/javascript"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".wasm", "application/wasm"],
  [".glb", "model/gltf-binary"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".spak", "application/octet-stream"],
]);

function parseArgs(argv) {
  const args = { port: 8080, root: join(CLIENT_RUST, "out/web"), release: null, launch: "dev", player: "local-dev", authority: "127.0.0.1:28093" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--root") args.root = resolve(argv[++i]);
    else if (arg === "--release") args.release = resolve(argv[++i]);
    else if (arg === "--launch") args.launch = argv[++i];
    else if (arg === "--player-id") args.player = argv[++i];
    else if (arg === "--authority") args.authority = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.port) || args.port <= 0) throw new Error("--port must be a positive integer");
  if (!["dev", "none"].includes(args.launch)) throw new Error("--launch must be dev or none");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const serveRoot = args.release ?? args.root;
const repoMapping = !args.release;

// Release mode also serves the content-addressed object namespace: object
// sha → release file, straight from the assembled release manifest.
const objectIndex = new Map();
if (args.release) {
  const manifest = JSON.parse(await readFile(join(serveRoot, "release-manifest.json"), "utf8"));
  for (const file of manifest.files ?? []) {
    if (typeof file.sha256 === "string") objectIndex.set(file.sha256, file.path);
  }
}

// Mirrors NativePlatform::read_asset (source/platform/src/lib.rs): stable ids
// resolve against repo asset roots; parity-assets are the six demo GLBs.
const PREFIX_MAPS = [
  { prefix: "/assets/", root: join(REPO, "client-3d/public/assets") },
  { prefix: "/successor-slice/", root: join(REPO, "client/public/successor-slice") },
  { prefix: "/successor-audio/", root: join(REPO, "client/public/successor-audio") },
];
const RENDER_FILES = new Map([
  ["/render/props-mapping.json", join(REPO, "client-3d/src/render/props-mapping.json")],
]);
const PARITY_FILES = new Map([
  ["commerce_facility.glb", "client-3d/public/assets/world-items/commerce_facility.glb"],
  ["lightning_carbine.glb", "client-3d/public/assets/pawn-pack/weapons/custom/lightning_carbine.glb"],
  ["mossmuff_adult.glb", "client-3d/public/assets/creatures/mossmuff_adult.glb"],
  ["successor_food_beer_mug.glb", "client-3d/public/assets/wave-props/everyday-wave-20260719/prepared-foods/successor_food_beer_mug.glb"],
  ["field_cap.glb", "client-3d/public/assets/items/custom/accessories/field_cap.glb"],
  ["megalith_brick_hex.glb", "client-3d/public/assets/world-items/megalith_brick_hex.glb"],
]);

function resolveRepoFile(pathname) {
  if (pathname.startsWith("/objects/")) {
    const sha = pathname.slice("/objects/".length);
    const mapped = objectIndex.get(sha);
    return mapped ? join(serveRoot, mapped) : null;
  }
  if (!repoMapping) return null;
  if (RENDER_FILES.has(pathname)) return RENDER_FILES.get(pathname);
  if (pathname.startsWith("/parity-assets/")) {
    const name = pathname.slice("/parity-assets/".length);
    const mapped = PARITY_FILES.get(name);
    return mapped ? join(REPO, mapped) : null;
  }
  for (const { prefix, root } of PREFIX_MAPS) {
    if (!pathname.startsWith(prefix)) continue;
    const relative = pathname.slice(prefix.length);
    const candidate = normalize(join(root, relative));
    if (!candidate.startsWith(root + sep)) return null;
    return candidate;
  }
  return null;
}

function resolveRootFile(pathname) {
  const relative = pathname.replace(/^\/+/u, "") || "index.html";
  const candidate = normalize(join(serveRoot, relative));
  if (!candidate.startsWith(serveRoot + sep) && candidate !== serveRoot) return null;
  return candidate;
}

async function walkFiles(root, prefix, out = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(path, `${prefix}${entry.name}/`, out);
    else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
  }
  return out;
}

// Development manifest: real sizes, zero hashes (the dev shim never consults
// content hashes). Regenerated per request; a stat walk is milliseconds. The
// boot closure is the same derivation the release builder uses, so a dev boot
// downloads exactly what a production boot would.
let bootClosureCache = null;
async function devManifest() {
  const files = [];
  if (repoMapping) {
    for (const { prefix, root } of PREFIX_MAPS) {
      for (const path of await walkFiles(root, "")) {
        const info = await stat(join(root, path));
        files.push({ path: `${prefix.slice(1)}${path}`, bytes: info.size, sha256: "0".repeat(64) });
      }
    }
    const mapping = RENDER_FILES.get("/render/props-mapping.json");
    files.push({ path: "render/props-mapping.json", bytes: (await stat(mapping)).size, sha256: "0".repeat(64) });
  } else {
    for (const path of await walkFiles(serveRoot, "")) {
      if (path === "release-manifest.json" || path === "current.json") continue;
      const info = await stat(join(serveRoot, path));
      files.push({ path, bytes: info.size, sha256: "0".repeat(64) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (repoMapping) {
    if (!bootClosureCache) bootClosureCache = await deriveBootClosure(REPO);
    return {
      schema: "successor.rust-web-release.v2",
      sourceCommit: "dev",
      clientReleaseId: "successor-rust-dev@local",
      serverReleaseId: "local",
      storefrontOrigin: `http://127.0.0.1:${args.port}`,
      gameOrigin: `ws://${args.authority}`,
      chatOrigin: `ws://${args.authority}`,
      files,
      boot: bootClosureCache.boot,
      packIndex: {},
    };
  }
  const initialAssets = files
    .map((file) => file.path)
    .filter((path) => path.startsWith("assets/") || path.startsWith("render/") || path.startsWith("successor-audio/") || path.startsWith("successor-slice/"))
    .sort();
  return {
    schema: "successor.rust-web-release.v1",
    sourceCommit: "dev",
    clientReleaseId: "successor-rust-dev@local",
    serverReleaseId: "local",
    storefrontOrigin: `http://127.0.0.1:${args.port}`,
    gameOrigin: `ws://${args.authority}`,
    chatOrigin: `ws://${args.authority}`,
    files,
    initialAssets,
  };
}

function percentEncode(value) {
  return encodeURIComponent(value).replace(/%20/gu, "%20");
}

async function devLaunchContext() {
  const statusUrl = `http://${args.authority}/game/status`;
  let shard = "open-desert-persistent";
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const status = await response.json();
    if (typeof status.shardId === "string" && status.shardId.length > 0) shard = status.shardId;
  } catch (error) {
    console.error(`dev-serve: --launch dev needs a local authority at ${statusUrl}`);
    console.error(`dev-serve: start one with \`pnpm server:local:persistent\` (${error.message})`);
    process.exit(1);
  }
  return {
    schema: "successor.launch-context.v1",
    gameTicket: "dev-identity",
    chatTicket: "dev-chat",
    characterId: args.player,
    expiresAt: Date.now() + 3_600_000,
    endpoints: {
      game: `ws://${args.authority}`,
      chat: `ws://${args.authority}/chat/ws?playerId=${percentEncode(args.player)}`,
    },
    release: { client: "successor-rust-dev@local", server: "local", shard },
  };
}

let launchScript = null;
if (args.launch === "dev") {
  const context = await devLaunchContext();
  launchScript = `<script>window.__SUCCESSOR_LAUNCH_CONTEXT = ${JSON.stringify(JSON.stringify(context))};</script>\n`;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/release-manifest.json" && repoMapping) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(await devManifest(), null, 2));
      return;
    }
    const file = resolveRepoFile(pathname) ?? resolveRootFile(pathname);
    if (!file) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("forbidden\n");
      return;
    }
    let body;
    try {
      body = await readFile(file);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(`not found: ${pathname}\n`);
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      let html = body.toString("utf8");
      if (launchScript) html = html.replace('<script type="module" src="./successor.js"></script>', `${launchScript}    <script type="module" src="./successor.js"></script>`);
      body = Buffer.from(html);
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(`dev-serve error: ${error.message}\n`);
  }
});

server.listen(args.port, "127.0.0.1", () => {
  console.log(`dev-serve: http://127.0.0.1:${args.port}/ (root ${serveRoot}${repoMapping ? " + repo asset mapping" : ""}, launch ${args.launch})`);
});
