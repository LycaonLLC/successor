import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { Client as ColyseusClient, type Room as ColyseusRoom } from "@colyseus/sdk";

type Packet = { type?: string; [key: string]: unknown };
type JournalRow = {
  type?: string;
  commandId?: number;
  accepted?: boolean;
  rust?: { stateHash?: string };
  stateHash?: string;
  tick?: number;
};
type ReadyResponse = {
  ready: boolean;
};
type GameStatusResponse = {
  readiness: {
    ready: boolean;
  };
  persistence: {
    stateHash: string;
    restore: {
      journalReplayed: number;
    };
  };
};
type CheckpointResponse = {
  stateHash: string;
};

const serverRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(serverRoot, "..");
const serverEntrypoint = path.join(serverRoot, "dist", "index.js");
const bridgeEntrypoint = path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server");
const slicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");

describe("hosted durability process barrier", () => {
  it("runs the built server and real Rust bridge through kill/restart, checkpoint interleaving, and journal failure", async () => {
    expect(fs.existsSync(serverEntrypoint), `missing built server at ${serverEntrypoint}; run pnpm --dir server build`).toBe(true);
    expect(fs.existsSync(bridgeEntrypoint), `missing Rust bridge at ${bridgeEntrypoint}; build authority_bridge_server first`).toBe(true);

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-hosted-durability-"));
    const checkpointPath = path.join(stateDir, "durability-proof.checkpoint.json");
    const journalPath = path.join(stateDir, "durability-proof.journal.jsonl");
    const manifestPath = path.join(stateDir, "state-generation.manifest.json");
    const characterStorePath = path.join(stateDir, "characters.json");
    let port = await freePort();
    let baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
      PORT: String(port),
      HOST: "127.0.0.1",
      GAME_ALLOW_DEV_IDENTITY: "1",
      GAME_CLOCK: "manual",
      GAME_SHARD_ID: "durability-proof",
      GAME_SHARD_STATE_DIR: stateDir,
      GAME_SHARD_CHECKPOINT_PATH: checkpointPath,
      GAME_SHARD_JOURNAL_PATH: journalPath,
      GAME_SHARD_MANIFEST_PATH: manifestPath,
      GAME_CHARACTER_STORE_PATH: characterStorePath,
      GAME_SHARD_CHECKPOINT_INTERVAL_MS: "600000",
      GAME_CHARACTER_CHECKPOINT_SECONDS: "600",
      GAME_RUST_AUTHORITY_BRIDGE_BIN: bridgeEntrypoint,
      GAME_SLICE_PATH: slicePath,
      GAME_MAP_BUNDLE_PATH: path.join(repoRoot, "client", "public", "successor-slice", "open-desert-map-bundle.json"),
    };
    let server: childProcess.ChildProcess | undefined;
    try {
      server = await launchServer(baseEnv, port);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("EADDRINUSE")) throw error;
      port = await freePort();
      baseEnv = { ...baseEnv, PORT: String(port) };
      server = await launchServer(baseEnv, port);
    }
    let room: ColyseusRoom | undefined;
    let failureJournalBackup: string | undefined;
    try {
      const created = await requestJson<{ id: string }>(port, "/game/characters", {
        method: "POST",
        body: {
          name: "Atlas",
          appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
          initialProfessionId: "brawler",
        },
      });
      expect(created.status).toBe(201);
      const characterId = created.body.id;
      expect(characterId).toMatch(/^char_/u);

      const firstConnection = await connectCharacter(port, characterId);
      room = firstConnection.room;
      const initialStatus = await requestJson<GameStatusResponse>(port, "/game/status");
      expect(initialStatus.body.readiness.ready).toBe(true);
      const commandOne = await sendMove(firstConnection, 1, 1);
      expect(commandOne.accepted).toBe(true);
      const afterFirst = await requestJson<GameStatusResponse>(port, "/game/status");
      const firstStateHash = afterFirst.body.persistence.stateHash;
      expect(firstStateHash).toMatch(/^[a-f0-9]{64}$/u);

      const checkpointRequest = requestJson<CheckpointResponse>(port, "/game/debug/checkpoint", { method: "POST" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const commandTwo = await sendMove(firstConnection, 2, 1);
      expect(commandTwo.accepted).toBe(true);
      const checkpointResponse = await checkpointRequest;
      expect(checkpointResponse.status).toBe(200);
      expect(checkpointResponse.body.stateHash).toMatch(/^[a-f0-9]{64}$/u);
      const afterSecond = await requestJson<GameStatusResponse>(port, "/game/status");
      const secondStateHash = afterSecond.body.persistence.stateHash;
      expect(secondStateHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(secondStateHash).not.toBe(firstStateHash);

      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as { stateHash: string; tick: number; savedAt: string };
      const rowsBeforeReplay = readJournal(journalPath);
      const commandRows = rowsBeforeReplay.filter((row) => row.type === "command.receipt");
      expect(commandRows.filter((row) => row.commandId === 1)).toHaveLength(1);
      expect(commandRows.filter((row) => row.commandId === 2)).toHaveLength(1);
      const commandTwoIndex = rowsBeforeReplay.findIndex((row) => row.type === "command.receipt" && row.commandId === 2);
      const checkpointIndex = rowsBeforeReplay.findIndex((row) => row.type === "checkpoint" && row.stateHash === checkpoint.stateHash && row.tick === checkpoint.tick);
      expect(checkpointIndex).toBeGreaterThanOrEqual(0);
      const commandTwoRow = commandRows.find((row) => row.commandId === 2);
      expect(commandTwoRow?.rust?.stateHash).toBeTruthy();
      if (commandTwoIndex < checkpointIndex) {
        expect(checkpoint.stateHash).toBe(commandTwoRow?.rust?.stateHash);
      } else {
        const commandOneRow = commandRows.find((row) => row.commandId === 1);
        expect(checkpoint.stateHash).toBe(commandOneRow?.rust?.stateHash);
      }

      const commandThree = await sendMove(firstConnection, 3, -1);
      expect(commandThree.accepted).toBe(true);
      const afterThird = await requestJson<GameStatusResponse>(port, "/game/status");
      const thirdStateHash = afterThird.body.persistence.stateHash;
      expect(thirdStateHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(thirdStateHash).not.toBe(secondStateHash);

      failureJournalBackup = `${journalPath}.before-injected-failure`;
      fs.renameSync(journalPath, failureJournalBackup);
      fs.mkdirSync(journalPath);
      const failedCommand = await sendMoveExpectingPersistenceError(firstConnection, 4, -1);
      expect(failedCommand.errorCode).toBe("persistence_unavailable");
      const notReady = await requestJson<ReadyResponse>(port, "/readyz");
      expect(notReady.status).toBe(503);
      expect(notReady.body.ready).toBe(false);
      await room.leave(true);
      room = undefined;
      await killAndWait(server);
      server = undefined;

      fs.rmSync(journalPath, { recursive: true, force: true });
      fs.renameSync(failureJournalBackup, journalPath);
      failureJournalBackup = undefined;

      server = await launchServer(baseEnv, port);
      const restartedReady = await requestJson<ReadyResponse>(port, "/readyz");
      expect(restartedReady.status).toBe(200);
      expect(restartedReady.body.ready).toBe(true);
      const restartedStatus = await requestJson<GameStatusResponse>(port, "/game/status");
      expect(restartedStatus.body.persistence.restore.journalReplayed).toBeGreaterThanOrEqual(1);
      expect(restartedStatus.body.persistence.stateHash).toBe(thirdStateHash);
      const restartedConnection = await connectCharacter(port, characterId);
      room = restartedConnection.room;
      await room.leave(true);
      room = undefined;

      const rowsAfterRestart = readJournal(journalPath);
      expect(rowsAfterRestart.filter((row) => row.type === "command.receipt" && row.commandId === 1)).toHaveLength(1);
      expect(rowsAfterRestart.filter((row) => row.type === "command.receipt" && row.commandId === 2)).toHaveLength(1);
      expect(rowsAfterRestart.filter((row) => row.type === "command.receipt" && row.commandId === 3)).toHaveLength(1);
      expect(rowsAfterRestart.filter((row) => row.type === "command.receipt" && row.commandId === 4)).toHaveLength(0);
      console.log(JSON.stringify({
        schema: "successor.hosted-durability-proof.v1",
        status: "pass",
        server: "built-dist",
        rustBridge: "compiled-authority_bridge_server",
        commands: { acceptedDurable: 3, failedWithoutReceipt: 1, journalRows: rowsAfterRestart.filter((row) => row.type === "command.receipt").length },
        checkpoint: { stateHash: checkpoint.stateHash, checkpointIndex, commandTwoIndex, barrierHeld: true },
        restart: { readiness: restartedReady.body.ready, journalReplayed: restartedStatus.body.persistence.restore.journalReplayed, stateHashStable: restartedStatus.body.persistence.stateHash === thirdStateHash },
      }));
    } finally {
      if (room) await room.leave(true).catch(() => undefined);
      if (failureJournalBackup && fs.existsSync(failureJournalBackup)) {
        fs.rmSync(journalPath, { recursive: true, force: true });
        fs.renameSync(failureJournalBackup, journalPath);
      }
      if (server) await killAndWait(server).catch(() => undefined);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 120_000);
});

async function launchServer(env: NodeJS.ProcessEnv, port: number): Promise<childProcess.ChildProcess> {
  const child = childProcess.spawn(process.execPath, [serverEntrypoint], {
    cwd: serverRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const capture = (target: string[], stream: NodeJS.ReadableStream | null) => {
    stream?.on("data", (chunk: Buffer | string) => {
      target.push(String(chunk));
      while (target.join("").length > 12_000 && target.length > 1) target.shift();
    });
    stream?.resume();
  };
  capture(stdout, child.stdout);
  capture(stderr, child.stderr);
  const diagnostics = () => `\nstdout tail:\n${stdout.join("").slice(-12_000)}\nstderr tail:\n${stderr.join("").slice(-12_000)}`;
  await waitForReady(port, child, diagnostics);
  return child;
}

async function waitForReady(port: number, child: childProcess.ChildProcess, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`hosted server exited before readiness: ${child.exitCode}${diagnostics()}`);
    try {
      const response = await requestJson<ReadyResponse>(port, "/readyz");
      if (response.status === 200 && response.body.ready === true) return;
    } catch {
      // The listening socket and Rust bridge come up in separate steps.
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for hosted server readiness${diagnostics()}`);
    await sleep(50);
  }
}

async function connectCharacter(port: number, characterId: string): Promise<{ room: ColyseusRoom; packets: Packet[] }> {
  const client = new ColyseusClient(`http://127.0.0.1:${port}`);
  const room = await client.joinOrCreate("game", { characterId, zoneId: "open-desert" });
  const packets: Packet[] = [];
  let helloResolve!: () => void;
  const hello = new Promise<void>((resolve) => { helloResolve = resolve; });
  room.onMessage("game.packet", (packet) => {
    const parsed = packet as Packet;
    packets.push(parsed);
    if (parsed.type === "game.hello") helloResolve();
  });
  room.send("game.ready");
  await withTimeout(hello, 30_000);
  return { room, packets };
}

async function sendMove(connection: { room: ColyseusRoom; packets: Packet[] }, commandId: number, dx: number): Promise<{ accepted: boolean }> {
  const start = connection.packets.length;
  connection.room.send("game.command", {
    session: 1,
    player: 1,
    command_id: commandId,
    issued_at_tick: 0,
    command: commandId === 2 || commandId === 3
      ? { SetMoveIntent: { dx, dy: 0, facing: dx >= 0 ? "Right" : "Left" } }
      : { Move: { dx, dy: 0, duration_ticks: 1, facing: dx >= 0 ? "Right" : "Left" } },
  });
  const packet = await waitForPacket(connection.packets, start, (candidate) => candidate.type === "game.acks" && Array.isArray(candidate.acks) && (candidate.acks as unknown[][]).some((ack) => ack[0] === commandId));
  const ack = (packet.acks as unknown[][]).find((candidate) => candidate[0] === commandId);
  return { accepted: ack?.[1] === 1 };
}

async function sendMoveExpectingPersistenceError(connection: { room: ColyseusRoom; packets: Packet[] }, commandId: number, dx: number): Promise<{ errorCode?: string }> {
  const start = connection.packets.length;
  connection.room.send("game.command", {
    session: 1,
    player: 1,
    command_id: commandId,
    issued_at_tick: 0,
    command: { Move: { dx, dy: 0, duration_ticks: 1, facing: dx >= 0 ? "Right" : "Left" } },
  });
  const packet = await waitForPacket(connection.packets, start, (candidate) => candidate.type === "game.error");
  return { errorCode: typeof packet.code === "string" ? packet.code : undefined };
}

async function waitForPacket(packets: Packet[], start: number, predicate: (packet: Packet) => boolean): Promise<Packet> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const found = packets.slice(start).find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error("timed out waiting for game packet");
    await sleep(10);
  }
}

function readJournal(journalPath: string): JournalRow[] {
  if (!fs.existsSync(journalPath)) return [];
  const raw = fs.readFileSync(journalPath, "utf8").trim();
  return raw.length === 0 ? [] : raw.split(/\r?\n/u).map((line) => JSON.parse(line) as JournalRow);
}

async function requestJson<T>(port: number, route: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() as T };
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve a port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function killAndWait(child: childProcess.ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}
