/**
 * CLI options — hosted account play is the default surface. `successor-tui`
 * signs the player into the hosted world through the credential minted by
 * `successor-tui login`; the old local-server flag surface (dev identities,
 * hand-carried tickets) survives only behind an explicit `--legacy`.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export const DEFAULT_API_URL = "https://www.successorgame.com";

export interface TuiOptions {
  endpoint: string;
  slicePath: string;
  playerId?: string;
  actorId?: string;
  displayName?: string;
  zoneId?: string;
  characterId?: string;
  ticket?: string;
  spawnArea?: string;
  spawnX?: number;
  spawnY?: number;
  facing?: "front" | "right" | "back" | "left";
  tickIntervalMs?: number;
  readyTimeoutMs?: number;
  /** /attack auto-approach leg timeout (pursue.ts DEFAULT_PURSUE_TIMEOUT_MS when unset). */
  pursueTimeoutMs?: number;
  chatUrl: string | null;
  plain: boolean;
  verbose: boolean;
  intro: boolean;
  /** Present only on hosted launches minted by the account flow. */
  hosted?: HostedLaunch;
}

/** One-use split capabilities for a hosted launch, cleared as each is consumed. */
export interface HostedLaunch {
  gameTicket?: string;
  chatTicket?: string;
  /** Exact storefront Origin for matchmake/WS admission. Not a secret, but
   *  carried only in memory alongside the tickets. */
  origin?: string;
  /** Either leg failing (join, ready, or chat auth) ends the run; the hosted
   *  loop shows one notice and mints a fresh envelope on the next attempt. */
  onLegFailure?: (notice: string) => void;
}

export interface HostedPlayOptions {
  apiUrl: string;
  slicePath: string;
  /** Skip the roster prompt: exact character id or case-insensitive name. */
  character?: string;
  plain: boolean;
  verbose: boolean;
  intro: boolean;
  tickIntervalMs?: number;
  readyTimeoutMs?: number;
  pursueTimeoutMs?: number;
}

export interface AccountCommandOptions {
  apiUrl: string;
  /** login only — open the approval page here too. Never implied. */
  openBrowser: boolean;
}

export type TuiInvocation =
  | "help"
  | { kind: "login"; account: AccountCommandOptions }
  | { kind: "logout"; account: AccountCommandOptions }
  | { kind: "account"; account: AccountCommandOptions }
  | { kind: "hosted"; hosted: HostedPlayOptions }
  | { kind: "legacy"; legacy: TuiOptions };

const LEGACY_ONLY_FLAGS: Record<string, true> = {
  "--game-url": true, "--endpoint": true, "--player-id": true, "--actor-id": true,
  "--display-name": true, "--zone-id": true, "--character-id": true, "--spawn-area": true,
  "--spawn-x": true, "--spawn-y": true, "--facing": true, "--chat-url": true, "--no-chat": true,
};

export function parseTuiArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): TuiInvocation {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const command = argv[0] === "login" || argv[0] === "logout" || argv[0] === "account" ? argv[0] : null;
  if (command) return parseAccountCommand(command, argv.slice(1), env);
  if (argv.includes("--legacy")) {
    return { kind: "legacy", legacy: parseLegacyArgs(argv.filter((arg) => arg !== "--legacy"), env) };
  }
  return { kind: "hosted", hosted: parseHostedArgs(argv, env) };
}

function parseAccountCommand(command: "login" | "logout" | "account", argv: readonly string[], env: NodeJS.ProcessEnv): TuiInvocation {
  const account: AccountCommandOptions = { apiUrl: env.SUCCESSOR_API_URL ?? DEFAULT_API_URL, openBrowser: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--open-browser") {
      if (command !== "login") throw new Error(`--open-browser only applies to successor-tui login`);
      account.openBrowser = true;
      continue;
    }
    if (arg === "--api-url") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--api-url requires a value");
      account.apiUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown successor-tui ${command} option ${arg}`);
  }
  return { kind: command, account };
}

function parseHostedArgs(argv: readonly string[], env: NodeJS.ProcessEnv): HostedPlayOptions {
  if (env.SUCCESSOR_TICKET) {
    throw new Error("SUCCESSOR_TICKET is set, but hosted play never reads a ticket from the environment. Unset it, or add --legacy to target a local server.");
  }
  const options: HostedPlayOptions = {
    apiUrl: env.SUCCESSOR_API_URL ?? DEFAULT_API_URL,
    slicePath: env.SUCCESSOR_SLICE_PATH ?? defaultSlicePath(),
    plain: false,
    verbose: false,
    intro: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--plain") {
      options.plain = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--no-intro") {
      options.intro = false;
      continue;
    }
    if (arg === "--ticket") {
      throw new Error("--ticket is legacy-only. Hosted play mints its own launch after sign-in; add --legacy to target a local server.");
    }
    if (LEGACY_ONLY_FLAGS[arg]) {
      throw new Error(`${arg} is legacy-only. Add --legacy to target a local server.`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    index += 1;
    switch (arg) {
      case "--api-url":
        options.apiUrl = value;
        break;
      case "--character":
        options.character = value;
        break;
      case "--slice":
        options.slicePath = value;
        break;
      case "--tick-ms":
        options.tickIntervalMs = finiteNumber(arg, value);
        break;
      case "--ready-timeout-ms":
        options.readyTimeoutMs = finiteNumber(arg, value);
        break;
      case "--pursue-timeout-ms":
        options.pursueTimeoutMs = finiteNumber(arg, value);
        break;
      default:
        throw new Error(`unknown successor-tui option ${arg}`);
    }
  }
  return options;
}

function parseLegacyArgs(argv: readonly string[], env: NodeJS.ProcessEnv): TuiOptions {
  const port = env.OPEN_DESERT_PORT ?? env.GAME_AUTHORITY_SERVER_PORT ?? "28093";
  const options: TuiOptions = {
    endpoint: env.SUCCESSOR_GAME_URL ?? `http://127.0.0.1:${port}`,
    slicePath: env.SUCCESSOR_SLICE_PATH ?? defaultSlicePath(),
    playerId: env.SUCCESSOR_PLAYER_ID,
    actorId: env.SUCCESSOR_ACTOR_ID,
    displayName: env.SUCCESSOR_DISPLAY_NAME,
    zoneId: env.SUCCESSOR_ZONE_ID,
    characterId: env.SUCCESSOR_CHARACTER_ID,
    ticket: env.SUCCESSOR_TICKET,
    spawnArea: env.SUCCESSOR_SPAWN_AREA,
    spawnX: numberEnv(env, "SUCCESSOR_SPAWN_X"),
    spawnY: numberEnv(env, "SUCCESSOR_SPAWN_Y"),
    facing: facingOf(env.SUCCESSOR_FACING),
    chatUrl: null,
    plain: false,
    verbose: false,
    intro: true,
  };
  let chatDisabled = false;
  let chatOverride: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--plain") {
      options.plain = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--no-intro") {
      options.intro = false;
      continue;
    }
    if (arg === "--no-chat") {
      chatDisabled = true;
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
        options.spawnX = finiteNumber(arg, value);
        break;
      case "--spawn-y":
        options.spawnY = finiteNumber(arg, value);
        break;
      case "--facing": {
        const facing = facingOf(value);
        if (!facing) throw new Error(`--facing must be front/right/back/left; got ${value}`);
        options.facing = facing;
        break;
      }
      case "--tick-ms":
        options.tickIntervalMs = finiteNumber(arg, value);
        break;
      case "--ready-timeout-ms":
        options.readyTimeoutMs = finiteNumber(arg, value);
        break;
      case "--pursue-timeout-ms":
        options.pursueTimeoutMs = finiteNumber(arg, value);
        break;
      case "--chat-url":
        chatOverride = value;
        break;
      default:
        throw new Error(`unknown successor-tui option ${arg}`);
    }
  }

  options.chatUrl = chatDisabled ? null : chatOverride ?? deriveChatUrl(options);
  return options;
}

