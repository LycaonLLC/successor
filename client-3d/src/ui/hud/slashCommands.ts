import { createVerbRegistry, type VerbRegistry } from "@successor/client/src/slice-core/verbRegistry/index";
import { getLaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import { sendExitWorld } from "@successor/client/src/slice-core/gameAuthoritySystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { canonicalSurveyFamily } from "../survey/store";
import { createWaypoint, defaultWaypointName } from "../waypoints/store";

/**
 * GAMEPLAY slash commands — the CLI face of GUI-first verbs (owner ruling:
 * established sandbox-style `/command` parity, GUI remains the primary implementation).
 *
 * Resolution order (mirrors client-tui/src/commands.ts — one dispatch layer):
 *   1. Macro overlay (`/macro run|stop|list`, `/dump`) via the injected
 *      `macroLine` front — the registry has no client-verb extension point.
 *   2. The shared verb registry (authority / local / query verbs).
 *   3. null → the line falls through to the chat parser untouched.
 *
 * Scope is deliberately narrow: only commands that enqueue AUTHORITY
 * commands (plus the macro overlay) live here. Chat-service commands
 * (`/who`, channel ops, …) stay in the shared chatClient parser.
 */

export interface SlashCommandRouter {
  /**
   * Try a chat input line. Returns the local echo string when the line was
   * a gameplay command (already dispatched), or null to fall through to
   * the normal chat path.
   */
  handle(line: string): string | null;
  /** The registry instance — shared with the macro engine host. */
  readonly registry: VerbRegistry;
}

export interface SlashCommandRouterOptions {
  openWindow?: (id: string) => void;
  knownWindowIds?: readonly string[];
  /** Macro overlay front: non-null echo consumes the line before the registry. */
  macroLine?: (line: string) => string | null;
  /** TRADE window front (`/trade` / `/trade <name>` open the secure table);
   *  richer grammar returns null and reaches the curated ProposeTrade verb. */
  tradeLine?: (line: string) => string | null;
  /** Support form front: `/bugreport` opens the identity-bound report window. */
  bugReportLine?: (line: string) => string | null;
}

export function createSlashCommandRouter(
  state: PlayState,
  slice: SliceSnapshot,
  options: SlashCommandRouterOptions = {},
): SlashCommandRouter {
  const registry = createVerbRegistry({
    state,
    slice,
    canonicalResourceFamily: canonicalSurveyFamily,
    openWindow: options.openWindow,
    knownWindowIds: options.knownWindowIds,
    createWaypoint,
    defaultWaypointName,
    inventoryIdentity: launchInventoryIdentity(),
    exitToCharacterSelect: () => exitToCharacterSelect(state),
  });

  return {
    registry,
    handle(line: string): string | null {
      return options.bugReportLine?.(line)
        ?? options.tradeLine?.(line)
        ?? options.macroLine?.(line)
        ?? registry.executeLine(line)?.text
        ?? null;
    },
  };
}


function launchInventoryIdentity(): { playerId: string | null; characterId: string | null } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const identity = getLaunchIdentity();
    return { playerId: identity.playerId || null, characterId: identity.characterId ?? null };
  } catch {
    return undefined;
  }
}

/** Send exit_world, then return to character select via a clean page
 * transition (drops the baked identity/spawn params so the select screen
 * owns the next deployment). The shard closes the socket server-side and
 * saves/despawns the character without starting an LD hold. */
function exitToCharacterSelect(state: PlayState): string {
  const sent = sendExitWorld(state);
  window.setTimeout(() => {
    const url = new URL(window.location.href);
    for (const key of ["autoEnter", "player", "actorId", "name", "spawnArea", "spawnX", "spawnY", "facing", "characterId"]) {
      url.searchParams.delete(key);
    }
    window.location.assign(url.toString());
  }, 400);
  return sent ? "BREAKING CAMP — returning to character select" : "NO LINK — returning to character select";
}
