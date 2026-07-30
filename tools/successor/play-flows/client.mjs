import { existsSync } from "node:fs";
import path from "node:path";

import { startSuccessorDriverBot } from "../../driver-protocol/successor-driver-bot.mjs";

export const playFlowSchemas = {
  run: "successor.play-flow.run.v1",
  step: "successor.play-flow.step.v1",
};

export const defaultCharacterAppearance = {
  skinTone: "#c78f62",
  hair: "hair_mop",
  hairMat: "hair_raven",
};

const starterProfessionIds = new Set(["marksman", "scout", "craftsman", "medic", "brawler"]);

export function gameUrlFromOptions(options) {
  if (options.gameUrl) return stripTrailingSlash(options.gameUrl);
  const port = options.port ?? process.env.OPEN_DESERT_PORT ?? process.env.GAME_AUTHORITY_SERVER_PORT ?? "28093";
  return `http://127.0.0.1:${port}`;
}

export function defaultSlicePath(repoRoot = path.resolve(import.meta.dirname, "../../..")) {
  return path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
}

export function defaultCliPath(repoRoot = path.resolve(import.meta.dirname, "../../..")) {
  return path.join(repoRoot, "client", "dist", "headless", "cli.js");
}

export async function resolveCharacterForPlay(options) {
  const gameUrl = gameUrlFromOptions(options);
  const nameOrId = String(options.as ?? "").trim();
  if (!nameOrId) throw new Error("--as requires a character name or id");

  const roster = await fetchJson(`${gameUrl}/game/characters`);
  const characters = Array.isArray(roster.characters) ? roster.characters : [];
  let character = characters.find((candidate) => sameCharacter(candidate, nameOrId)) ?? null;
  let created = false;

  if (!character) {
    if (options.create === false) throw new Error(`character ${nameOrId} not found on ${gameUrl}`);
    const initialProfessionId = String(options.profession ?? options.initialProfessionId ?? "").trim().toLowerCase();
    if (!starterProfessionIds.has(initialProfessionId)) {
      throw new Error("--profession must be marksman, scout, craftsman, medic, or brawler when creating a character");
    }
    character = await createCharacter(
      gameUrl,
      nameOrId,
      options.appearance ?? defaultCharacterAppearance,
      initialProfessionId,
    );
    created = true;
  }

  const entered = await postJson(`${gameUrl}/game/characters/${encodeURIComponent(character.id)}/enter`, {});
  if (!entered?.ok || !entered.join) throw new Error(`character enter failed for ${character.id}: ${JSON.stringify(entered)}`);
  return {
    gameUrl,
    created,
    character,
    join: entered.join,
    rosterServer: roster.server ?? null,
  };
}

export function startPlayFlowDriver(options) {
  const repoRoot = options.repoRoot ?? path.resolve(import.meta.dirname, "../../..");
  const cliPath = options.cliPath ?? defaultCliPath(repoRoot);
  if (!existsSync(cliPath)) {
    throw new Error(`headless driver not built at ${cliPath}; run pnpm --dir client build:headless`);
  }
  const join = options.join ?? {};
  const character = options.character ?? {};
  const actorId = join.actorId ?? character.id ?? options.actorId;
  const displayName = join.name ?? character.name ?? options.displayName ?? actorId;
  if (!actorId) throw new Error("driver actor id is required");

  return startSuccessorDriverBot({
    cliPath,
    gameUrl: options.gameUrl,
    slicePath: options.slicePath ?? defaultSlicePath(repoRoot),
    actorId,
    playerId: join.player ?? character.ownerRef ?? actorId,
    displayName,
    characterId: character.id,
    spawnArea: options.spawnArea ?? join.spawnArea,
    spawnX: options.spawnX ?? join.spawnX,
    spawnY: options.spawnY ?? join.spawnY,
    facing: options.facing ?? join.facing,
    env: options.env,
  });
}

export async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { accept: "application/json", ...(init.headers ?? {}) } });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? JSON.stringify(payload) : text;
    throw new Error(`HTTP ${response.status} ${url}: ${detail}`);
  }
  return payload;
}

export async function postJson(url, payload) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

async function createCharacter(gameUrl, name, appearance, initialProfessionId) {
  const created = await postJson(`${gameUrl}/game/characters`, { name, appearance, initialProfessionId });
  if (!created?.id) throw new Error(`character create returned no id: ${JSON.stringify(created)}`);
  return created;
}

function sameCharacter(candidate, nameOrId) {
  if (!candidate || typeof candidate !== "object") return false;
  const needle = nameOrId.toLowerCase();
  return String(candidate.id ?? "").toLowerCase() === needle
    || String(candidate.name ?? "").toLowerCase() === needle;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}
