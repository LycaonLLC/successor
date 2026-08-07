#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { deriveBootClosure } from "./boot-closure.mjs";

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
  const values = { out: "out/web-release", local_dev: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--local-dev") { values.local_dev = true; continue; }
    if (!["--source-commit", "--client-release-id", "--server-release-id", "--storefront-origin", "--game-origin", "--chat-origin", "--out"].includes(key)) throw new Error(`unknown argument ${key}`);
    values[key.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  for (const key of ["source_commit", "client_release_id", "server_release_id", "storefront_origin", "game_origin", "chat_origin"]) if (!values[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  if (!COMMIT.test(values.source_commit)) throw new Error("source commit must be an exact lowercase commit");
  if (!CLIENT_RELEASE_ID.test(values.client_release_id) || !SERVER_RELEASE_ID.test(values.server_release_id)) throw new Error("release ids are invalid");
  if (values.local_dev) {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(values.storefront_origin)) throw new Error("--local-dev storefront_origin must be one exact loopback HTTP origin");
    for (const key of ["game_origin", "chat_origin"]) if (!/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(values[key])) throw new Error(`--local-dev ${key} must be one exact loopback WS origin`);
  } else {
    if (!/^https:\/\/[^/*?#]+$/u.test(values.storefront_origin)) throw new Error("storefront_origin must be one exact HTTPS origin");
    for (const key of ["game_origin", "chat_origin"]) if (!/^wss:\/\/[^/*?#]+$/u.test(values[key])) throw new Error(`${key} must be one exact WSS origin`);
  }
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
const assertBootstrapOrder = (shim, label) => {
  const calls = ["await fetchInitialAssets();", "await prepareWebAudio();", "await waitForHostedLaunch();"];
  const positions = calls.map(call => {
    const first = shim.indexOf(call);
    if (first < 0 || first !== shim.lastIndexOf(call)) throw new Error(`${label} shim must contain exactly one ${call}`);
    return first;
  });
  if (!(positions[0] < positions[1] && positions[1] < positions[2])) throw new Error(`${label} shim bootstrap is reordered`);
};
assertBootstrapOrder(sourceShim, "source");
const developmentBlock = /const successorBuild = Object\.freeze\(\{[\s\S]*?\n\}\);/u;
if (!developmentBlock.test(sourceShim)) throw new Error("web build configuration block not found");
// --local-dev assembles the release artifact with the development launch path
// intact, for full release-path verification against a loopback authority.
// Publication pipelines never pass it; the shipped beta always strips this.
const localDev = options.local_dev;
let releaseShim = sourceShim.replace(developmentBlock, `const successorBuild = Object.freeze(${JSON.stringify({
  allowDevLaunch: localDev,
  storefrontOrigin: options.storefront_origin,
  clientReleaseId: options.client_release_id,
  serverReleaseId: options.server_release_id,
  gameOrigin: options.game_origin,
  chatOrigin: options.chat_origin,
  objectStore: true,
}, null, 4)});`);
if (!localDev) {
  releaseShim = releaseShim.replace(
    /function takeDevelopmentLaunch\(\) \{[\s\S]*?\n\}\n\n(?=function validHostedLaunch)/u,
    "function takeDevelopmentLaunch() { return \"\"; }\n\n",
  );
  releaseShim = releaseShim
    .replace('new URLSearchParams(window.location.search).get("mode") === "creator"', "false")
    .replace('new URLSearchParams(location.search).has("disable-half-float")', "false")
    .replace(
      /        const params = new URLSearchParams\(window\.location\.search\);[\s\S]*?        window\.__successorRenderReady = false;/u,
      `        const demoSelector = 0;
        await fetchInitialAssets();
        await prepareWebAudio();
        showLoading("CONNECTING", "WAITING FOR LAUNCH", 1);
        await waitForHostedLaunch();
        showLoading("ENTERING WORLD", "BUILDING SCENE", 1);
        window.__successorRenderReady = false;`,
    );
}
assertBootstrapOrder(releaseShim, "release");
if (!localDev && /URLSearchParams|__SUCCESSOR_LAUNCH_CONTEXT|params\.get\("launch"\)|params\.get\("demo"\)/u.test(releaseShim)) throw new Error("release shim contains a URL launch or developer probe path");
if (localDev) console.warn("web-release: --local-dev build retains the development launch path; never publish this artifact");
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

// ── Asset packs (successor.assetpack.v1) ────────────────────────────────────
// The shim unpacks packs into its stable-id byte cache; the Rust runtime only
// ever reads by stable id. Wardrobe/weapon GLBs stay standalone files: they
// stream on demand (and individually content-address in the object store).
const PACK_MAGIC = Buffer.from("SPAK1\n", "ascii");
const WARDROBE_PREFIXES = ["assets/pawn-pack/equipment/", "assets/pawn-pack/weapons/"];

async function writePack(name, entries, packIndex) {
  if (entries.length === 0) throw new Error(`pack ${name} would be empty`);
  const payloads = [];
  const indexEntries = [];
  let offset = 0;
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await readFile(entry.absolute);
    indexEntries.push({ path: entry.path, offset, bytes: bytes.byteLength, sha256: sha256(bytes) });
    payloads.push(bytes);
    packIndex[entry.path] = { pack: `packs/${name}`, offset, bytes: bytes.byteLength };
    offset += bytes.byteLength;
    await unlink(entry.absolute);
  }
  const indexJson = Buffer.from(JSON.stringify({ schema: "successor.assetpack.v1", entries: indexEntries }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(indexJson.byteLength, 0);
  const packPath = join(out, "packs", name);
  await mkdir(resolve(packPath, ".."), { recursive: true });
  await writeFile(packPath, Buffer.concat([PACK_MAGIC, header, indexJson, ...payloads]));
}

const { boot, audioCore } = await deriveBootClosure(repo);
const bootSet = new Set(boot);
const audioCoreSet = new Set(audioCore);
const distFiles = (await filesUnder(out))
  .map((absolute) => ({ absolute, path: relative(out, absolute).split(sep).join("/") }))
  .filter((file) => file.path !== "current.json");
for (const id of boot) {
  if (!distFiles.some((file) => file.path === id)) throw new Error(`boot asset missing from release tree: ${id}`);
}
const packIndex = {};

// ── Region packs (successor.region.v1 derivation) ──────────────────────────
// Prop models stream by streaming region: 8×8 map chunks = 128×128 cells.
// Membership comes from the canonical slice's prop placements resolved through
// the checked-in props mapping — the same inputs ConnectedScene consumes —
// never a hand list. Regions under the merge threshold fold into one sparse
// pack per area. The runtime never reads the map bundle; the slice cells are
// authoritative here.
const REGION_CELLS = 128;
const REGION_MERGE_BYTES = 256 * 1024;
const sliceDoc = JSON.parse(await readFile(join(out, "successor-slice/open-desert-slice.json"), "utf8"));
const mappingDoc = JSON.parse(await readFile(join(out, "render/props-mapping.json"), "utf8"));
const assetBase = String(mappingDoc.assetBase ?? "/assets/world-items/").replace(/^\//u, "");
const mappingEntries = mappingDoc.entries ?? {};
const propRegions = new Map(); // stable id -> { areaId, rx, ry }
const spawnRegions = new Map(); // areaId -> Set("rx,ry") of the player 3x3
{
  const slicePlayer = (sliceDoc.actors ?? []).find((actor) => actor.id === "player" || actor.actorId === "player");
  if (!slicePlayer?.cell) throw new Error("release: authored player spawn cell not found in slice");
  const spawnRegion = { rx: Math.floor(slicePlayer.cell.x / REGION_CELLS), ry: Math.floor(slicePlayer.cell.y / REGION_CELLS) };
  // Only the player's current region stages at boot / holds the travel
  // transition; the 3×3 neighborhood streams in right after via the watcher.
  const neighborhood = new Set([`${spawnRegion.rx}-${spawnRegion.ry}`]);
  spawnRegions.set(slicePlayer.areaId ?? "open-desert-overworld", neighborhood);
}
for (const prop of sliceDoc.props ?? []) {
  if (prop.visible === false) continue;
  const entry = mappingEntries[prop.assetKey] ?? mappingEntries[prop.kind];
  if (!entry || entry.skip === true || typeof entry.glb !== "string") continue;
  const stableId = entry.glb.startsWith("/") ? entry.glb.slice(1) : `${assetBase}${entry.glb}`;
  const areaId = prop.areaId ?? "open-desert-overworld";
  const rx = Math.floor((prop.cell?.x ?? 0) / REGION_CELLS);
  const ry = Math.floor((prop.cell?.y ?? 0) / REGION_CELLS);
  if (!propRegions.has(stableId)) propRegions.set(stableId, { areaId, rx, ry });
}
const regionOfFile = (path) => propRegions.get(path);

const bootPack = [];
const audioBoot = [];
const audioRest = [];
const worldRest = [];
const regionBuckets = new Map(); // "areaId/rx-ry" -> files
for (const file of distFiles) {
  if (audioCoreSet.has(file.path)) audioBoot.push(file);
  else if (bootSet.has(file.path)) bootPack.push(file);
  else if (file.path.startsWith("successor-audio/")) audioRest.push(file);
  else if (regionOfFile(file.path)) {
    const region = regionOfFile(file.path);
    const key = `${region.areaId}/${region.rx}-${region.ry}`;
    if (!regionBuckets.has(key)) regionBuckets.set(key, []);
    regionBuckets.get(key).push(file);
  }
  // Creature GLBs stay standalone: they stream individually on first AOI
  // appearance. Wardrobe stays standalone for on-demand streaming.
  else if (file.path.startsWith("assets/creatures/")) { /* standalone */ }
  else if (file.path.startsWith("assets/") && !WARDROBE_PREFIXES.some((prefix) => file.path.startsWith(prefix))) worldRest.push(file);
}
// Audio boots in a second burst: the visual scene never waits for sound.
await writePack("boot.spak", bootPack, packIndex);
await writePack("audio-boot.spak", audioBoot, packIndex);
await writePack("audio-rest.spak", audioRest, packIndex);
await writePack("world-rest.spak", worldRest, packIndex);
// Small regions merge into one sparse pack per area.
const sparseBuckets = new Map(); // areaId -> files
for (const [key, files] of [...regionBuckets.entries()].sort()) {
  let bytes = 0;
  for (const file of files) bytes += (await stat(file.absolute)).size;
  const areaId = key.split("/")[0];
  if (bytes < REGION_MERGE_BYTES) {
    if (!sparseBuckets.has(areaId)) sparseBuckets.set(areaId, []);
    sparseBuckets.get(areaId).push(...files);
    regionBuckets.delete(key);
  }
}
const bootPacks = [];
for (const [key, files] of [...regionBuckets.entries()].sort()) {
  const name = `region/${key}.spak`;
  await writePack(name, files, packIndex);
  const [areaId, region] = key.split("/");
  if (spawnRegions.get(areaId)?.has(region)) bootPacks.push(`packs/${name}`);
}
for (const [areaId, files] of [...sparseBuckets.entries()].sort()) {
  const name = `region/${areaId}/sparse.spak`;
  await writePack(name, files, packIndex);
  // A sparse pack covers the whole area's small regions; it stages at boot
  // whenever any of its regions neighbor the spawn.
  const covers = new Set(files.map((file) => {
    const region = regionOfFile(file.path);
    return `${region.rx}-${region.ry}`;
  }));
  if ([...covers].some((region) => spawnRegions.get(areaId)?.has(region))) bootPacks.push(`packs/${name}`);
}

const inventory = [];
for (const path of await filesUnder(out)) {
  if (path.endsWith("release-manifest.json") || path.endsWith("current.json")) continue;
  const bytes = await readFile(path);
  const name = relative(out, path).split(sep).join("/");
  inventory.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes), contentType: CONTENT_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream" });
}
const manifest = {
  schema: "successor.rust-web-release.v2",
  sourceCommit: options.source_commit,
  clientReleaseId: options.client_release_id,
  serverReleaseId: options.server_release_id,
  storefrontOrigin: options.storefront_origin,
  gameOrigin: options.game_origin,
  chatOrigin: options.chat_origin,
  files: inventory,
  boot,
  bootPacks,
  packIndex,
};
await writeFile(join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ out, files: inventory.length, boot: boot.length, packed: Object.keys(packIndex).length, bytes: inventory.reduce((sum, file) => sum + file.bytes, 0), manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))) }, null, 2));
