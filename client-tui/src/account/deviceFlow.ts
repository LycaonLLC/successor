/**
 * Device sign-in — start, show the code, poll until the browser decides.
 *
 * The device code and the credential are secrets: they exist in memory and
 * in the request body, nowhere else. The human sees exactly two things: the
 * approval URL (clean, no code embedded) and the user code to type there.
 * Polling never dips under the 5s floor and backs off when the server says
 * slow_down.
 */
import { MIN_POLL_INTERVAL_MS, type AlphaApi } from "./alphaApi";

export type DeviceFlowFailure = "denied" | "expired" | "revoked";

export class DeviceFlowError extends Error {
  readonly outcome: DeviceFlowFailure;
  constructor(outcome: DeviceFlowFailure, message: string) {
    super(message);
    this.name = "DeviceFlowError";
    this.outcome = outcome;
  }
}

export interface DeviceFlowIo {
  print(line: string): void;
  /** Invoked once with the clean approval URL when --open-browser was given. */
  openBrowser?: (url: string) => void;
}

export interface DeviceFlowDeps {
  api: AlphaApi;
  io: DeviceFlowIo;
  releaseId: string;
  openBrowser: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface DeviceFlowResult {
  readonly credential: string;
  readonly scopes: readonly string[];
}

export async function runDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceFlowResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const { api, io } = deps;

  const start = await api.deviceStart(deps.releaseId);
  const expiresInMinutes = Math.max(1, Math.round((start.expiresAt - now()) / 60_000));
  io.print("Sign in to Successor");
  io.print(`  1. On any device, open ${api.connectUrl}`);
  io.print(`  2. Enter this code: ${start.userCode}`);
  io.print(`The code expires in about ${expiresInMinutes} minute${expiresInMinutes === 1 ? "" : "s"}. Waiting for approval — Ctrl+C cancels.`);
  if (deps.openBrowser && io.openBrowser) {
    io.openBrowser(api.connectUrl);
    io.print(`Opened ${api.connectUrl} in this machine's browser.`);
  }

  let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, start.pollIntervalMs);
  let saidSlowDown = false;
  for (;;) {
    await sleep(intervalMs);
    if (now() >= start.expiresAt) {
      throw new DeviceFlowError("expired", "The code expired before approval. Run `successor-tui login` again for a fresh one.");
    }
    const poll = await api.devicePoll(start.deviceCode);
    switch (poll.status) {
      case "pending":
      case "approved":
        continue;
      case "slow_down":
        intervalMs = Math.max(MIN_POLL_INTERVAL_MS, poll.retryAfterMs ?? intervalMs + MIN_POLL_INTERVAL_MS);
        if (!saidSlowDown) {
          io.print("The server asked for a slower poll. Still waiting.");
          saidSlowDown = true;
        }
        continue;
      case "exchanged":
        io.print("Approved. This computer is connected to your account.");
        return { credential: poll.credential!, scopes: poll.scopes ?? [] };
      case "denied":
        throw new DeviceFlowError("denied", "Sign-in was declined in the browser. Nothing was stored.");
      case "revoked":
        throw new DeviceFlowError("revoked", "This sign-in attempt was revoked. Run `successor-tui login` to start a new one.");
      case "expired":
        throw new DeviceFlowError("expired", "The code expired before approval. Run `successor-tui login` again for a fresh one.");
    }
  }
}
