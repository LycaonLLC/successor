// SimPlayer soak world: materialize an isolated scratch shard, seed durable
// character records, and expose debug provisioning helpers. Mirrors
// tools/verification/scenario/runner.mjs (isolated persistent scratch process,
// rustLive bridge) so the soak runs against the same server-authoritative Rust
// sim the journey harnesses use — never a mock.
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createProcessHost } from "../lib/process-host.mjs";

const nodeBin = process.env.NODE_BIN ?? process.execPath;
const characterStoreSchema = "successor.character-store.v2";
const emptyMacrosPayload = { version: 1, items: [] };
const defaultAppearance = {
  skinTone: "#c78f62",
  hair: "hair_mop",
  hairMat: "hair_raven",
  face: null,
};

export function repoRootFrom(metaDir) {
  return path.resolve(metaDir, "../../..");
}

// Durable character ids must not also exist as authored slice actors. The shard
// materializes each SimPlayer from its character record at join time; only NPC
// fixture actors belong in the scratch slice overlay.
export async function writeSoakSlice({ baseSlicePath, outDir, tag, extraActors = [], extraInventory = [], extraSpawnZones = [] }) {
  const source = JSON.parse(await fs.readFile(baseSlicePath, "utf8"));
  const materialized = {
    ...source,
    stateHash: `${source.stateHash ?? "slice"}-simplayer-${tag}`,
    actors: [...(source.actors ?? []), ...extraActors],
    inventory: [...(source.inventory ?? []), ...extraInventory],
    spawnZones: [...(source.spawnZones ?? []), ...extraSpawnZones],
  };
  await fs.mkdir(outDir, { recursive: true });
  const slicePath = path.join(outDir, "soak-slice.json");
  await fs.writeFile(slicePath, `${JSON.stringify(materialized, null, 2)}\n`, "utf8");
  return { slicePath, stateHash: materialized.stateHash, actorCount: materialized.actors.length };
}

function starterProfessionState(initialProfessionId) {
  if (!initialProfessionId) return null;
  return {
    learned: [],
    trackXp: {},
    skillBoxes: [`${initialProfessionId}-novice`],
    activeTitleId: null,
    credits: 5_000,
    skillPointCap: 250,
  };
}

export async function writeCharacterStore({ bodies, outDir }) {
  await fs.mkdir(outDir, { recursive: true });
  const now = new Date().toISOString();
  const characters = bodies.map((body) => {
    const worn = body.worn ?? [];
    const professions = body.professions ?? starterProfessionState(body.initialProfessionId);
    return {
      id: body.id,
      ownerRef: "local",
      name: body.name,
      appearance: {
        ...defaultAppearance,
        ...(body.appearance ?? {}),
        face: body.appearance?.face ?? null,
      },
      worn,
      wornColors: body.wornColors
        ?? Object.fromEntries(worn.map((entry) => [entry.item, [...(entry.colors ?? [])]])),
      position: { areaId: body.areaId, x: body.x, y: body.y, facing: body.facing ?? "right" },
      vitals: body.vitals ?? { health: 280, action: 160, spirit: 100 },
      initialProfessionId: body.initialProfessionId ?? null,
      professions,
      activeTitleId: professions?.activeTitleId ?? null,
      careerGoalId: professions?.careerGoalId ?? null,
      recordKinds: { "successor.macros.v1": emptyMacrosPayload },
      worldEntryClaimed: false,
      createdAt: now,
      lastSeenAt: now,
      lastLogoutAt: null,
      totalPlayMs: 0,
    };
  });
  const storePath = path.join(outDir, "characters.json");
  await fs.writeFile(storePath, `${JSON.stringify({ schema: characterStoreSchema, characters }, null, 2)}\n`, "utf8");
  return { storePath, characters };
}