/** Legacy only: game endpoint → chat hub WS URL with identity query (routes.ts contract). */
export function deriveChatUrl(options: Pick<TuiOptions, "endpoint" | "playerId" | "actorId" | "displayName" | "zoneId" | "ticket">): string {
  const base = new URL(options.endpoint);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${base.host}/chat/ws`);
  if (options.ticket) {
    url.searchParams.set("ticket", options.ticket);
    return url.toString();
  }
  const playerId = options.playerId ?? options.actorId ?? "tui-operative";
  url.searchParams.set("playerId", playerId);
  url.searchParams.set("displayName", options.displayName ?? "TUI Operative");
  url.searchParams.set("zoneId", options.zoneId ?? "open-desert");
  return url.toString();
}

/** Hosted: chat hub WS URL with no query at all — the capability goes in the first frame. */
export function hostedChatUrl(gameEndpoint: string): string {
  const base = new URL(gameEndpoint);
  const protocol = base.protocol === "https:" || base.protocol === "wss:" ? "wss:" : "ws:";
  return `${protocol}//${base.host}/chat/ws`;
}

function defaultSlicePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "client", "public", "successor-slice", "open-desert-slice.json"),
    path.resolve(process.cwd(), "..", "client", "public", "successor-slice", "open-desert-slice.json"),
    path.resolve(process.cwd(), "public", "successor-slice", "open-desert-slice.json"),
    path.resolve(process.cwd(), "successor-slice", "open-desert-slice.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function numberEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  return finiteNumber(name, raw);
}

function finiteNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number; got ${raw}`);
  return value;
}

function facingOf(raw: string | undefined): TuiOptions["facing"] {
  return raw === "front" || raw === "right" || raw === "back" || raw === "left" ? raw : undefined;
}

export function helpText(): string {
  return `successor-tui — the Successor terminal client
Full-screen MUD over the shared game runtime. The prose log is the game;
panes carry vitals, weapon, queue, radar, chat. --plain gives the classic
line-mode MUD (pipes, screen readers, dumb terminals).

Usage:
  successor-tui                 play on your account (sign in first)
  successor-tui login           connect this computer to your account
  successor-tui logout          remove this computer's access
  successor-tui account         show what this computer can reach
  successor-tui --legacy ...    target a local/dev server (old flags)

Hosted play:
  --character NAME|ID        skip the roster prompt
  --api-url URL              account service (default ${DEFAULT_API_URL})
  --plain                    line-mode MUD (auto when not a TTY)
  --no-intro                 go straight to the field
  --verbose                  combat lines carry the roll arithmetic
  --slice PATH               local slice JSON path
  --tick-ms N                host tick interval
  --ready-timeout-ms N       game.hello timeout
  --pursue-timeout-ms N      /attack auto-approach gives up after N ms (default 45000)

login:
  --open-browser             also open the approval page on this machine
  --api-url URL              account service

Legacy (--legacy; local servers only):
  --game-url URL --slice PATH --player-id ID --actor-id ID
  --display-name NAME --zone-id ID --character-id ID --ticket VALUE
  --spawn-area ID --spawn-x N --spawn-y N --facing front|right|back|left
  --chat-url URL --no-chat

Keys (full TUI): type to talk, / to command, Tab completes verbs,
w/a/s/d (empty line) walk by compass, x stops, PgUp/PgDn scroll the log,
Ctrl+L repaints, Ctrl+C or /quit leaves.
`;
}
