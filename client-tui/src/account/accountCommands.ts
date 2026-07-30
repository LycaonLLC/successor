/**
 * login / logout / account — this computer's standing with the hosted world.
 *
 * login runs the device flow and stores the one scoped credential (0700 dir,
 * 0600 file, atomic replace). logout revokes it server-side first, then
 * deletes the file either way and says which of the two actually happened.
 * account reports what is stored and whether the server still honors it.
 */
import { spawn } from "node:child_process";
import process from "node:process";

import { AlphaApiError, createAlphaApi, detectReleaseId, type AlphaApi } from "./alphaApi";
import {
  CredentialStoreError,
  credentialFilePath,
  deleteCredential,
  loadCredential,
  saveCredential,
  type CredentialStoreContext,
} from "./credentialStore";
import { DeviceFlowError, runDeviceFlow } from "./deviceFlow";
import { DEFAULT_API_URL, type AccountCommandOptions } from "../options";

export interface AccountIo {
  print(line: string): void;
  error(line: string): void;
}

export interface AccountDeps {
  io: AccountIo;
  store?: CredentialStoreContext;
  makeApi?: (apiUrl: string) => AlphaApi;
  /** Browser opener — receives the clean approval URL, nothing else. */
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  releaseId?: string;
}

function openSystemBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

export async function runLogin(options: AccountCommandOptions, deps: AccountDeps): Promise<number> {
  const { io } = deps;
  const api = (deps.makeApi ?? createAlphaApi)(options.apiUrl);
  const releaseId = deps.releaseId ?? await detectReleaseId();
  try {
    const previous = await loadCredential(deps.store).catch(() => null);
    const result = await runDeviceFlow({
      api,
      io: { print: io.print, openBrowser: deps.openBrowser ?? openSystemBrowser },
      releaseId,
      openBrowser: options.openBrowser,
      sleep: deps.sleep,
      now: deps.now,
    });
    const file = await saveCredential({
      apiUrl: api.apiUrl,
      credential: result.credential,
      scopes: result.scopes,
      obtainedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    }, deps.store);
    if (previous && previous.credential !== result.credential) {
      // this computer held an older credential; retire it server-side
      await api.deviceLogout(previous.credential).catch(() => {});
    }
    io.print(`Stored this computer's access at ${file}.`);
    io.print("Run `successor-tui` to play.");
    return 0;
  } catch (error) {
    if (error instanceof DeviceFlowError || error instanceof AlphaApiError || error instanceof CredentialStoreError) {
      io.error(error.message);
      return 1;
    }
    throw error;
  }
}

export async function runLogout(options: AccountCommandOptions, deps: AccountDeps): Promise<number> {
  const { io } = deps;
  let stored;
  try {
    stored = await loadCredential(deps.store);
  } catch (error) {
    if (!(error instanceof CredentialStoreError)) throw error;
    // Unsafe or unreadable state: we cannot revoke what we refuse to read,
    // but we can still remove it from this machine.
    io.error(error.message);
    const removed = await deleteCredential(deps.store);
    io.print(removed ? "Removed the unusable credential file." : "Nothing was stored.");
    return removed ? 0 : 1;
  }
  if (!stored) {
    io.print("This computer holds no access. Nothing to do.");
    return 0;
  }
  const api = (deps.makeApi ?? createAlphaApi)(credentialApiUrl(options, stored.apiUrl));
  let revoked: "revoked" | "unsupported" | "unreached" = "unreached";
  try {
    revoked = await api.deviceLogout(stored.credential);
  } catch {
    revoked = "unreached";
  }
  await deleteCredential(deps.store);
  if (revoked === "revoked") {
    io.print("Access revoked on the server and removed from this computer.");
  } else {
    io.print("Removed from this computer. The server could not confirm the revoke — the Devices list on the account page can finish the job.");
  }
  return 0;
}

/** The credential belongs to the service that minted it; an explicit
 *  --api-url that differs is honored, the silent default is not. */
function credentialApiUrl(options: AccountCommandOptions, storedApiUrl: string): string {
  return options.apiUrl !== DEFAULT_API_URL && options.apiUrl !== storedApiUrl ? options.apiUrl : storedApiUrl;
}

export async function runAccount(options: AccountCommandOptions, deps: AccountDeps): Promise<number> {
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
    io.print("This computer is not connected to an account. Run `successor-tui login`.");
    return 1;
  }
  io.print(`Credential file: ${credentialFilePath(deps.store)}`);
  io.print(`Account service: ${stored.apiUrl}`);
  io.print(`Allowed to: ${stored.scopes.join(", ")}`);
  io.print(`Connected since: ${stored.obtainedAt}`);
  const api = (deps.makeApi ?? createAlphaApi)(credentialApiUrl(options, stored.apiUrl));
  try {
    const characters = await api.listCharacters(stored.credential);
    if (characters.length === 0) {
      io.print("Characters: none yet. Create one on the account page in a browser.");
    } else {
      io.print("Characters:");
      for (const character of characters) {
        io.print(`  ${character.name}${character.initialProfessionId ? ` — ${character.initialProfessionId}` : ""}`);
      }
    }
    return 0;
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
}
