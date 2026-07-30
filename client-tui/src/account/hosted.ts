/**
 * Hosted play — the default `successor-tui` run.
 *
 * Loads this computer's credential and launches: one character on the
 * account goes straight in, more than one gets a numbered pick. Then
 * mint the split game/chat envelope, hand the game
 * ticket to the join body and the chat ticket to the first socket frame,
 * then forget both. If either leg fails, both close, one notice prints,
 * and the next attempt mints a fresh envelope. Tickets never touch a URL,
 * argv, the environment, or the log.
 */
import { AlphaApiError, createAlphaApi, type AlphaApi, type LaunchEnvelope, type OwnedCharacter } from "./alphaApi";
import { CredentialStoreError, loadCredential, type CredentialStoreContext } from "./credentialStore";
import { DEFAULT_API_URL, hostedChatUrl, type HostedPlayOptions, type TuiOptions } from "../options";

export interface HostedIo {
  print(line: string): void;
  error(line: string): void;
  /** One line of input; null on EOF. Only called when interactive. */
  question(prompt: string): Promise<string | null>;
  interactive: boolean;
}

export type SessionOutcome =
  | { kind: "quit"; code: number }
  | { kind: "leg-failed"; notice: string };

export interface HostedDeps {
  io: HostedIo;
  runSession(options: TuiOptions): Promise<SessionOutcome>;
  store?: CredentialStoreContext;
  makeApi?: (apiUrl: string) => AlphaApi;
}

/** Canonical storefront Origin for socket admission, from the account
 *  service URL. https only, except loopback http for local fakes. */
export function storefrontOrigin(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new AlphaApiError("API_URL_INVALID", `${apiUrl} is not a URL, so no Origin can be derived.`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AlphaApiError("API_URL_INVALID", `${apiUrl} — refusing to present a non-https Origin (plain http is allowed only for 127.0.0.1).`);
  }
  return url.origin;
}

/** Server-named chat endpoint, scrubbed: ws(s) scheme, no query, no hash. */
export function cleanChatUrl(raw: string, gameEndpoint: string): string {
  if (!raw) return hostedChatUrl(gameEndpoint);
  const url = new URL(raw);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** --character NAME|ID against the roster: exact id, else unique name. */
export function resolveCharacter(characters: readonly OwnedCharacter[], wanted: string): OwnedCharacter | { error: string } {
  const byId = characters.find((character) => character.id === wanted);
  if (byId) return byId;
  const lowered = wanted.toLocaleLowerCase("en-US");
  const byName = characters.filter((character) => character.name.toLocaleLowerCase("en-US") === lowered);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) return { error: `More than one character is named ${wanted}. Pass the id instead.` };
  return { error: `No character called ${wanted} on this account. You have: ${characters.map((character) => character.name).join(", ")}.` };
}

function buildLaunchOptions(
  options: HostedPlayOptions,
  envelope: LaunchEnvelope,
  character: OwnedCharacter,
  origin: string,
  onLegFailure: (notice: string) => void,
): TuiOptions {
  return {
    endpoint: envelope.endpoints.game,
    slicePath: options.slicePath,
    playerId: character.id,
    actorId: character.id,
    displayName: character.name,
    zoneId: envelope.release.shard || "open-desert",
    characterId: character.id,
    chatUrl: cleanChatUrl(envelope.endpoints.chat, envelope.endpoints.game),
    plain: options.plain,
    verbose: options.verbose,
    intro: options.intro,
    ...(options.tickIntervalMs !== undefined ? { tickIntervalMs: options.tickIntervalMs } : {}),
    ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
    ...(options.pursueTimeoutMs !== undefined ? { pursueTimeoutMs: options.pursueTimeoutMs } : {}),
    hosted: {
      gameTicket: envelope.gameTicket,
      chatTicket: envelope.chatTicket,
      origin,
      onLegFailure,
    },
  };
}

