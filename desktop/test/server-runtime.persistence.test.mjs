import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import path from "node:path";

import {
  acquireDesktopStateLock,
  assertDurableCheckpointCompatible,
  desktopCheckpointCompatibility,
  desktopCheckpointProjectionStateHash,
  desktopCheckpointRestoreCanStart,
  desktopServerStopGraceMs,
  desktopServerEnvironment,
  desktopShardPersistenceConfig,
  ensureDesktopCharacterStore,
  releaseDesktopStateLock,
  stopDesktopServerSupervisor,
} from "../src/server-runtime.mjs";

test("desktop startup requires restore status to agree with checkpoint preflight", () => {
  assert.equal(
    desktopCheckpointRestoreCanStart({ loaded: true, reason: "loaded" }, { checkpointExpected: true }),
    true,
  );
  assert.equal(
    desktopCheckpointRestoreCanStart({ loaded: false, reason: "missing" }, { checkpointExpected: false }),
    true,
  );

  for (const restore of [
    undefined,
    null,
    [],
    {},
    { loaded: false, reason: "disabled" },
    { loaded: false, reason: "missing" },
    { loaded: false, reason: "rust_restore_pending" },
    { loaded: false, reason: "slice_hash_mismatch" },
    { loaded: false, reason: "source_state_hash_mismatch" },
    { loaded: false, reason: "checkpoint_corrupt" },
    { loaded: true, reason: "disabled" },
    { loaded: true, error: "restore was not actually clean" },
  ]) {
    assert.equal(desktopCheckpointRestoreCanStart(restore, { checkpointExpected: true }), false, JSON.stringify(restore));
  }
  for (const restore of [
    undefined,
    null,
    [],
    {},
    { loaded: true, reason: "loaded" },
    { loaded: false, reason: "disabled" },
    { loaded: false, reason: "rust_restore_pending" },
  ]) {
    assert.equal(desktopCheckpointRestoreCanStart(restore, { checkpointExpected: false }), false, JSON.stringify(restore));
  }
  assert.equal(desktopCheckpointRestoreCanStart({ loaded: true, reason: "loaded" }), false);
});

test("desktop checkpoint guard accepts an exact raw slice match without a semantic hash", () => {
  const sliceRaw = fixtureSlice("source-v1");
  const result = desktopCheckpointCompatibility({
    checkpointRaw: fixtureCheckpoint({ sliceHash: sha256(sliceRaw), sourceStateHash: "" }),
    sliceRaw,
    shardId: "desktop-open-desert",
  });

  assert.equal(result.compatible, true);
  assert.equal(result.reason, "slice_hash_match");
});

test("desktop checkpoint guard rejects changed raw bytes even with the same descriptive source hash", () => {
  const originalSliceRaw = fixtureSlice("source-v1");
  const regeneratedSliceRaw = `${fixtureSlice("source-v1", { label: "regenerated formatting" })}\n`;
  const result = desktopCheckpointCompatibility({
    checkpointRaw: fixtureCheckpoint({
      sliceHash: sha256(originalSliceRaw),
      sourceStateHash: "source-v1",
    }),
    sliceRaw: regeneratedSliceRaw,
    shardId: "desktop-open-desert",
  });

  assert.equal(result.compatible, false);
  assert.equal(result.reason, "slice_hash_mismatch");
});

test("desktop checkpoint guard rejects a changed semantic source hash", () => {
  const result = desktopCheckpointCompatibility({
    checkpointRaw: fixtureCheckpoint({
      sliceHash: sha256(fixtureSlice("source-v1")),
      sourceStateHash: "source-v1",
    }),
    sliceRaw: fixtureSlice("source-v2"),
    shardId: "desktop-open-desert",
  });

  assert.equal(result.compatible, false);
  assert.equal(result.reason, "source_state_hash_mismatch");
});

test("desktop checkpoint guard rejects a legacy raw mismatch without a semantic hash", () => {
  const result = desktopCheckpointCompatibility({
    checkpointRaw: fixtureCheckpoint({ sliceHash: sha256(fixtureSlice("source-v1")) }),
    sliceRaw: fixtureSlice("source-v1", { label: "changed authored row" }),
    shardId: "desktop-open-desert",
  });

  assert.equal(result.compatible, false);
  assert.equal(result.reason, "slice_hash_mismatch");
});

