import {
  HostedAuthError,
  listCharacters,
  mintLaunchEnvelope,
  revokeDeviceCredential,
  runDevicePollLoop,
  startDeviceAuthorization,
} from "./hosted-auth.mjs";

/**
 * Hosted sign-in/character/launch state machine for the Electron MAIN process.
 *
 * Owns the device code and device credential in memory. Renderers only ever
 * see the snapshot() shape below — human user code, approval URL, stage, and
 * semantic notice kinds. The launch envelope leaves through armLaunch() into
 * the one-use IPC handoff, never through a snapshot, URL, or log line.
 *
 * Notice kinds are semantic; the shell renderer owns the player-facing words.
 */

const NOTICES = new Set([
  "denied",
  "expired",
  "revoked",
  "link-error",
  "characters-error",
  "launch-failed",
  "game-missing",
]);

export function createHostedSession({
  config,
  credentialStore,
  fetchImpl = globalThis.fetch,
  log = () => undefined,
  onState = () => undefined,
  armLaunch,
  disarmLaunch = () => undefined,
  navigateToGame,
  navigateToShell = () => undefined,
  openExternal,
  copyText,
  canLaunchGame = () => ({ ok: true }),
  now = Date.now,
  delay,
}) {
  let stage = "restoring";
  let notice = null;
  let link = null; // { userCode, expiresAt } — deviceCode stays in runLink scope
  let characters = null;
  let credential = null;
  let persisted = false;
  let linkAbort = null;
  let generation = 0;

  const approvalHost = new URL(config.connectUrl).host;

  function snapshot() {
    return {
      stage,
      notice,
      link: link ? { userCode: link.userCode, verificationUrl: config.connectUrl, expiresAt: link.expiresAt } : null,
      characters,
      persistAvailable: credentialStore.persistAvailable(),
      persisted,
      approvalHost,
    };
  }

  function setState(nextStage, nextNotice = null) {
    stage = nextStage;
    notice = nextNotice && NOTICES.has(nextNotice) ? nextNotice : null;
    log("hosted-stage", { stage, notice });
    onState(snapshot());
  }

  function cancelLinkAttempt() {
    if (linkAbort) {
      linkAbort.abort();
      linkAbort = null;
    }
    link = null;
  }

  async function loadRoster() {
    characters = await listCharacters({ fetchImpl, apiOrigin: config.apiOrigin, credential });
  }

  async function dropCredential({ revoke }) {
    const held = credential;
    credential = null;
    persisted = false;
    characters = null;
    await credentialStore.clear();
    if (revoke && held) await revokeDeviceCredential({ fetchImpl, apiOrigin: config.apiOrigin, credential: held });
  }

  async function handleUnauthorized() {
    // Account-side revoke (or account deletion): the stored link is dead.
    await dropCredential({ revoke: false });
    setState("signin", "revoked");
  }

  async function settleRoster() {
    try {
      await loadRoster();
      setState("characters");
      return true;
    } catch (error) {
      if (error instanceof HostedAuthError && error.code === "unauthorized") {
        await handleUnauthorized();
        return false;
      }
      setState("characters", "characters-error");
      return false;
    }
  }

  async function runLink(myGeneration, start, signal) {
    let outcome;
    try {
      outcome = await runDevicePollLoop({
        fetchImpl,
        apiOrigin: config.apiOrigin,
        deviceCode: start.deviceCode,
        pollIntervalMs: start.pollIntervalMs,
        expiresAt: start.expiresAt,
        signal,
        now,
        ...(delay ? { delay } : {}),
      });
    } catch (error) {
      outcome = { status: error instanceof HostedAuthError && error.code === "device_not_found" ? "expired" : "unreachable" };
    }
    if (myGeneration !== generation) return;
    linkAbort = null;
    link = null;
    log("hosted-link-outcome", { status: outcome.status });
    switch (outcome.status) {
      case "exchanged": {
        credential = outcome.credential;
        const saved = await credentialStore.save(credential);
        persisted = saved.persisted;
        await settleRoster();
        return;
      }
      case "denied": return setState("signin", "denied");
      case "expired": return setState("signin", "expired");
      case "revoked": return setState("signin", "revoked");
      case "cancelled": return setState("signin");
      default: return setState("signin", "link-error");
    }
  }

  const session = {
    snapshot,

    /** Startup restores a valid credential to the roster, never directly into the world. */
    async restore() {
      const stored = await credentialStore.load();
      if (!stored) {
        setState("signin");
        return;
      }
      credential = stored;
      persisted = true;
      try {
        await loadRoster();
      } catch (error) {
        if (error instanceof HostedAuthError && error.code === "unauthorized") {
          await handleUnauthorized();
          return;
        }
        // Keep the credential: the service may just be unreachable right now.
        setState("characters", "characters-error");
        return;
      }
      setState("characters");
    },

    async startLink() {
      if (stage === "linking" && link) return snapshot();
      cancelLinkAttempt();
      const myGeneration = ++generation;
      let start;
      try {
        start = await startDeviceAuthorization({
          fetchImpl,
          apiOrigin: config.apiOrigin,
          clientId: config.clientId,
          releaseId: config.releaseId,
          scopes: config.scopes,
        });
      } catch (error) {
        log("hosted-link-start-failed", { code: error instanceof HostedAuthError ? error.code : "unknown" });
        setState("signin", "link-error");
        return snapshot();
      }
      if (myGeneration !== generation) return snapshot();
      link = { userCode: start.userCode, expiresAt: start.expiresAt };
      linkAbort = new AbortController();
      setState("linking");
      void runLink(myGeneration, start, linkAbort.signal);
      return snapshot();
    },

    cancelLink() {
      generation += 1;
      cancelLinkAttempt();
      setState("signin");
      return snapshot();
    },

    async openApproval() {
      // Constant approval page — the code is typed by the player, never a URL.
      await openExternal(config.connectUrl);
      return snapshot();
    },

    copyCode() {
      if (link) copyText(link.userCode);
      return snapshot();
    },

    async refreshCharacters() {
      if (!credential) {
        setState("signin");
        return snapshot();
      }
      await settleRoster();
      return snapshot();
    },

    async enterWorld(characterId) {
      if (!credential || stage !== "characters") return snapshot();
      const known = Array.isArray(characters) && characters.some((row) => row.id === characterId);
      if (!known) return snapshot();
      const launchable = canLaunchGame();
      if (!launchable.ok) {
        setState("characters", "game-missing");
        return snapshot();
      }
      setState("launching");
      let envelope;
      try {
        envelope = await mintLaunchEnvelope({ fetchImpl, apiOrigin: config.apiOrigin, credential, characterId });
      } catch (error) {
        if (error instanceof HostedAuthError && error.code === "unauthorized") {
          await handleUnauthorized();
          return snapshot();
        }
        log("hosted-launch-mint-failed", { code: error instanceof HostedAuthError ? error.code : "unknown" });
        setState("characters", "launch-failed");
        return snapshot();
      }
      try {
        armLaunch(envelope);
        envelope = null;
        await navigateToGame();
        setState("in-world");
      } catch {
        disarmLaunch();
        setState("characters", "launch-failed");
      }
      return snapshot();
    },

    /** Return to character select after a renderer-side split-launch failure. */
    async handleLaunchFailure(reason) {
      log("hosted-launch-failed", { reason: String(reason).slice(0, 32) });
      disarmLaunch();
      setState("characters", "launch-failed");
      await navigateToShell();
      return snapshot();
    },

    async signOut() {
      generation += 1;
      cancelLinkAttempt();
      await dropCredential({ revoke: true });
      setState("signin");
      return snapshot();
    },

    dispose() {
      generation += 1;
      cancelLinkAttempt();
      credential = null;
    },

    /** Single narrow entry point for shell-control IPC. */
    async control(payload) {
      const op = payload && typeof payload === "object" ? payload.op : null;
      switch (op) {
        case "state": return snapshot();
        case "start-link": return session.startLink();
        case "cancel-link": return session.cancelLink();
        case "open-approval": return session.openApproval();
        case "copy-code": return session.copyCode();
        case "refresh-characters": return session.refreshCharacters();
        case "enter-world": return session.enterWorld(typeof payload.args?.characterId === "string" ? payload.args.characterId : "");
        case "sign-out": return session.signOut();
        default: return snapshot();
      }
    },
  };

  return session;
}
