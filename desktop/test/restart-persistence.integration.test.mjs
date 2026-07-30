import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  desktopCheckpointProjectionStateHash,
  desktopShardPersistenceConfig,
  startGameServer,
  stopGameServer,
} from "../src/server-runtime.mjs";

const CREDIT_CHIP_ITEM_ID = 9_002;

async function json(port, route, options) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${route}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function checkpointStacks(checkpointPath) {
  const root = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  const stacks = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (
      (value.item_id === CREDIT_CHIP_ITEM_ID || value.itemId === CREDIT_CHIP_ITEM_ID)
      && Number.isInteger(value.quantity)
    ) {
      stacks.push(value.quantity);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  return stacks;
}

function oracleStacks(oracle) {
  return (oracle.inventory ?? [])
    .filter((row) => row.itemId === CREDIT_CHIP_ITEM_ID)
    .map((row) => row.quantity);
}

test("desktop child checkpoint survives two clean process restarts without duplication", { timeout: 120_000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-restart-"));
  const persistence = desktopShardPersistenceConfig({ stateDir, shardId: "desktop-open-desert" });
  fs.writeFileSync(persistence.characterStorePath, `${JSON.stringify({
    schema: "successor.character-store.v2",
    characters: [],
  }, null, 2)}\n`, "utf8");
  const originalDebug = process.env.SUCCESSOR_DESKTOP_SERVER_DEBUG;
  process.env.SUCCESSOR_DESKTOP_SERVER_DEBUG = "1";
  let runtime;
  try {
    runtime = await startGameServer({ stateDir, requestedPort: 18492, shardId: "desktop-open-desert" });
    const oracle = await json(runtime.port, "/game/debug/oracle");
    const actorId = Object.keys(oracle.actors ?? {})[0];
    assert.ok(actorId, "fixture must expose an authority actor");
    const granted = await json(runtime.port, "/game/debug/authority-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorId,
        command: {
          DebugGiveItem: { item_id: CREDIT_CHIP_ITEM_ID, variant_id: 0, quantity: 37 },
        },
      }),
    });
    assert.equal(granted.receipt.accepted, true);
    assert.deepEqual(oracleStacks(await json(runtime.port, "/game/debug/oracle")), [37]);
    await stopGameServer();
    assert.deepEqual(checkpointStacks(runtime.checkpointPath), [37]);

    runtime = await startGameServer({ stateDir, requestedPort: 18492, shardId: "desktop-open-desert" });
    assert.deepEqual(oracleStacks(await json(runtime.port, "/game/debug/oracle")), [37]);
    await stopGameServer();
    assert.deepEqual(checkpointStacks(runtime.checkpointPath), [37]);

    runtime = await startGameServer({ stateDir, requestedPort: 18492, shardId: "desktop-open-desert" });
    assert.deepEqual(oracleStacks(await json(runtime.port, "/game/debug/oracle")), [37]);
    await stopGameServer();
    assert.deepEqual(checkpointStacks(runtime.checkpointPath), [37]);
  } finally {
    await stopGameServer();
    if (originalDebug === undefined) delete process.env.SUCCESSOR_DESKTOP_SERVER_DEBUG;
    else process.env.SUCCESSOR_DESKTOP_SERVER_DEBUG = originalDebug;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("desktop refuses an incompatible checkpoint before spawning and retains it byte-for-byte", { timeout: 120_000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-incompatible-"));
  const persistence = desktopShardPersistenceConfig({ stateDir, shardId: "desktop-open-desert" });
  const checkpoint = {
    schema: "successor.game-shard-checkpoint.v1",
    shardId: "desktop-open-desert",
    sliceHash: "0".repeat(64),
    sourceStateHash: "incompatible-authored-world",
    tick: 0,
    tickRateHz: 20,
    nextCombatEventId: 1,
    nextBotSeq: 1,
    counters: {},
    actors: [],
    propStates: {},
    travelTickets: [],
  };
  const checkpointRaw = `${JSON.stringify({
    ...checkpoint,
    projectionStateHash: desktopCheckpointProjectionStateHash(checkpoint),
  }, null, 2)}\n`;
  const characterStoreRaw = `${JSON.stringify({
    schema: "successor.character-store.v2",
    characters: [],
  }, null, 2)}\n`;
  const events = [];
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(persistence.characterStorePath, characterStoreRaw, "utf8");
  fs.writeFileSync(persistence.checkpointPath, checkpointRaw, "utf8");
  fs.writeFileSync(persistence.journalPath, '{"type":"checkpoint"}\n', "utf8");

  try {
    await assert.rejects(
      startGameServer({
        stateDir,
        requestedPort: 18493,
        shardId: "desktop-open-desert",
        log: (event, details) => events.push({ event, details }),
      }),
      /source_state_hash_mismatch.*checkpoint was retained/iu,
    );
    assert.equal(fs.readFileSync(persistence.checkpointPath, "utf8"), checkpointRaw);
    assert.equal(fs.readFileSync(persistence.characterStorePath, "utf8"), characterStoreRaw);
    assert.equal(events.some(({ event }) => event === "game-server-spawn"), false);
  } finally {
    await stopGameServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
