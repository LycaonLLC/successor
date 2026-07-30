import { actorNameplateFillStyle } from "@successor/client/src/slice-core/actorPresentationSystem";
import type {
  ActorSnapshot,
  ActorTargetSummary,
  PlayState,
  ServerAuthorityActorState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import type { ActorVitals } from "@successor/client/src/slice-core/combatTypes";
import { actorTargetSummary, serverOnlyActorFallbackSprite } from "@successor/client/src/slice-core/selectionSystem";
import { InventoryModelRenderer } from "./modelRenderer";
import type { RenderActor } from "../../render/pawns";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windows/windowManager";

import { TARGET_EXAMINE_WINDOW_ID, targetExamineActorAvailable } from "./targetExamineWindowIds";
export { TARGET_EXAMINE_WINDOW_ID, targetExamineActorAvailable };

const EMPTY_STATE_TEXT = "TARGET LOST";
const VITAL_LABELS = ["health", "action", "spirit"] as const satisfies ReadonlyArray<keyof ActorVitals>;

interface ExaminedActor {
  snapshot: ActorSnapshot;
  previewActor: RenderActor;
  serverActor: ServerAuthorityActorState | null;
}

export function createTargetExamineWindowDefinition(): WindowDefinition {
  return {
    id: TARGET_EXAMINE_WINDOW_ID,
    title: "TARGET EXAMINE",
    icon: "examine",
    hotkey: null,
    minWidth: 280,
    minHeight: 390,
    dockVisible: false,
    transient: true,
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = 318;
      const h = Math.min(520, Math.max(420, Math.round(viewport.h * 0.58)));
      const x = Math.max(12, viewport.w - w - 24);
      const y = Math.max(52, Math.round(viewport.h * 0.16));
      return { x, y, w, h };
    },
    mount: (contentRoot, ctx) => mountTargetExamineContent(contentRoot, ctx),
  };
}


