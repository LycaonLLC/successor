import type { LaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import type { WindowManager } from "../ui/windows/windowManager";

interface CapturedRuntimeError {
  readonly kind: "error" | "unhandled_rejection";
  readonly atMs: number;
  readonly message: string;
  readonly source?: string;
  readonly line?: number;
  readonly column?: number;
  readonly stack?: string;
}

const runtimeErrors: CapturedRuntimeError[] = [];
let sessionStartedAt = Date.now();

const bearerPattern = /\bBearer\s+[A-Za-z0-9._~-]{16,}/giu;
const querySecretPattern = /([?&](?:chatTicket|csrf(?:Token)?|gameTicket|ticket|token)=)[^&\s]+/giu;

export function installBugReportErrorCapture(): () => void {
  runtimeErrors.length = 0;
  sessionStartedAt = Date.now();
  const onError = (event: ErrorEvent): void => {
    rememberError({
      kind: "error",
      atMs: Date.now(),
      message: safeText(event.message),
      ...(event.filename ? { source: safePath(event.filename) } : {}),
      ...(event.lineno > 0 ? { line: event.lineno } : {}),
      ...(event.colno > 0 ? { column: event.colno } : {}),
      ...(event.error instanceof Error && event.error.stack
        ? { stack: safeText(event.error.stack, 1_200) }
        : {}),
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    rememberError({
      kind: "unhandled_rejection",
      atMs: Date.now(),
      message: safeText(reason instanceof Error ? reason.message : String(reason)),
      ...(reason instanceof Error && reason.stack ? { stack: safeText(reason.stack, 1_200) } : {}),
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

export function collectBugReportDiagnostics(
  state: PlayState,
  slice: SliceSnapshot,
  launchIdentity: LaunchIdentity,
  windows: Pick<WindowManager, "openWindowIds">,
): Record<string, unknown> {
  const authorityActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const actor = state.serverAuthority.actors[authorityActorId] ?? null;
  const probe = window.__successor3d;
  const deviceNavigator = navigator as Navigator & { deviceMemory?: number };
  return {
    schema: "successor.bug-report-diagnostics.v1",
    collectedAt: Date.now(),
    clientUptimeMs: Math.max(0, Date.now() - sessionStartedAt),
    client: {
      clientReleaseId: launchIdentity.clientReleaseId ?? "unknown",
      serverReleaseId: launchIdentity.serverReleaseId ?? "unknown",
      standalone: launchIdentity.standalone === true,
      path: window.location.pathname.slice(0, 256),
      userAgent: safeText(navigator.userAgent, 512),
      platform: safeText(navigator.platform, 128),
      language: navigator.language.slice(0, 32),
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemoryGiB: deviceNavigator.deviceMemory ?? null,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: round(window.devicePixelRatio),
      visibility: document.visibilityState,
    },
    world: {
      sliceTick: slice.tick,
      authorityTick: state.serverAuthority.snapshotTick,
      areaId: actor?.areaId ?? state.activeAreaId,
      position: {
        x: round(actor?.x ?? state.player.x),
        y: round(actor?.y ?? state.player.y),
      },
      facing: actor?.direction ?? state.facing,
      lifeState: actor?.lifeState ?? null,
      selectedActorId: state.selectedActorId,
      interactionId: state.interactions.options[state.interactions.selectedIndex]?.id ?? null,
      weaponId: actor?.weapon?.weaponId ?? state.loadout.activeWeaponId,
      vitals: actor ? { ...actor.vitals } : null,
      maxVitals: actor ? { ...actor.maxVitals } : null,
    },
    authority: {
      connected: state.serverAuthority.connected,
      status: state.serverAuthority.status,
      sourceMatchesClient: state.serverAuthority.sourceMatchesClient,
      sourceStateHash: state.serverAuthority.sourceStateHash,
      receivedPackets: state.serverAuthority.receivedPackets,
      receivedSnapshots: state.serverAuthority.receivedSnapshots,
      acceptedCommands: state.serverAuthority.acceptedCommands,
      rejectedCommands: state.serverAuthority.rejectedCommands,
      lastPacketType: state.serverAuthority.lastPacketType,
      lastSnapshotAgeMs: state.serverAuthority.lastSnapshotReceivedAtMs === null
        ? null
        : round(Math.max(0, performance.now() - state.serverAuthority.lastSnapshotReceivedAtMs)),
      predictionErrorCells: round(state.serverAuthority.predictionErrorCells),
      maxPredictionErrorCells: round(state.serverAuthority.maxPredictionErrorCells),
    },
    recentCommands: state.serverAuthority.sentCommandLog.slice(-16).map((entry) => ({
      commandId: entry.commandId,
      kind: entry.kind,
      sentAtMs: round(entry.sentAtMs),
      issuedAtTick: entry.issuedAtTick ?? null,
      propId: entry.propId ?? null,
      targetActorId: entry.targetActorId ?? null,
    })),
    recentReceipts: state.serverAuthority.receiptLog.slice(-16).map((entry) => ({
      commandId: entry.commandId,
      accepted: entry.accepted,
      tick: entry.tick,
      reasonCode: entry.reasonCode ?? null,
      receivedAtMs: round(entry.receivedAtMs),
    })),
    recentMoveRejections: (state.serverAuthority.recentMoveRejections ?? [])
      .filter((entry) => entry.commandId > 0)
      .slice(-8)
      .map((entry) => ({
        commandId: entry.commandId,
        reasonCode: entry.reasonCode,
        tick: entry.serverTick,
      })),
    input: {
      mouse: { ...state.settings.mouse },
      bindings: Object.fromEntries(
        Object.entries(state.settings.bindings).map(([action, codes]) => [action, [...codes]]),
      ),
    },
    ui: {
      openWindows: [...windows.openWindowIds()],
      status: safeText(state.status, 512),
    },
    renderer: probe ? {
      fps: round(probe.fps),
      visibleActors: probe.actorCount,
      hiFiActors: probe.lodHiFiActors,
      simulationActors: probe.lodSimActors,
      renderDriftMaxCells: round(probe.renderDriftMaxCells),
      renderDriftActors: probe.renderDriftActors,
      inventoryRows: probe.inventoryPlayerRows,
      weather: probe.weather,
    } : null,
    runtimeErrors: runtimeErrors.slice(-4),
  };
}

function rememberError(error: CapturedRuntimeError): void {
  runtimeErrors.push(error);
  if (runtimeErrors.length > 24) runtimeErrors.splice(0, runtimeErrors.length - 24);
}

function safeText(value: string, max = 500): string {
  return value
    .slice(0, max)
    .replace(bearerPattern, "Bearer [redacted]")
    .replace(querySecretPattern, "$1[redacted]");
}

function safePath(value: string): string {
  try {
    return new URL(value, window.location.origin).pathname.slice(0, 512);
  } catch {
    return safeText(value, 512);
  }
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : 0;
}