test("desktop checkpoint guard rejects corrupt or schema-incompatible checkpoints", () => {
  const sliceRaw = fixtureSlice("source-v1");
  assert.deepEqual(
    desktopCheckpointCompatibility({ checkpointRaw: "{", sliceRaw, shardId: "desktop-open-desert" }),
    { compatible: false, reason: "invalid_json" },
  );
  assert.deepEqual(
    desktopCheckpointCompatibility({
      checkpointRaw: fixtureCheckpoint({ sliceHash: sha256(sliceRaw), schema: "successor.game-shard-checkpoint.v0" }),
      sliceRaw,
      shardId: "desktop-open-desert",
    }),
    { compatible: false, reason: "schema_mismatch" },
  );
});

test("desktop checkpoint guard rejects a tampered durable projection", () => {
  const sliceRaw = fixtureSlice("source-v1");
  const checkpoint = JSON.parse(fixtureCheckpoint({ sliceHash: sha256(sliceRaw) }));
  checkpoint.authoredPlaceholderOwners = { player: "char-injected" };
  const result = desktopCheckpointCompatibility({
    checkpointRaw: JSON.stringify(checkpoint),
    sliceRaw,
    shardId: "desktop-open-desert",
  });

  assert.equal(result.compatible, false);
  assert.equal(result.reason, "projection_state_hash_mismatch");
});

test("desktop graceful-stop ceiling exceeds the Rust checkpoint export budget", () => {
  // Close may need to await one bounded Rust export and then publish the
  // forced final export, each with a ten-second authority timeout.
  assert.ok(desktopServerStopGraceMs >= 25_000);
});

test("desktop checkpoint guard rejects a checkpoint for another shard", () => {
  const sliceRaw = fixtureSlice("source-v1");
  const result = desktopCheckpointCompatibility({
    checkpointRaw: fixtureCheckpoint({ sliceHash: sha256(sliceRaw), shardId: "other-shard" }),
    sliceRaw,
    shardId: "desktop-open-desert",
  });

  assert.equal(result.compatible, false);
  assert.equal(result.reason, "shard_mismatch");
});

test("desktop shard persistence contract is stable for the same durable state directory", () => {
  const first = desktopShardPersistenceConfig({ stateDir: "/tmp/successor-desktop-state" });
  const second = desktopShardPersistenceConfig({ stateDir: "/tmp/successor-desktop-state" });

  assert.deepEqual(second, first);
  assert.equal(first.shardId, "desktop-open-desert");
  assert.equal(first.stateDir, path.resolve("/tmp/successor-desktop-state"));
  assert.equal(first.checkpointPath, path.join(first.stateDir, "desktop-open-desert.checkpoint.json"));
  assert.equal(first.journalPath, path.join(first.stateDir, "desktop-open-desert.journal.jsonl"));
  assert.equal(first.characterStorePath, path.join(first.stateDir, "characters.json"));
  assert.equal(first.stateLockPath, path.join(first.stateDir, ".desktop-state.lock"));
});

