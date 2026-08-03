#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const CLIENT_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u;
const SERVER_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RUNTIME_EXTENSIONS = new Set([".glb", ".gltf", ".png", ".jpg", ".jpeg", ".webp", ".mp3", ".ogg", ".wav", ".json"]);
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "application/javascript"],
  [".wasm", "application/wasm"], [".json", "application/json"],
  [".glb", "model/gltf-binary"], [".gltf", "model/gltf+json"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".mp3", "audio/mpeg"], [".ogg", "audio/ogg"], [".wav", "audio/wav"],
]);

function args(argv) {
  const values = { out: "out/web-release" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--source-commit", "--client-release-id", "--server-release-id", "--storefront-origin", "--game-origin", "--chat-origin", "--out"].includes(key)) throw new Error(`unknown argument ${key}`);
    values[key.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  for (const key of ["source_commit", "client_release_id", "server_release_id", "storefront_origin", "game_origin", "chat_origin"]) if (!values[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  if (!COMMIT.test(values.source_commit)) throw new Error("source commit must be an exact lowercase commit");
  if (!CLIENT_RELEASE_ID.test(values.client_release_id) || !SERVER_RELEASE_ID.test(values.server_release_id)) throw new Error("release ids are invalid");
  if (!/^https:\/\/[^/*?#]+$/u.test(values.storefront_origin)) throw new Error("storefront_origin must be one exact HTTPS origin");
  for (const key of ["game_origin", "chat_origin"]) if (!/^wss:\/\/[^/*?#]+$/u.test(values[key])) throw new Error(`${key} must be one exact WSS origin`);
  return values;
}

async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function strings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, found);
  return found;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const options = args(process.argv.slice(2));
const root = resolve(import.meta.dirname, "..");
const repo = resolve(root, "..");
const out = resolve(root, options.out);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(resolve(root, "target/wasm32-unknown-unknown/release/successor_client.wasm"), join(out, "successor.wasm"));
await cp(resolve(root, "web/index.html"), join(out, "index.html"));

const sourceShim = await readFile(resolve(root, "web/successor.js"), "utf8");
const developmentBlock = /const successorBuild = Object\.freeze\(\{[\s\S]*?\n\}\);/u;
if (!developmentBlock.test(sourceShim)) throw new Error("web build configuration block not found");
let releaseShim = sourceShim.replace(developmentBlock, `const successorBuild = Object.freeze(${JSON.stringify({
  allowDevLaunch: false,
  storefrontOrigin: options.storefront_origin,
  clientReleaseId: options.client_release_id,
  serverReleaseId: options.server_release_id,
  gameOrigin: options.game_origin,
  chatOrigin: options.chat_origin,
}, null, 4)});`);
releaseShim = releaseShim.replace(
  /function takeDevelopmentLaunch\(\) \{[\s\S]*?\n\}\n\n(?=function validHostedLaunch)/u,
  "function takeDevelopmentLaunch() { return \"\"; }\n\n",
);
releaseShim = releaseShim
  .replace('new URLSearchParams(location.search).has("disable-half-float")', "false")
  .replace(
    /        const params = new URLSearchParams\(window\.location\.search\);[\s\S]*?        window\.__successorRenderReady = false;/u,
    `        const demoSelector = 0;
        showLoading("CONNECTING", "WAITING FOR LAUNCH", 0);
        await waitForHostedLaunch();
        await fetchInitialAssets();
        showLoading("ENTERING WORLD", "BUILDING SCENE", 1);
        window.__successorRenderReady = false;`,
  );
if (/URLSearchParams|__SUCCESSOR_LAUNCH_CONTEXT|params\.get\("launch"\)|params\.get\("demo"\)/u.test(releaseShim)) throw new Error("release shim contains a URL launch or developer probe path");
await writeFile(join(out, "successor.js"), releaseShim);

const sliceRoot = resolve(repo, "client/public/successor-slice");
await cp(sliceRoot, join(out, "successor-slice"), { recursive: true });
const pawnPackRoot = resolve(repo, "client-3d/public/assets/pawn-pack");
await cp(pawnPackRoot, join(out, "assets/pawn-pack"), { recursive: true });
const audioRoot = resolve(repo, "client/public/successor-audio");
await cp(audioRoot, join(out, "successor-audio"), { recursive: true });
await mkdir(join(out, "render"), { recursive: true });
const propsMapping = resolve(repo, "client-3d/src/render/props-mapping.json");
await cp(propsMapping, join(out, "render/props-mapping.json"));

const sourceDocs = [propsMapping, ...await filesUnder(sliceRoot)];
const references = new Set();
for (const document of sourceDocs.filter(path => extname(path) === ".json")) {
  for (const value of strings(JSON.parse(await readFile(document, "utf8")))) {
    const clean = value.split(/[?#]/u, 1)[0].replace(/^\.\//u, "").replace(/^\//u, "");
    if (RUNTIME_EXTENSIONS.has(extname(clean).toLowerCase()) && !clean.startsWith("successor-slice/")) references.add(clean);
  }
}
const rustSources = [resolve(root, "source/app/src/pawn/creatures.rs")];
for (const source of rustSources) {
  const text = await readFile(source, "utf8");
  for (const match of text.matchAll(/["']\/?((?:assets|successor-audio)\/[^"'?#]+\.(?:glb|gltf|png|jpe?g|webp|mp3|ogg|wav))["']/giu)) {
    references.add(match[1]);
  }
}
for (const category of ["mineral", "chemical", "gas", "water"]) references.add(`assets/world-items/extractor_${category}.glb`);
references.add("assets/world-items/podtent_scout.glb");
references.add("assets/world-items/campfire_scout.glb");
const publicRoots = [resolve(repo, "client-3d/public"), resolve(repo, "client/public")];
const candidates = (await Promise.all(publicRoots.map(path => filesUnder(path)))).flat();
for (const reference of [...references].sort()) {
  const normalized = reference.replaceAll("/", sep);
  const matches = candidates.filter(path => path.endsWith(normalized) || relative(resolve(repo, "client-3d/public"), path) === normalized || relative(resolve(repo, "client/public"), path) === normalized);
  if (matches.length === 0) throw new Error(`required runtime asset is missing: ${reference}`);
  const source = matches.sort((a, b) => a.length - b.length)[0];
  const marker = source.includes(`${sep}client-3d${sep}public${sep}`) ? resolve(repo, "client-3d/public") : resolve(repo, "client/public");
  const targetPath = relative(marker, source);
  const destination = join(out, targetPath);
  await mkdir(resolve(destination, ".."), { recursive: true });
  await cp(source, destination);
}
const pointerOrigin = "https://release.invalid";
await writeFile(join(out, "current.json"), `${JSON.stringify({
  releaseId: options.client_release_id,
  launchPage: `${pointerOrigin}/index.html`,
  entryScript: `${pointerOrigin}/successor.js`,
  styles: [],
  assetBaseUrl: `${pointerOrigin}/`,
  storeOrigin: options.storefront_origin,
}, null, 2)}\n`);


const inventory = [];
for (const path of await filesUnder(out)) {
  if (path.endsWith("release-manifest.json") || path.endsWith("current.json")) continue;
  const bytes = await readFile(path);
  const name = relative(out, path).split(sep).join("/");
  inventory.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes), contentType: CONTENT_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream" });
}
const initialAssets = inventory
  .map(file => file.path)
  .filter(path => path.startsWith("assets/") || path.startsWith("render/") || path.startsWith("successor-audio/") || path.startsWith("successor-slice/"))
  .sort();
if (initialAssets.length === 0) throw new Error("initial asset stream is empty");
const manifest = {
  schema: "successor.rust-web-release.v1",
  sourceCommit: options.source_commit,
  clientReleaseId: options.client_release_id,
  serverReleaseId: options.server_release_id,
  storefrontOrigin: options.storefront_origin,
  gameOrigin: options.game_origin,
  chatOrigin: options.chat_origin,
  files: inventory,
  initialAssets,
};
await writeFile(join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ out, files: inventory.length, bytes: inventory.reduce((sum, file) => sum + file.bytes, 0), manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))) }, null, 2));
