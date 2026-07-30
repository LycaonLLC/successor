import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSuccessorHeadlessHost } from "@successor/client/headless";

import { startGameServer, stopGameServer } from "../src/server-runtime.mjs";

const creatureInventory = [
  { itemId: 2101, variantId: 313_282, quantity: 10 },
  { itemId: 2102, variantId: 329_003, quantity: 94 },
  { itemId: 2103, variantId: 330_008, quantity: 10 },
];

async function json(port, route, options) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${route}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function createCharacter(port, name, initialProfessionId) {
  return json(port, "/game/characters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      appearance: { skinTone: "#a8795d", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
      initialProfessionId,
    }),
  });
}

async function authorityCommand(port, actorId, command) {
  const result = await json(port, "/game/debug/authority-command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId, command }),
  });
  assert.equal(result.receipt.accepted, true, JSON.stringify(result.receipt));
  return result;
}

async function connectCharacter(runtime, character) {
  const host = await createSuccessorHeadlessHost({
    endpoint: `http://127.0.0.1:${runtime.port}`,
    slicePath: runtime.slicePath,
    playerId: character.ownerRef,
    actorId: character.id,
    characterId: character.id,
    displayName: character.name,
    readyTimeoutMs: 20_000,
  });
  await host.start();
  return host;
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function ownedCreatureRows(host, characterId) {
  return host.state.inventory
    .filter((row) => row.container.startsWith(`${characterId}:`) && creatureInventory.some((item) => item.itemId === row.itemId))
    .map(({ container, itemId, variantId, quantity, reserved, available }) => ({
      container,
      itemId,
      variantId,
      quantity,
      reserved,
      available,
    }))
    .sort((left, right) => left.itemId - right.itemId);
}

function expectedOwnedRows(characterId) {
  return creatureInventory.map(({ itemId, variantId, quantity }) => ({
    container: `${characterId}:field-pack`,
    itemId,
    variantId,
    quantity,
    reserved: 0,
    available: quantity,
  }));
}

function assertPeerIsolation(host, ownerId, peerId) {
  // Authored fixture state and both durable character namespaces stay private.
  assert.deepEqual(ownedCreatureRows(host, "player"), []);
  assert.deepEqual(ownedCreatureRows(host, ownerId), []);
  assert.deepEqual(ownedCreatureRows(host, peerId), []);
}

function actorProgression(host, characterId) {
  const actor = host.state.serverAuthority.actors[characterId];
  assert.ok(actor, `authority actor missing for ${characterId}`);
  return structuredClone({
    professions: actor.professions,
    activeTitle: actor.activeTitle,
    credits: actor.credits,
    vitals: actor.vitals,
  });
}

function rustActorState(state, rustActorId) {
  const actor = state.actors[rustActorId];
  assert.ok(actor, `Rust actor missing for ${rustActorId}`);
  return structuredClone({
    professions: actor.professions,
    credits: actor.credits,
    vitals: actor.vitals,
  });
}

function rustCheckpointState(checkpointPath) {
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  assert.equal(checkpoint.rustAuthority?.state?.schema, "authority.checkpoint.v1");
  return { checkpoint, state: checkpoint.rustAuthority.state.state };
}

test("durable character inventory and learned profession progression remain exact across desktop process restart", { timeout: 120_000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-character-inventory-"));
  const originalDebug = process.env.SUCCESSOR_DESKTOP_SERVER_DEBUG;
  process.env.SUCCESSOR_DESKTOP_SERVER_DEBUG = "1";
  // This test owns a fresh current-schema durable roster.
  fs.writeFileSync(path.join(stateDir, "characters.json"), `${JSON.stringify({
    schema: "successor.character-store.v2",
    characters: [],
  }, null, 2)}\n`, { mode: 0o600 });
  let runtime;
  let ownerHost;
  let peerHost;
  let owner;
  let peer;

  try {
    runtime = await startGameServer({ stateDir, requestedPort: 18494, shardId: "desktop-open-desert" });
    owner = await createCharacter(runtime.port, "InventoryOwner", "scout");
    ownerHost = await connectCharacter(runtime, owner);

    const durableRoster = JSON.parse(fs.readFileSync(runtime.characterStorePath, "utf8"));
    assert.equal(durableRoster.characters.find((record) => record.id === owner.id)?.worldEntryClaimed, true);

    for (const item of creatureInventory) {
      await authorityCommand(runtime.port, owner.id, {
        DebugGiveItem: {
          item_id: item.itemId,
          variant_id: item.variantId,
          quantity: item.quantity,
        },
      });
    }

    const learnedNoviceBoxes = [
      "brawler-novice",
      "craftsman-novice",
      "marksman-novice",
      "medic-novice",
      "scout-novice",
    ];
    await authorityCommand(runtime.port, owner.id, {
      DebugGrantSkillBoxes: { skill_box_ids: learnedNoviceBoxes },
    });
    await authorityCommand(runtime.port, owner.id, {
      SetProfessionTitle: { title_id: "craftsman-novice" },
    });

    await waitFor(
      () => ownedCreatureRows(ownerHost, owner.id).length === creatureInventory.length,
      "owner never received all creature inventory rows",
    );
    assert.deepEqual(ownedCreatureRows(ownerHost, owner.id), expectedOwnedRows(owner.id));
    const firstProgression = await waitFor(() => {
      const progression = actorProgression(ownerHost, owner.id);
      const boxes = progression.professions.flatMap((profession) => profession.skillBoxes).sort();
      return boxes.join(",") === learnedNoviceBoxes.join(",")
        && progression.activeTitle?.id === "craftsman-novice"
        ? progression
        : null;
    }, "owner never received exact learned novice progression");


    peer = await createCharacter(runtime.port, "InventoryPeer", "medic");
    peerHost = await connectCharacter(runtime, peer);
    assertPeerIsolation(peerHost, owner.id, peer.id);

    await peerHost.close();
    peerHost = undefined;
    await ownerHost.close();
    ownerHost = undefined;
    await stopGameServer();
    const savedOwner = JSON.parse(fs.readFileSync(runtime.characterStorePath, "utf8"))
      .characters.find((record) => record.id === owner.id);
    assert.deepEqual(savedOwner.professions.map((profession) => profession.id).sort(), ["brawler", "craftsman", "marksman", "medic", "scout"]);
    assert.deepEqual(savedOwner.professions.flatMap((profession) => profession.skillBoxes).sort(), learnedNoviceBoxes);
    assert.equal(savedOwner.activeTitleId, "craftsman-novice");

    const firstSave = rustCheckpointState(runtime.checkpointPath);
    assert.equal(firstSave.checkpoint.authoredPlaceholderOwners?.player, undefined);
    assert.deepEqual(
      firstSave.state.inventory
        .filter((row) => row.container.startsWith(`${owner.id}:`) && creatureInventory.some((item) => item.itemId === row.itemId))
        .map(({ container, itemId, variantId, quantity, reserved, available }) => ({ container, itemId, variantId, quantity, reserved, available }))
        .sort((left, right) => left.itemId - right.itemId),
      expectedOwnedRows(owner.id),
    );
    const firstRustActorState = rustActorState(firstSave.state, owner.id);
    assert.deepEqual(firstRustActorState.professions.skill_boxes.slice().sort(), learnedNoviceBoxes);
    assert.equal(firstRustActorState.professions.active_title_id, "craftsman-novice");

    runtime = await startGameServer({ stateDir, requestedPort: 18494, shardId: "desktop-open-desert" });
    peerHost = await connectCharacter(runtime, peer);
    assertPeerIsolation(peerHost, owner.id, peer.id);
    ownerHost = await connectCharacter(runtime, owner);
    await waitFor(
      () => ownedCreatureRows(ownerHost, owner.id).length === creatureInventory.length,
      "owner inventory did not return after desktop restart",
    );
    assert.deepEqual(ownedCreatureRows(ownerHost, owner.id), expectedOwnedRows(owner.id));
    assertPeerIsolation(peerHost, owner.id, peer.id);
    assert.deepEqual(actorProgression(ownerHost, owner.id), firstProgression);

    await peerHost.close();
    peerHost = undefined;
    await ownerHost.close();
    ownerHost = undefined;
    await stopGameServer();
    const secondSave = rustCheckpointState(runtime.checkpointPath);
    assert.deepEqual(
      secondSave.state.inventory
        .filter((row) => row.container.startsWith(`${owner.id}:`) && creatureInventory.some((item) => item.itemId === row.itemId))
        .map(({ container, itemId, variantId, quantity, reserved, available }) => ({ container, itemId, variantId, quantity, reserved, available }))
        .sort((left, right) => left.itemId - right.itemId),
      expectedOwnedRows(owner.id),
    );
    assert.deepEqual(rustActorState(secondSave.state, owner.id), firstRustActorState);
  } finally {
    await peerHost?.close().catch(() => undefined);
    await ownerHost?.close().catch(() => undefined);
    await stopGameServer().catch(() => undefined);
    if (originalDebug === undefined) delete process.env.SUCCESSOR_DESKTOP_SERVER_DEBUG;
    else process.env.SUCCESSOR_DESKTOP_SERVER_DEBUG = originalDebug;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