test("desktop missing-checkpoint preflight sees durable entered characters and nonempty journals", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-missing-checkpoint-guard-"));
  const checkpointPath = path.join(tempDir, "game-state", "desktop-open-desert.checkpoint.json");
  const journalPath = path.join(tempDir, "game-state", "desktop-open-desert.journal.jsonl");
  const characterStorePath = path.join(tempDir, "game-state", "characters.json");
  const slicePath = path.join(tempDir, "open-desert-slice.json");
  try {
    fs.mkdirSync(path.dirname(characterStorePath), { recursive: true });
    fs.writeFileSync(characterStorePath, fixtureCharacterStore(["char_legacy_entered"]), "utf8");
    fs.writeFileSync(slicePath, fixtureSlice("source-v1"), "utf8");

    assert.throws(
      () => assertDurableCheckpointCompatible({
        checkpointPath,
        journalPath,
        characterStorePath,
        slicePath,
        shardId: "desktop-open-desert",
      }),
      /checkpoint is missing.*1 durable character.*explicit recovery or reset/iu,
    );

    fs.writeFileSync(characterStorePath, fixtureCharacterStore(["char_fresh"], { worldEntryClaimed: false }), "utf8");
    assert.deepEqual(assertDurableCheckpointCompatible({
      checkpointPath,
      journalPath,
      characterStorePath,
      slicePath,
      shardId: "desktop-open-desert",
    }), { checkpointExpected: false });

    fs.writeFileSync(journalPath, '{"type":"command.receipt"}\n', "utf8");
    assert.throws(
      () => assertDurableCheckpointCompatible({
        checkpointPath,
        journalPath,
        characterStorePath,
        slicePath,
        shardId: "desktop-open-desert",
      }),
      /checkpoint is missing.*configured journal contains.*explicit recovery or reset/iu,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop preflight requires a nonempty configured journal beside a checkpoint", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-checkpoint-journal-guard-"));
  const checkpointPath = path.join(tempDir, "desktop-open-desert.checkpoint.json");
  const journalPath = path.join(tempDir, "desktop-open-desert.journal.jsonl");
  const characterStorePath = path.join(tempDir, "characters.json");
  const slicePath = path.join(tempDir, "open-desert-slice.json");
  const sliceRaw = fixtureSlice("source-v1");
  try {
    fs.writeFileSync(slicePath, sliceRaw, "utf8");
    fs.writeFileSync(checkpointPath, fixtureCheckpoint({ sliceHash: sha256(sliceRaw) }), "utf8");
    fs.writeFileSync(characterStorePath, fixtureCharacterStore([], { worldEntryClaimed: false }), "utf8");

    for (const journalState of ["missing", "empty", "whitespace"]) {
      fs.rmSync(journalPath, { force: true });
      if (journalState !== "missing") {
        fs.writeFileSync(journalPath, journalState === "whitespace" ? "\n  \n" : "", "utf8");
      }
      assert.throws(
        () => assertDurableCheckpointCompatible({
          checkpointPath,
          journalPath,
          characterStorePath,
          slicePath,
          shardId: "desktop-open-desert",
        }),
        /journal_missing_or_empty.*checkpoint was retained/iu,
      );
    }

    fs.writeFileSync(journalPath, '{"type":"checkpoint.commit"}\n', "utf8");
    fs.rmSync(characterStorePath);
    assert.throws(
      () => assertDurableCheckpointCompatible({
        checkpointPath,
        journalPath,
        characterStorePath,
        slicePath,
        shardId: "desktop-open-desert",
      }),
      /character_store_missing.*checkpoint was retained/iu,
    );

    fs.writeFileSync(characterStorePath, fixtureCharacterStore([], { worldEntryClaimed: false }), "utf8");
    const explicitNoJournal = assertDurableCheckpointCompatible({
      checkpointPath,
      characterStorePath,
      slicePath,
      shardId: "desktop-open-desert",
    });
    assert.equal(explicitNoJournal.checkpointExpected, true);
    assert.equal(explicitNoJournal.compatibility.compatible, true);
    assert.equal(explicitNoJournal.compatibility.reason, "slice_hash_match");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop character store initializes only a current empty durable roster", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-character-store-"));
  const durablePath = path.join(tempDir, "app-data", "game-state", "characters.json");
  try {
    assert.deepEqual(ensureDesktopCharacterStore({ durablePath }), {
      initialized: true,
      reason: "fresh_store_initialized",
      characterCount: 0,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(durablePath, "utf8")).characters, []);
    assert.deepEqual(initializationTemps(path.dirname(durablePath)), []);

    fs.writeFileSync(durablePath, fixtureCharacterStore(["current"]), "utf8");
    assert.deepEqual(ensureDesktopCharacterStore({ durablePath }), {
      initialized: false,
      reason: "durable_exists",
      characterCount: 1,
    });
    assert.equal(JSON.parse(fs.readFileSync(durablePath, "utf8")).characters[0].id, "current");
    assert.deepEqual(initializationTemps(path.dirname(durablePath)), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop character store rejects noncanonical durable identity fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-character-store-invalid-identity-"));
  const durablePath = path.join(tempDir, "game-state", "characters.json");
  try {
    fs.mkdirSync(path.dirname(durablePath), { recursive: true });
    for (const candidate of [
      { id: " char_inventory_owner", ownerRef: "local", name: "Atlas", worldEntryClaimed: true },
      { id: "Char_Inventory_Owner", ownerRef: "local", name: "Atlas", worldEntryClaimed: true },
      { id: "char:inventory", ownerRef: "local", name: "Atlas", worldEntryClaimed: true },
      { id: `char_${"x".repeat(60)}`, ownerRef: "local", name: "Atlas", worldEntryClaimed: true },
      { id: "char_inventory_owner", ownerRef: "bad owner", name: "Atlas", worldEntryClaimed: true },
      { id: "char_inventory_owner", ownerRef: "local", name: "Atlas", worldEntryClaimed: "yes" },
    ]) {
      const raw = `${JSON.stringify({ schema: "successor.character-store.v2", characters: [candidate] }, null, 2)}\n`;
      fs.writeFileSync(durablePath, raw, "utf8");
      assert.throws(
        () => ensureDesktopCharacterStore({ durablePath }),
        /Invalid durable Successor character store.*malformed record at characters\[0\]/iu,
      );
      assert.equal(fs.readFileSync(durablePath, "utf8"), raw);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop character store validates an existing durable destination", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-character-store-invalid-durable-"));
  const durablePath = path.join(tempDir, "game-state", "characters.json");
  try {
    fs.mkdirSync(path.dirname(durablePath), { recursive: true });
    fs.writeFileSync(durablePath, "{", "utf8");
    assert.throws(
      () => ensureDesktopCharacterStore({ durablePath }),
      /Invalid durable Successor character store.*JSON parse failed/iu,
    );
    assert.equal(fs.readFileSync(durablePath, "utf8"), "{");
    assert.deepEqual(initializationTemps(path.dirname(durablePath)), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop state lock rejects a second owner, survives a stale path, and releases cleanly", { timeout: 15_000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-state-lock-"));
  const lockPath = path.join(stateDir, ".desktop-state.lock");
  let first;
  let third;
  try {
    fs.writeFileSync(lockPath, "stale lock-path contents are not ownership\n", "utf8");
    first = await acquireDesktopStateLock({ stateDir, lockPath });
    await assert.rejects(
      acquireDesktopStateLock({ stateDir, lockPath }),
      /already in use or its lock could not be acquired/iu,
    );
    assert.equal(fs.existsSync(lockPath), true, "a live lock path must never be unlinked");

    await releaseDesktopStateLock(first);
    first = undefined;
    assert.equal(fs.existsSync(lockPath), true, "the durable kernel-lock path is intentionally retained");

    third = await acquireDesktopStateLock({ stateDir, lockPath });
    assert.ok(third.ownerPid > 0);
  } finally {
    await releaseDesktopStateLock(first);
    await releaseDesktopStateLock(third);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("desktop graceful stop waits for and surfaces supervisor exit code 1", { timeout: 15_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-stop-exit-one-"));
  const serverEntry = path.join(tempDir, "exit-one-server.mjs");
  const readyPath = path.join(tempDir, "ready");
  const events = [];
  let lease;
  try {
    fs.writeFileSync(serverEntry, [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.SUCCESSOR_STOP_TEST_READY, "ready\\n");',
      'process.on("SIGTERM", () => process.exit(1));',
      'setInterval(() => {}, 1_000);',
      '',
    ].join("\n"), "utf8");
    lease = await acquireDesktopStateLock({
      stateDir: tempDir,
      serverEntry,
      serverCwd: tempDir,
      serverEnv: {
        ...process.env,
        SUCCESSOR_STOP_TEST_READY: readyPath,
      },
      log: (event, details) => events.push({ event, details }),
    });
    lease.serverStarted = true;
    lease.child.stdin.write("start\n");
    await waitForPath(readyPath);

    await assert.rejects(
      stopDesktopServerSupervisor(lease.child, {
        port: 0,
        graceMs: 2_000,
        killWaitMs: 1_000,
        log: (event, details) => events.push({ event, details }),
      }),
      /graceful stop failed: code=1 signal=null/iu,
    );
    assert.equal(events.some(({ event }) => event === "game-server-stop-complete"), false);
    assert.equal(events.some(({ event, details }) => event === "game-server-stop-failed" && details.code === 1), true);
  } finally {
    await releaseDesktopStateLock(lease);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop graceful stop surfaces SIGKILL escalation", { timeout: 15_000 }, async () => {
  const child = childProcess.spawn(process.execPath, [
    "-e",
    'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1_000);',
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const events = [];
  try {
    await waitForOutput(child.stdout, "ready");
    await assert.rejects(
      stopDesktopServerSupervisor(child, {
        port: 0,
        graceMs: 50,
        killWaitMs: 1_000,
        log: (event, details) => events.push({ event, details }),
      }),
      /SIGKILL escalation was required/iu,
    );
    assert.equal(events.some(({ event }) => event === "game-server-stop-complete"), false);
    assert.equal(events.some(({ event }) => event === "game-server-stop-escalate"), true);
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
});

test("desktop fresh state never imports a repo-local pre-alpha roster", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-character-store-fresh-"));
  const repoRosterPath = path.join(tempDir, "repo", "server", "data", "characters.json");
  const durablePath = path.join(tempDir, "game-state", "characters.json");
  try {
    fs.mkdirSync(path.dirname(repoRosterPath), { recursive: true });
    const repoDeveloperRoster = fixtureCharacterStore(["char_repo_developer"]);
    fs.writeFileSync(repoRosterPath, repoDeveloperRoster, "utf8");
    assert.deepEqual(ensureDesktopCharacterStore({ durablePath }), {
      initialized: true,
      reason: "fresh_store_initialized",
      characterCount: 0,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(durablePath, "utf8")).characters, []);
    assert.equal(fs.readFileSync(repoRosterPath, "utf8"), repoDeveloperRoster);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop child environment enables persistence and clears inherited game overrides", () => {
  const persistence = desktopShardPersistenceConfig({
    stateDir: path.join(os.tmpdir(), "successor-desktop-state"),
  });
  const staleStateDir = path.join(os.tmpdir(), "successor-desktop-stale");
  const env = desktopServerEnvironment({
    baseEnv: {
      PATH: "/usr/bin",
      PORT: "28092",
      HOST: "0.0.0.0",
      GAME_SHARD_ID: "stale-shard",
      GAME_SHARD_STATE_DIR: staleStateDir,
      GAME_SHARD_PERSISTENCE: "0",
      GAME_CHARACTER_STORE_PATH: path.join(staleStateDir, "characters.json"),
      GAME_SLICE_PATH: path.join(staleStateDir, "slice.json"),
      SECRET_SHOULD_SURVIVE: "redacted-test-value",
    },
    port: 18192,
    paths: {
      slicePath: "/repo/client/public/successor-slice/open-desert-slice.json",
      rustBridgeBin: "/repo/target/debug/examples/authority_bridge_server",
    },
    persistence,
    serverDebugEnabled: true,
  });

  assert.equal(env.PORT, "18192");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.GAME_SHARD_ID, "desktop-open-desert");
  assert.equal(env.GAME_SHARD_STATE_DIR, persistence.stateDir);
  assert.equal(env.GAME_SHARD_PERSISTENCE, "1");
  assert.equal(env.GAME_CHARACTER_STORE_PATH, persistence.characterStorePath);
  assert.equal(env.GAME_SLICE_PATH, "/repo/client/public/successor-slice/open-desert-slice.json");
  assert.equal(env.GAME_RUST_AUTHORITY_BRIDGE_BIN, "/repo/target/debug/examples/authority_bridge_server");
  assert.equal(env.GAME_DEBUG_AUTHORITY_COMMANDS, "1");
  assert.equal(env.SECRET_SHOULD_SURVIVE, "redacted-test-value");
});

function fixtureSlice(stateHash, extra = {}) {
  return JSON.stringify({ schema: "successor.fixture.v1", stateHash, ...extra }, null, 2);
}

function fixtureCheckpoint({
  schema = "successor.game-shard-checkpoint.v1",
  shardId = "desktop-open-desert",
  sliceHash,
  sourceStateHash,
}) {
  const checkpoint = {
    schema,
    shardId,
    sliceHash,
    ...(sourceStateHash === undefined ? {} : { sourceStateHash }),
    tick: 0,
    tickRateHz: 20,
    nextCombatEventId: 1,
    nextBotSeq: 1,
    counters: {},
    actors: [],
    propStates: {},
    travelTickets: [],
  };
  return JSON.stringify({
    ...checkpoint,
    projectionStateHash: desktopCheckpointProjectionStateHash(checkpoint),
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureCharacterStore(ids, { worldEntryClaimed = true } = {}) {
  return `${JSON.stringify({
    schema: "successor.character-store.v2",
    characters: ids.map((id) => ({
      id,
      ownerRef: "local",
      name: id,
      worldEntryClaimed,
    })),
  }, null, 2)}\n`;
}

function initializationTemps(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter((name) => name.includes(".initialize-")).sort();
}

async function waitForPath(filePath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function waitForOutput(stream, expected, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for output ${JSON.stringify(expected)}; received ${JSON.stringify(output)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before output ${JSON.stringify(expected)} code=${code ?? "null"} signal=${signal ?? "null"}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`child output ended before ${JSON.stringify(expected)}`));
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
  });
}