function mountTargetExamineContent(contentRoot: HTMLElement, ctx: WindowContext): WindowContentHandle {
  const root = document.createElement("div");
  root.className = "txm-root";
  root.innerHTML = `
    <div class="txm-model" data-ref="model" aria-label="Target preview"></div>
    <section class="txm-card" data-ref="info">
      <header class="txm-head">
        <span class="txm-name" data-ref="name">—</span>
        <span class="txm-stamp" data-ref="stamp" hidden></span>
      </header>
      <div class="txm-subtitle" data-ref="subtitle">—</div>
      <div class="txm-row">
        <span class="txm-attitude" data-ref="attitude">—</span>
        <span class="txm-life" data-ref="life">—</span>
      </div>
      <div class="txm-vitals" data-ref="vitals"></div>
      <div class="txm-grid">
        <span>RANGE</span><strong data-ref="range">—</strong>
        <span>FACTION</span><strong data-ref="faction">—</strong>
      </div>
      <div class="txm-statuses" data-ref="statuses"></div>
    </section>
    <div class="txm-empty" data-ref="empty" hidden>${EMPTY_STATE_TEXT}</div>
  `;
  contentRoot.appendChild(root);

  const modelEl = ref(root, "model");
  const infoEl = ref(root, "info");
  const nameEl = ref(root, "name");
  const stampEl = ref(root, "stamp");
  const subtitleEl = ref(root, "subtitle");
  const attitudeEl = ref(root, "attitude");
  const lifeEl = ref(root, "life");
  const vitalsEl = ref(root, "vitals");
  const rangeEl = ref(root, "range");
  const factionEl = ref(root, "faction");
  const statusesEl = ref(root, "statuses");
  const emptyEl = ref(root, "empty");

  const modelRenderer = InventoryModelRenderer.create(modelEl, {
    state: ctx.state,
    paperDoll: false,
    actorPreview: true,
    actorPreviewDragHost: modelEl,
  });
  const vitalEls = new Map<keyof ActorVitals, { fill: HTMLElement; value: HTMLElement }>();
  for (const vital of VITAL_LABELS) {
    const row = document.createElement("div");
    row.className = "txm-vital";
    row.dataset.vital = vital;
    row.innerHTML = `
      <span class="txm-vital-label">${vital}</span>
      <span class="txm-vital-track"><span class="txm-vital-fill" data-ref="fill"></span></span>
      <span class="txm-vital-value" data-ref="value">—</span>
    `;
    vitalsEl.appendChild(row);
    vitalEls.set(vital, {
      fill: row.querySelector<HTMLElement>(`[data-ref="fill"]`)!,
      value: row.querySelector<HTMLElement>(`[data-ref="value"]`)!,
    });
  }

  const applied = {
    empty: false,
    name: "\0",
    color: "\0",
    stamp: "\0",
    subtitle: "\0",
    attitude: "\0",
    attitudeKind: "\0",
    life: "\0",
    range: "\0",
    faction: "\0",
    group: "\0",
    statuses: "\0",
    vitals: new Map<keyof ActorVitals, string>(),
  };

  let disposed = false;

  const showEmpty = (empty: boolean): void => {
    if (applied.empty === empty) return;
    applied.empty = empty;
    emptyEl.hidden = !empty;
    infoEl.style.visibility = empty ? "hidden" : "visible";
    modelEl.style.visibility = empty ? "hidden" : "visible";
  };

  return {
    update(dtSeconds: number, timeMs: number): void {
      const resolved = resolveExaminedActor(ctx.state, ctx.slice);
      if (!resolved) {
        showEmpty(true);
        modelRenderer.renderActorPreview({ open: false, actorId: null, actor: null, state: ctx.state, slice: ctx.slice }, dtSeconds, timeMs);
        return;
      }
      showEmpty(false);
      const summary = actorTargetSummary(resolved.snapshot, ctx.state, ctx.slice);
      const dead = summary.statuses.some((status) => status.id === "dead") || summary.lifeState !== "alive";
      const nameColor = actorNameplateFillStyle(resolved.snapshot, dead, ctx.slice, ctx.state) ?? "";
      publishText(nameEl, "name", summary.name);
      if (applied.color !== nameColor) {
        applied.color = nameColor;
        nameEl.style.color = nameColor;
      }

      const stamp = summary.lifeState === "alive" ? "" : (dead ? "DEAD" : "DOWN");
      if (applied.stamp !== stamp) {
        applied.stamp = stamp;
        stampEl.hidden = stamp === "";
        stampEl.textContent = stamp;
      }

      publishText(subtitleEl, "subtitle", subtitleFor(resolved.snapshot, resolved.serverActor, summary));
      // Attitude chip only when the actor HAS an AI attitude — "UNKNOWN"/"SELF"
      // placeholders are dev copy, not player information.
      const attitude = resolved.serverActor?.aiAttitude ?? resolved.snapshot.aiAttitude ?? null;
      attitudeEl.hidden = attitude === null;
      publishText(attitudeEl, "attitude", attitude ? attitude.toUpperCase() : "");
      if (applied.attitudeKind !== attitude) {
        applied.attitudeKind = attitude ?? "";
        if (attitude) attitudeEl.dataset.attitude = attitude;
        else delete attitudeEl.dataset.attitude;
      }
      publishText(lifeEl, "life", lifeText(summary, resolved.serverActor));
      publishVitals(summary.vitals, summary.maxVitals);
      publishText(rangeEl, "range", rangeText(ctx.state, ctx.slice, resolved));
      publishText(factionEl, "faction", factionLabel(ctx.slice, resolved.serverActor?.factionId ?? resolved.snapshot.factionId));
      publishStatuses(summary.statuses.map((status) => status.label.toUpperCase()));
      modelRenderer.renderActorPreview({
        open: true,
        actorId: resolved.snapshot.id,
        actor: resolved.previewActor,
        state: ctx.state,
        slice: ctx.slice,
      }, dtSeconds, timeMs);
    },
    onResized(): void {
      // The preview renderer owns a full-host canvas and samples dimensions every update.
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      modelRenderer.dispose();
      root.remove();
    },
  };

  function publishText(el: HTMLElement, key: "name" | "subtitle" | "attitude" | "life" | "range" | "faction" | "group", text: string): void {
    if (applied[key] === text) return;
    applied[key] = text;
    el.textContent = text;
  }

  function publishVitals(vitals: ActorVitals, maxVitals: ActorVitals): void {
    for (const vital of VITAL_LABELS) {
      const max = Math.max(0, maxVitals[vital]);
      const current = Math.max(0, vitals[vital]);
      const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((current / max) * 100))) : 0;
      const text = max > 0 ? `${Math.round(current)}/${Math.round(max)}` : "—";
      const key = `${pct}:${text}`;
      if (applied.vitals.get(vital) === key) continue;
      applied.vitals.set(vital, key);
      const parts = vitalEls.get(vital)!;
      parts.fill.style.width = `${pct}%`;
      parts.fill.parentElement?.toggleAttribute("data-low", pct <= 25);
      parts.value.textContent = text;
    }
  }

  function publishStatuses(statuses: string[]): void {
    const key = statuses.join("\0");
    if (applied.statuses === key) return;
    applied.statuses = key;
    statusesEl.textContent = "";
    for (let i = 0; i < statuses.length && i < 5; i += 1) {
      const chip = document.createElement("span");
      chip.className = "txm-status";
      chip.textContent = statuses[i]!;
      statusesEl.appendChild(chip);
    }
  }
}

