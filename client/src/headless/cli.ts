#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";

import { createSuccessorHeadlessHost, type SuccessorHeadlessHostOptions } from "./host";
import { SuccessorDriverProtocol } from "./protocol";
import { nextRuntimeAuthorityCommandIdFloor } from "../slice-core/authorityCommandSystem";

interface SuccessorPlayCliOptions extends SuccessorHeadlessHostOptions {
  text: boolean;
}

interface SuccessorPlayIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function main(argv = process.argv.slice(2), io: SuccessorPlayIo = process): Promise<number> {
  const options = parseArgs(argv);
  if (options === "help") {
    io.stdout.write(helpText());
    return 0;
  }

  const host = await createSuccessorHeadlessHost(options);
  const protocol = new SuccessorDriverProtocol(host, {
    text: options.text,
    writeLine: (line) => io.stdout.write(`${line}\n`),
  });

  try {
    await host.start();
    await protocol.run(io.stdin);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    await host.close();
    return 1;
  } finally {
    protocol.dispose();
  }
}

function parseArgs(argv: readonly string[]): SuccessorPlayCliOptions | "help" {
  const options: SuccessorPlayCliOptions = {
    endpoint: process.env.SUCCESSOR_GAME_URL ?? defaultEndpoint(),
    slicePath: process.env.SUCCESSOR_SLICE_PATH ?? defaultSlicePath(),
    playerId: process.env.SUCCESSOR_PLAYER_ID,
    actorId: process.env.SUCCESSOR_ACTOR_ID,
    displayName: process.env.SUCCESSOR_DISPLAY_NAME,
    zoneId: process.env.SUCCESSOR_ZONE_ID,
    characterId: process.env.SUCCESSOR_CHARACTER_ID,
    ticket: process.env.SUCCESSOR_TICKET,
    spawnArea: process.env.SUCCESSOR_SPAWN_AREA,
    spawnX: numberEnv("SUCCESSOR_SPAWN_X"),
    spawnY: numberEnv("SUCCESSOR_SPAWN_Y"),
    facing: facingEnv("SUCCESSOR_FACING"),
    commandIdFloor: numberEnv("SUCCESSOR_COMMAND_ID_FLOOR") ?? nextRuntimeAuthorityCommandIdFloor(),
    text: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--text") {
      options.text = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    index += 1;
    switch (arg) {
      case "--game-url":
      case "--endpoint":
        options.endpoint = value;
        break;
      case "--slice":
        options.slicePath = value;
        break;
      case "--player-id":
        options.playerId = value;
        break;
      case "--actor-id":
        options.actorId = value;
        break;
      case "--display-name":
        options.displayName = value;
        break;
      case "--zone-id":
        options.zoneId = value;
        break;
      case "--character-id":
        options.characterId = value;
        break;
      case "--ticket":
        options.ticket = value;
        break;
      case "--spawn-area":
        options.spawnArea = value;
        break;
      case "--spawn-x":
        options.spawnX = finiteNumberFlag(arg, value);
        break;
      case "--spawn-y":
        options.spawnY = finiteNumberFlag(arg, value);
        break;
      case "--facing":
        options.facing = parseFacing(value);
        break;
      case "--tick-ms":
        options.tickIntervalMs = finiteNumberFlag(arg, value);
        break;
      case "--ready-timeout-ms":
        options.readyTimeoutMs = finiteNumberFlag(arg, value);
        break;
      case "--command-id-floor":
        options.commandIdFloor = finiteNumberFlag(arg, value);
        break;
      default:
        throw new Error(`unknown successor-play option ${arg}`);
    }
  }

  return options;
}

function defaultEndpoint(): string {
  const port = process.env.OPEN_DESERT_PORT ?? process.env.GAME_AUTHORITY_SERVER_PORT ?? "28093";
  return `http://127.0.0.1:${port}`;
}

function defaultSlicePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "client", "public", "successor-slice", "open-desert-slice.json"),
    path.resolve(process.cwd(), "public", "successor-slice", "open-desert-slice.json"),
    path.resolve(process.cwd(), "successor-slice", "open-desert-slice.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return finiteNumberFlag(name, raw);
}

function facingEnv(name: string): SuccessorPlayCliOptions["facing"] {
  const raw = process.env[name];
  return raw ? parseFacing(raw) : undefined;
}

function finiteNumberFlag(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number; got ${raw}`);
  return value;
}

function parseFacing(raw: string): NonNullable<SuccessorPlayCliOptions["facing"]> {
  if (raw === "front" || raw === "right" || raw === "back" || raw === "left") return raw;
  throw new Error(`facing must be front/right/back/left; got ${raw}`);
}

function helpText(): string {
  return `successor-play — Successor headless driver host\n\nJSONL stdin frames:\n  {"op":"verb","line":"/target nearest hostile"}\n  {"op":"query","verb":"/where"}\n  {"op":"quit"}\n\nOptions:\n  --game-url URL            Colyseus HTTP endpoint (default from OPEN_DESERT_PORT or 28093)\n  --slice PATH              local slice JSON path\n  --player-id ID            player id\n  --actor-id ID             actor id controlled by this headless session\n  --display-name NAME       display name\n  --zone-id ID              zone id\n  --spawn-area ID           spawn area id\n  --spawn-x N               spawn x\n  --spawn-y N               spawn y\n  --facing DIR              front/right/back/left\n  --command-id-floor N      first fresh authority command id after a restored reconnect\n  --text                    print query envelopes as their SP1 text rendering\n`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