export async function spawnShard({ repoRoot, port, slicePath, characterStorePath, shardId, tag, moveTrace }) {
  const serverRoot = path.join(repoRoot, "server");
  const rustBridgeBin = path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server");
  const unit = `successor-simplayer-${port}-${tag}`;
  const processHost = createProcessHost({ runId: unit, runDir: path.dirname(slicePath) });
  const stateDir = path.join(path.dirname(characterStorePath), "game-state");
  const env = {
    PORT: String(port),
    HOST: "127.0.0.1",
    LOG_LEVEL: process.env.SUCCESSOR_SIMPLAYER_LOG_LEVEL ?? "silent",
    GAME_SHARD_ID: shardId,
    GAME_SHARD_PERSISTENCE: "1",
    GAME_SHARD_STATE_DIR: stateDir,
    GAME_SHARD_CHECKPOINT_PATH: path.join(stateDir, `${shardId}.checkpoint.json`),
    GAME_SHARD_JOURNAL_PATH: path.join(stateDir, `${shardId}.journal.jsonl`),
    GAME_DEBUG_AUTHORITY_COMMANDS: "1",
    GAME_CHARACTER_STORE_PATH: characterStorePath,
    GAME_SLICE_PATH: slicePath,
    GAME_RUST_AUTHORITY_BRIDGE_BIN: rustBridgeBin,
    GAME_MOVE_TRACE: moveTrace ? "1" : "0",
  };
  const handle = await processHost.start({
    name: unit,
    argv: [nodeBin, path.join(serverRoot, "dist", "index.js")],
    env,
    cwd: serverRoot,
  });
  const gameUrl = `http://127.0.0.1:${port}`;
  let status;
  try {
    status = await waitForStatus(gameUrl, 25_000);
  } catch (error) {
    const log = await processHost.logs(handle).catch(() => "");
    await processHost.stop(handle, { graceMs: 30_000 }).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${log.trim() ? `\n${log.slice(-4000)}` : ""}`);
  }
  return {
    handle,
    processHost,
    unit,
    unitService: handle.unit ?? handle.name,
    port,
    gameUrl,
    status,
    resourceSnapshot: () => processHost.inspect(handle),
    async errorLogLines(sinceIso, limit = 120) {
      const text = await processHost.logs(handle, { since: sinceIso, priority: "err..alert", output: "short-iso" });
      return text.trim().split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line && line !== "-- No entries --")
        .slice(-limit);
    },
    stop: (options = {}) => processHost.stop(handle, { ...options, graceMs: options.graceMs ?? 30_000 }),
  };
}


export async function enterCharacter(gameUrl, id) {
  const entered = await postJson(`${gameUrl}/game/characters/${encodeURIComponent(id)}/enter`, {});
  if (!entered?.ok || !entered.join) throw new Error(`enter failed for ${id}: ${JSON.stringify(entered)}`);
  return entered.join;
}

// Provisioning is out-of-band setup (a test loadout / starting stock), NOT part
// of the human-plausible transcript. Kept in a labelled "provision" phase.
export async function restockLoadout(gameUrl, actorId) {
  return postJson(`${gameUrl}/game/debug/restock-loadout`, { actorId });
}

export async function debugGive(gameUrl, actorId, { itemId, variantId = 0, quantity = 1, equip = false }) {
  return postJson(`${gameUrl}/game/debug/authority-command`, {
    actorId,
    command: { DebugGiveItem: { item_id: itemId, variant_id: variantId, quantity, equip } },
  });
}

export function fetchJson(url, init = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method ?? "GET", timeout: init.timeout ?? 4_000, headers: init.headers ?? {} }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new Error(`HTTP ${response.statusCode} ${url}: ${body.slice(0, 300)}`));
          return;
        }
        try { resolve(body ? JSON.parse(body) : null); } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    if (init.body) request.end(init.body); else request.end();
  });
}

export function postJson(url, payload) {
  const body = JSON.stringify(payload ?? {});
  return fetchJson(url, { method: "POST", body, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
}

export function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function waitForStatus(gameUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await fetchJson(`${gameUrl}/game/status`).catch(() => null);
    if (latest?.shardId) return latest;
    await delay(120);
  }
  throw new Error(`timed out waiting for shard on ${gameUrl}; latest=${JSON.stringify(latest)}`);
}


export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