async function pickCharacter(characters: readonly OwnedCharacter[], options: HostedPlayOptions, io: HostedIo): Promise<OwnedCharacter | number> {
  if (options.character !== undefined) {
    const resolved = resolveCharacter(characters, options.character);
    if ("error" in resolved) {
      io.error(resolved.error);
      return 2;
    }
    return resolved;
  }
  if (characters.length === 1) {
    io.print(`Playing ${characters[0]!.name}.`);
    return characters[0]!;
  }
  if (!io.interactive) {
    io.error("Not a terminal — pass --character NAME to pick without the menu.");
    return 2;
  }
  io.print("Characters on this account:");
  characters.forEach((character, index) => {
    io.print(`  ${index + 1}. ${character.name}${character.initialProfessionId ? ` — ${character.initialProfessionId}` : ""}`);
  });
  for (;;) {
    const answer = await io.question(`Press Enter to play ${characters[0]!.name}, type a number, or q to quit: `);
    if (answer === null || answer.trim().toLowerCase() === "q") return 0;
    const trimmed = answer.trim();
    if (trimmed.length === 0) return characters[0]!;
    const index = Number(trimmed);
    if (Number.isInteger(index) && index >= 1 && index <= characters.length) return characters[index - 1]!;
    io.print(`That isn't on the list. Numbers 1 to ${characters.length}, or q.`);
  }
}

export async function runHostedPlay(options: HostedPlayOptions, deps: HostedDeps): Promise<number> {
  const { io } = deps;
  let stored;
  try {
    stored = await loadCredential(deps.store);
  } catch (error) {
    if (!(error instanceof CredentialStoreError)) throw error;
    io.error(error.message);
    return 1;
  }
  if (!stored) {
    io.error("This computer is not connected to an account. Run `successor-tui login` first.");
    return 1;
  }
  // The credential belongs to the service it was minted by; an explicit
  // --api-url that differs is honored, the silent default is not.
  const apiUrl = options.apiUrl !== DEFAULT_API_URL && options.apiUrl !== stored.apiUrl
    ? options.apiUrl
    : stored.apiUrl;
  let api: AlphaApi;
  let origin: string;
  try {
    api = (deps.makeApi ?? createAlphaApi)(apiUrl);
    origin = storefrontOrigin(apiUrl);
  } catch (error) {
    if (!(error instanceof AlphaApiError)) throw error;
    io.error(error.message);
    return 1;
  }

  let characters: OwnedCharacter[];
  try {
    characters = await api.listCharacters(stored.credential);
  } catch (error) {
    if (error instanceof AlphaApiError && error.code === "AUTH_REJECTED") {
      io.error("The server no longer accepts this computer's access. Run `successor-tui login`.");
      return 1;
    }
    if (error instanceof AlphaApiError) {
      io.error(error.message);
      return 1;
    }
    throw error;
  }
  if (characters.length === 0) {
    io.error("No characters on this account yet. Create one on the account page in a browser, then run successor-tui again.");
    return 1;
  }

  const picked = await pickCharacter(characters, options, io);
  if (typeof picked === "number") return picked;

  for (;;) {
    let envelope: LaunchEnvelope;
    try {
      envelope = await api.playTicket(stored.credential, picked.id);
    } catch (error) {
      if (!(error instanceof AlphaApiError)) throw error;
      if (error.code === "AUTH_REJECTED") {
        io.error("The server no longer accepts this computer's access. Run `successor-tui login`.");
      } else if (error.code === "LEGAL_REQUIRED") {
        io.error("Your account has updated terms to accept. Sign in on the site first, then run successor-tui again.");
      } else {
        io.error(error.message);
      }
      return 1;
    }
    if (!envelope.endpoints.game) {
      io.error("The server did not name a game endpoint for this launch. Nothing to connect to.");
      return 1;
    }

    let legNotice: string | null = null;
    const launchOptions = buildLaunchOptions(options, envelope, picked, origin, (notice) => {
      legNotice = legNotice ?? notice;
    });
    // launchOptions owns the one-use pair; this loop never reads it again.

    let outcome: SessionOutcome;
    try {
      outcome = await deps.runSession(launchOptions);
    } catch (error) {
      outcome = { kind: "leg-failed", notice: error instanceof Error ? error.message : String(error) };
    }
    if (legNotice !== null && outcome.kind === "quit") {
      outcome = { kind: "leg-failed", notice: legNotice };
    }
    if (outcome.kind === "quit") return outcome.code;

    io.error(`Launch failed: ${outcome.notice}`);
    io.error("Both connections were closed and that launch is spent.");
    if (!io.interactive) return 1;
    const answer = await io.question("Press Enter to try again with a fresh launch, or q to quit: ");
    if (answer === null || answer.trim().toLowerCase() === "q") return 1;
  }
}