function resolveExaminedActor(state: PlayState, slice: SliceSnapshot): ExaminedActor | null {
  const actorId = state.examineActorId;
  if (!actorId) return null;
  const localActor = slice.actors.find((actor) => actor.id === actorId) ?? null;
  const serverActor = state.serverAuthority.enabled ? state.serverAuthority.actors[actorId] ?? null : null;
  const serverAuthoritative = state.serverAuthority.connected
    || state.serverAuthority.receivedSnapshots > 0
    || state.serverAuthority.sourceMatchesClient === true;
  // Streamed actors that left the AOI have no local snapshot either — bail.
  // Fixture-local NPCs (camp trainer) never enter serverAuthority.actors, so
  // they fall through to the local-actor path below instead of a dead pane.
  if (serverAuthoritative && !serverActor && !localActor) return null;
  if (serverActor) {
    return {
      serverActor,
      previewActor: serverActor,
      snapshot: {
        id: actorId,
        entity: localActor?.entity ?? `server:${actorId}`,
        areaId: serverActor.areaId,
        label: serverActor.label,
        guildTag: serverActor.playerOrganizationTag ?? localActor?.guildTag ?? null,
        role: localActor?.role ?? (actorId === state.playerActorId ? "player" : "remote_actor"),
        professionIds: localActor?.professionIds,
        skillBoxIds: localActor?.skillBoxIds,
        factionId: serverActor.factionId ?? localActor?.factionId ?? null,
        socialGroup: serverActor.socialGroup ?? localActor?.socialGroup ?? null,
        pvpStatus: serverActor.pvpStatus ?? localActor?.pvpStatus ?? null,
        aiAttitude: serverActor.aiAttitude ?? localActor?.aiAttitude,
        playerOrganizationId: serverActor.playerOrganizationId ?? localActor?.playerOrganizationId ?? null,
        playerOrganizationTag: serverActor.playerOrganizationTag ?? localActor?.playerOrganizationTag ?? null,
        sprite: localActor?.sprite ?? serverActor.sprite ?? serverOnlyActorFallbackSprite(),
        poseSet: localActor?.poseSet ?? "idle",
        direction: serverActor.direction,
        cell: { x: serverActor.x, y: serverActor.y },
        route: [],
        vitals: serverActor.vitals,
        maxVitals: serverActor.maxVitals,
      },
    };
  }
  if (!localActor || (localActor.id !== slice.camera.followActor && localActor.areaId !== state.activeAreaId)) return null;
  return { snapshot: localActor, previewActor: localActor, serverActor: null };
}

/**
 * Player-language subtitle. Raw role ids are dev copy (owner: "remote actor
 * what the hell that means") — only roles with a real display noun render;
 * everything else leans on the label / profession title, which players read.
 */
const ROLE_DISPLAY: Record<string, string> = {
  player: "PLAYER",
  profession_trainer: "TRAINER",
};

/**
 * Faction display: authored slice label first ("Desert Wardens"), spaced
 * id as fallback — raw snake_case ids never reach the player.
 */
function factionLabel(slice: SliceSnapshot, factionId: string | null | undefined): string {
  if (!factionId) return "—";
  const label = slice.factions?.find((faction) => faction.id === factionId)?.label ?? null;
  return (label ?? factionId.replaceAll("_", " ")).toUpperCase();
}

function subtitleFor(actor: ActorSnapshot, serverActor: ServerAuthorityActorState | null, summary: ActorTargetSummary): string {
  const parts: string[] = [];
  const roleDisplay = actor.role ? ROLE_DISPLAY[actor.role] ?? null : null;
  if (roleDisplay) parts.push(roleDisplay);
  const label = serverActor?.label ?? actor.label;
  if (label && label !== summary.name) parts.push(label);
  const title = serverActor?.activeTitle?.label ?? serverActor?.professions?.[0]?.label ?? null;
  if (title) {
    parts.push(title.toUpperCase());
  } else {
    const professionIds = actor.professionIds ?? [];
    if (professionIds.length > 0) parts.push(professionIds[0]!.replaceAll("_", " ").toUpperCase());
  }
  const guild = serverActor?.playerOrganizationTag ?? actor.guildTag ?? actor.playerOrganizationTag ?? null;
  if (guild) parts.push(`<${guild}>`);
  return parts.length > 0 ? parts.join(" · ") : "UNKNOWN CONTACT";
}

function lifeText(summary: ActorTargetSummary, serverActor: ServerAuthorityActorState | null): string {
  if (summary.lifeState === "alive") return serverActor?.inCombat ? "IN COMBAT" : "ALIVE";
  return summary.lifeState.toUpperCase();
}

function rangeText(state: PlayState, slice: SliceSnapshot, resolved: ExaminedActor): string {
  const player = state.serverAuthority.actors[state.playerActorId] ?? null;
  const playerCell = player ? { x: player.x, y: player.y } : slice.actors.find((actor) => actor.id === state.playerActorId)?.cell ?? null;
  if (!playerCell) return "—";
  const actorCell = resolved.serverActor ? { x: resolved.serverActor.x, y: resolved.serverActor.y } : resolved.snapshot.cell;
  const distance = Math.hypot(actorCell.x - playerCell.x, actorCell.y - playerCell.y);
  return `${distance.toFixed(distance < 10 ? 1 : 0)}m`;
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`target examine window: missing data-ref="${name}"`);
  return el;
}
