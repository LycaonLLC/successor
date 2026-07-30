import {
  consumeStandaloneLaunchContext,
  validateStandaloneLaunchContext,
  validateStandaloneLaunchMessage,
  type EphemeralLaunchCapabilities,
  type LaunchContextValidationOptions,
  type StandaloneLaunchContextV1,
} from "@successor/client/src/runtime/launchContext";

export interface HostedLegacyLaunchMessage {
  type: "successor.launch.v1";
  mode: "legacy";
  launch: {
    ticket: string;
    player?: { id?: string; displayName?: string; zoneId?: string };
    runtime?: { gameWsUrl?: string };
    character?: { id?: string; name?: string };
  };
}

export interface HostedStandaloneLaunchMessage {
  type: "successor.launch.v1";
  launch: StandaloneLaunchContextV1;
  capabilities: EphemeralLaunchCapabilities;
}

export type HostedLaunchMessage = HostedLegacyLaunchMessage | HostedStandaloneLaunchMessage;
export type StandaloneLaunchFailureReason =
  | "invalid"
  | "expired"
  | "rejected"
  | "timeout"
  | "game-failed"
  | "chat-failed"
  | "session-replaced";
export const HOSTED_EXIT_WORLD_REQUEST_TYPE = "successor.client.exit-world.v1";
export const HOSTED_EXIT_WORLD_RESULT_TYPE = "successor.client.exit-world-result.v1";

/**
 * Trusted-desktop launch bridge (Electron preload, desktop/src/preload.cjs).
 * The desktop main process arms one launch envelope for this window right
 * before loading the game page; takeHostedLaunch() releases it exactly once
 * over context-isolated IPC. No ticket ever rides a URL or postMessage here.
 */
interface TrustedDesktopLaunchBridge {
  isDesktopShell?: boolean;
  takeHostedLaunch?: () => Promise<unknown>;
  hostedLaunchFailed?: (reason: string) => unknown;
}

function trustedDesktopBridge(): TrustedDesktopLaunchBridge | null {
  const candidate: unknown = globalThis.__successorDesktop;
  if (!candidate || typeof candidate !== "object") return null;
  // Preload-injected bridge (desktop/src/preload.cjs); every method is
  // runtime-checked before use, so the assertion only names the shape.
  const bridge = candidate as TrustedDesktopLaunchBridge;
  return bridge;
}

export async function takeTrustedDesktopLaunch(): Promise<HostedStandaloneLaunchMessage | null> {
  const bridge = trustedDesktopBridge();
  if (typeof bridge?.takeHostedLaunch !== "function") return null;
  let raw: unknown = null;
  try {
    raw = await bridge.takeHostedLaunch();
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  const options: LaunchContextValidationOptions = {
    clientReleaseId: import.meta.env.SUCCESSOR_CLIENT_RELEASE_ID || undefined,
    serverReleaseId: import.meta.env.SUCCESSOR_SERVER_RELEASE_ID || undefined,
    gameOrigin: import.meta.env.SUCCESSOR_GAME_ORIGIN || undefined,
    chatOrigin: import.meta.env.SUCCESSOR_CHAT_ORIGIN || undefined,
  };
  const message = validateStandaloneLaunchMessage(raw, options);
  const capabilities = message ? consumeStandaloneLaunchContext(message.launch, options) : null;
  if (!message || !capabilities) {
    notifyHostedLaunchFailure("invalid");
    return null;
  }
  return { ...message, capabilities };
}

export function validateHostedLaunchMessage(
  value: unknown,
  expectedReleaseIdOrOptions: string | LaunchContextValidationOptions = "",
): HostedLegacyLaunchMessage | { type: "successor.launch.v1"; launch: StandaloneLaunchContextV1 } | null {
  if (!isPlainRecord(value) || value.type !== "successor.launch.v1") return null;
  if (value.mode === "legacy") {
    if (!isPlainRecord(value.launch) || typeof value.launch.ticket !== "string" || !value.launch.ticket.trim()) return null;
    return value as unknown as HostedLegacyLaunchMessage;
  }
  const options = typeof expectedReleaseIdOrOptions === "string"
    ? { clientReleaseId: expectedReleaseIdOrOptions || undefined }
    : expectedReleaseIdOrOptions;
  const launch = validateStandaloneLaunchContext(value.launch, options);
  return launch ? { type: "successor.launch.v1", launch } : null;
}

export function waitForParentLaunch(timeoutMs = 20_000): Promise<HostedLaunchMessage | null> {
  if (typeof window === "undefined" || window.parent === window) return Promise.resolve(null);
  const expectedOrigin = import.meta.env.SUCCESSOR_STOREFRONT_ORIGIN;
  if (!expectedOrigin) return Promise.reject(new Error("Successor storefront origin is not configured"));
  const validationOptions = {
    clientReleaseId: import.meta.env.SUCCESSOR_CLIENT_RELEASE_ID || undefined,
    serverReleaseId: import.meta.env.SUCCESSOR_SERVER_RELEASE_ID || undefined,
    gameOrigin: import.meta.env.SUCCESSOR_GAME_ORIGIN || undefined,
    chatOrigin: import.meta.env.SUCCESSOR_CHAT_ORIGIN || undefined,
  } satisfies LaunchContextValidationOptions;
  const releaseId = validationOptions.clientReleaseId;
  const ready = () => window.parent.postMessage({ type: "successor.client.ready.v1", releaseId }, expectedOrigin);
  ready();
  return new Promise<HostedLaunchMessage | null>((resolve, reject) => {
    let settled = false;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== expectedOrigin) return;
      if (!isPlainRecord(event.data) || event.data.mode === "legacy") {
        const legacy = validateHostedLaunchMessage(event.data, validationOptions);
        if (legacy && "mode" in legacy) finish(() => resolve(legacy));
        return;
      }
      const value = validateStandaloneLaunchMessage(event.data, validationOptions);
      if (!value) return;
      const capabilities = consumeStandaloneLaunchContext(value.launch, validationOptions);
      if (!capabilities) return;
      finish(() => resolve({ ...value, capabilities }));
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      clearInterval(retry);
      fn();
    };
    const retry = setInterval(ready, 2_000);
    const timer = setTimeout(() => finish(() => reject(new Error("Timed out waiting for Successor launch"))), timeoutMs);
    window.addEventListener("message", onMessage);
  });
}

export function notifyHostedLaunchFailure(reason: StandaloneLaunchFailureReason): void {
  if (typeof window === "undefined") return;
  const bridge = trustedDesktopBridge();
  if (typeof bridge?.hostedLaunchFailed === "function") {
    try {
      void bridge.hostedLaunchFailed(reason);
    } catch {
      // The desktop main process owns recovery; nothing else to do here.
    }
    return;
  }
  if (window.parent === window) return;
  const origin = import.meta.env.SUCCESSOR_STOREFRONT_ORIGIN;
  if (!origin) return;
  window.parent.postMessage({ type: "successor.launch.failed.v1", reason }, origin);
}

/**
 * Exact-origin parent request used when the storefront changes characters
 * without navigating away. The callback owns the game-authority clean exit
 * and resolves only after the server has closed that session (or the bounded
 * confirmation wait has failed).
 */
export function installParentExitWorldHandler(
  exitWorld: () => boolean | Promise<boolean>,
): () => void {
  if (typeof window === "undefined" || window.parent === window) return () => undefined;
  const expectedOrigin = import.meta.env.SUCCESSOR_STOREFRONT_ORIGIN;
  if (!expectedOrigin) return () => undefined;
  let disposed = false;
  let running = false;
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (disposed || running || event.source !== window.parent || event.origin !== expectedOrigin) return;
    if (
      !isPlainRecord(event.data)
      || event.data.type !== HOSTED_EXIT_WORLD_REQUEST_TYPE
      || Object.keys(event.data).length !== 1
    ) {
      return;
    }
    running = true;
    void Promise.resolve()
      .then(exitWorld)
      .then((ok) => {
        if (!disposed) {
          window.parent.postMessage(
            { type: HOSTED_EXIT_WORLD_RESULT_TYPE, ok: ok === true },
            expectedOrigin,
          );
        }
      })
      .catch(() => {
        if (!disposed) {
          window.parent.postMessage(
            { type: HOSTED_EXIT_WORLD_RESULT_TYPE, ok: false },
            expectedOrigin,
          );
        }
      })
      .finally(() => {
        running = false;
      });
  };
  window.addEventListener("message", onMessage);
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("message", onMessage);
  };
}

export interface StandaloneLaunchCoordinator {
  gameAccepted: () => void;
  chatAccepted: () => void;
  gameFailed: (reason?: StandaloneLaunchFailureReason) => void;
  chatFailed: (reason?: StandaloneLaunchFailureReason) => void;
  close: () => void;
}

export function createStandaloneLaunchCoordinator(options: {
  closeGame: () => void;
  closeChat: () => void;
  notifyFailure?: (reason: StandaloneLaunchFailureReason) => void;
  onFailure?: (reason: StandaloneLaunchFailureReason) => void;
}): StandaloneLaunchCoordinator {
  let failed = false;
  let closed = false;
  const fail = (reason: StandaloneLaunchFailureReason) => {
    if (failed || closed) return;
    failed = true;
    options.closeGame();
    options.closeChat();
    options.notifyFailure?.(reason);
    options.onFailure?.(reason);
  };
  return {
    gameAccepted: () => undefined,
    chatAccepted: () => undefined,
    gameFailed: (reason = "game-failed") => fail(reason),
    chatFailed: (reason = "chat-failed") => fail(reason),
    close: () => {
      if (closed) return;
      closed = true;
      options.closeGame();
      options.closeChat();
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
