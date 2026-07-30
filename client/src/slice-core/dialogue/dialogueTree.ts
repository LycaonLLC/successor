import type { PlayState, ServerAuthorityActorState, ServerAuthorityProfessionState, SliceSnapshot } from "../gameState";
import {
  professionTrainerById,
  professionTrainerInteractionRadiusCells,
} from "../professionTrainerSystem";
import {
  professionDefinitions,
  skillNodeDefinitions,
  type ProfessionId,
  type SkillNodeState,
} from "../progressionSystem";
import { cleanActorName } from "../actorNameSystem";
import { playerWithinExchangeInteractionRange } from "../interactionSystem";


/**
 * Dialogue trees — typed client-side conversation content (trainer-conversation pattern).
 *
 * Trees are STATIC data; option availability is a pure read over PlayState the
 * player already owns (professions, skill boxes, XP, SP, credits, held tools)
 * — visibility-law clean, no new streaming. Terminal leaves name REAL
 * authority commands; the converse window owns enqueueing them. The engine is
 * NPC-generic (quest NPCs later); trainer scripts are the first content.
 *
 * Copy contract: deny notes reuse the skills window's honest reason strings,
 * and server receipts stay the deny authority (`DENIED · reason`) — a tree can
 * only phrase, never invent, availability.
 */

// ── Context ────────────────────────────────────────────────────────────────

export interface DialogueNpc {
  actorId: string;
  label: string;
  /** Professions this NPC teaches (trainer content scope). */
  professionIds: readonly string[];
  distanceCells: number;
  /** Inside the shared 1.75-cell interaction radius (command-leaf gate). */
  inRange: boolean;
}

export interface DialogueCtx {
  state: PlayState;
  slice: SliceSnapshot;
  npc: DialogueNpc;
  /**
   * Player-owned container predicate (held-item visibility). Injected by the
   * hosting client — the 3D window wires the identity-aware inventory scope,
   * the TUI wires its own — so the engine stays dependency-pure and shareable
   * (TuiFable /converse reuses these exact trees).
   */
  isCarriedContainer(container: string): boolean;
}

export type DialogueText = string | ((ctx: DialogueCtx) => string);

// ── Actions (terminal leaves name real commands; the window wires them) ───

export type DialogueAction =
  | { kind: "goto"; nodeId: string }
  | { kind: "end" }
  | { kind: "train"; skillBoxId: string }
  | { kind: "careerGoal"; goalId: string }
  | { kind: "starterTool" }
  | { kind: "openWindow"; windowId: string };

export interface DialogueOption {
  id: string;
  /** The player's line. */
  label: DialogueText;
  /** Visibility — absent branches don't exist for this player/NPC. */
  when?: (ctx: DialogueCtx) => boolean;
  /** Honest deny note (disabled state); null = enabled. Hover-only copy. */
  gate?: (ctx: DialogueCtx) => string | null;
  action: DialogueAction;
}

export interface DialogueNode {
  id: string;
  /** NPC prose for this beat. */
  line: DialogueText;
  options: readonly DialogueOption[] | ((ctx: DialogueCtx) => readonly DialogueOption[]);
}

/** Per-persona receipt phrasing — server truth, in-character mouth. */
export interface DialogueVoice {
  trainAck(boxLabel: string): string;
  trainDeny(reasonCode: string): string;
  careerAck(goalLabel: string): string;
  careerDeny(reasonCode: string): string;
  toolAck(): string;
  toolDeny(reasonCode: string): string;
}

export interface DialogueTree {
  id: string;
  entry(ctx: DialogueCtx): string;
  nodes: Readonly<Record<string, DialogueNode>>;
  voice: DialogueVoice;
}

// ── Resolution (pure — the whole engine is testable without DOM) ──────────

export interface ResolvedOption {
  id: string;
  label: string;
  enabled: boolean;
  /** Honest reason when disabled. */
  note: string | null;
  action: DialogueAction;
}

export interface ResolvedNode {
  id: string;
  line: string;
  options: ResolvedOption[];
}

export function resolveText(text: DialogueText, ctx: DialogueCtx): string {
  return typeof text === "string" ? text : text(ctx);
}

export function resolveNode(tree: DialogueTree, nodeId: string, ctx: DialogueCtx): ResolvedNode {
  const node = tree.nodes[nodeId] ?? tree.nodes[tree.entry(ctx)];
  if (!node) throw new Error(`dialogue tree ${tree.id}: no node ${nodeId} and no entry`);
  const authored = typeof node.options === "function" ? node.options(ctx) : node.options;
  const options: ResolvedOption[] = [];
  for (const option of authored) {
    if (option.when && !option.when(ctx)) continue;
    const note = option.gate ? option.gate(ctx) : null;
    options.push({
      id: option.id,
      label: resolveText(option.label, ctx),
      enabled: note === null,
      note,
      action: option.action,
    });
  }
  return { id: node.id, line: resolveText(node.line, ctx), options };
}

// ── NPC resolution (trainer-backed; quest NPCs add their own resolver) ────

export function trainerDialogueNpc(state: PlayState, slice: SliceSnapshot, actorId: string | null | undefined): DialogueNpc | null {
  const candidate = professionTrainerById(slice, state, actorId);
  if (!candidate) return null;
  return {
    actorId: candidate.source.id,
    // Clean-name chain (C1): the portrait/footer never print the type read.
    label: cleanActorName(
      state.serverAuthority.actors[candidate.source.id] ?? { label: candidate.source.label },
      "Trainer",
    ),
    professionIds: candidate.source.professionIds ?? [],
    distanceCells: candidate.distanceCells,
    inRange: candidate.distanceCells <= professionTrainerInteractionRadiusCells,
  };
}

// ── Predicates (the availability library) ─────────────────────────────────

export function playerActor(state: PlayState): ServerAuthorityActorState | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  return state.serverAuthority.actors[actorId] ?? null;
}

function professionState(state: PlayState, professionId: string): ServerAuthorityProfessionState | null {
  const actor = playerActor(state);
  return (actor?.professions ?? []).find((profession) => profession.id === professionId) ?? null;
}

/** Trained set incl. the synthetic `<id>-novice` for learned tracks (skills-window rule). */
export function trainedSkillBoxes(state: PlayState): Set<string> {
  const trained = new Set<string>();
  const actor = playerActor(state);
  for (const profession of actor?.professions ?? []) {
    trained.add(`${profession.id}-novice`);
    for (const skillBoxId of profession.skillBoxes ?? []) trained.add(skillBoxId);
  }
  return trained;
}

export function professionLearned(state: PlayState, professionId: string): boolean {
  return professionState(state, professionId) !== null;
}

export function skillBoxTrained(state: PlayState, skillBoxId: string): boolean {
  return trainedSkillBoxes(state).has(skillBoxId);
}

/** Any carried row of one of these authority item ids (ctx-scoped containers). */
export function holdsAnyLocalItem(ctx: DialogueCtx, itemIds: ReadonlySet<number>): boolean {
  return ctx.state.inventory.some((row) =>
    itemIds.has(row.itemId) && row.quantity > 0 && ctx.isCarriedContainer(row.container),
  );
}

/** District-exchange container id (StoreToExchange scope — datapad grammar). */
const EXCHANGE_CONTAINER = "district-exchange";

/**
 * Authority starter-grant scope: carried rows always count; shared exchange
 * rows count only while the actor is inside the exchange interaction footprint.
 */
export function holdsAllOwnedOrExchangeItems(ctx: DialogueCtx, itemIds: ReadonlySet<number>): boolean {
  const exchangeInRange = playerWithinExchangeInteractionRange(ctx.slice, ctx.state);
  for (const itemId of itemIds) {
    if (!ctx.state.inventory.some((row) =>
      row.itemId === itemId && row.quantity > 0
      && (ctx.isCarriedContainer(row.container)
        || (exchangeInRange && row.container === EXCHANGE_CONTAINER)),
    )) return false;
  }
  return true;
}

/** Starter bundle issued by RequestStarterTool. Other category survey tools are crafted. */
export const STARTER_TOOL_ITEM_IDS: ReadonlySet<number> = new Set([3001, 3008]);

// ── Honest deny copy (skills-window strings — single source for trees) ────

export const DENY_NOVICE_FIRST = "Learn the novice box first";
export const DENY_PREREQ = "Prerequisite box not trained";
export const DENY_SKILL_POINTS = "Not enough free skill points";
export const DENY_RANGE = "Move closer to the trainer";
export const denyXp = (missing: number): string => `Needs ${formatInteger(missing)} more XP`;
export const denyCredits = (cost: number): string => `Needs ${formatInteger(cost)} credits`;

// ── Teach list (dynamic "What can you teach me?" content) ─────────────────

/** The five professions with full trainable trees (skills-window priority). */
export const TRAINABLE_PROFESSIONS: readonly ProfessionId[] = ["marksman", "scout", "craftsman", "medic", "brawler", "bioengineer"];

export interface TeachEntry {
  node: SkillNodeState;
  professionId: ProfessionId;
  /** "300 XP · 6 SP" (novice: "STARTER · 16 SP"). */
  costLabel: string;
  canTrain: boolean;
  /** Honest reason when canTrain is false. */
  reason: string | null;
}

interface ProfessionTreeShape {
  novice: SkillNodeState | null;
  master: SkillNodeState | null;
  /** Named tracks in column order, each phase-ascending. */
  tracks: readonly (readonly SkillNodeState[])[];
}

const treeShapeCache = new Map<ProfessionId, ProfessionTreeShape>();

function professionTreeShape(professionId: ProfessionId): ProfessionTreeShape {
  const cached = treeShapeCache.get(professionId);
  if (cached) return cached;
  const nodes = skillNodeDefinitions.filter((node) => node.profession === professionId);
  const byTrack = new Map<string, SkillNodeState[]>();
  let novice: SkillNodeState | null = null;
  let master: SkillNodeState | null = null;
  for (const node of nodes) {
    const track = typeof node.track === "string" ? node.track : "";
    if (track === "novice") {
      novice = node;
      continue;
    }
    if (track === "master") {
      master = node;
      continue;
    }
    if (!track) continue;
    const bucket = byTrack.get(track);
    if (bucket) bucket.push(node);
    else byTrack.set(track, [node]);
  }
  const tracks = [...byTrack.values()]
    .map((bucket) => bucket.slice().sort((a, b) => (a.phase ?? 0) - (b.phase ?? 0)))
    .sort((a, b) => (a[0]?.column ?? 0) - (b[0]?.column ?? 0));
  const shape: ProfessionTreeShape = { novice, master, tracks };
  treeShapeCache.set(professionId, shape);
  return shape;
}

function skillNodeXp(profession: ServerAuthorityProfessionState | null, node: SkillNodeState): number {
  if (!profession) return 0;
  const professionXp = Math.max(0, Math.trunc(profession.xp ?? 0));
  const track = typeof node.track === "string" ? node.track : "";
  if (track && track !== "novice" && track !== "master") {
    const trackXp = profession.trackXp?.[track];
    return typeof trackXp === "number" && Number.isFinite(trackXp)
      ? Math.min(professionXp, Math.max(0, Math.trunc(trackXp)))
      : 0;
  }
  return professionXp;
}

function teachEntryFor(ctx: DialogueCtx, professionId: ProfessionId, node: SkillNodeState): TeachEntry {
  const actor = playerActor(ctx.state);
  const profession = professionState(ctx.state, professionId);
  const trained = trainedSkillBoxes(ctx.state);
  const novice = node.id.endsWith("-novice");
  const xp = skillNodeXp(profession, node);
  const xpCost = Math.max(0, node.xpCost ?? 0);
  const spCost = Math.max(0, node.skillPointCost ?? 0);
  const creditCost = typeof node.creditCost === "number" && Number.isFinite(node.creditCost)
    ? Math.max(0, Math.trunc(node.creditCost))
    : 0;
  const accessible = novice || profession !== null;
  const prereqsMet = (node.prerequisites ?? []).every((required) => trained.has(required));
  const reason = !ctx.npc.inRange
    ? DENY_RANGE
    : !accessible
      ? DENY_NOVICE_FIRST
      : !prereqsMet
        ? DENY_PREREQ
        : xp < xpCost
          ? denyXp(xpCost - xp)
          : (actor?.credits ?? 0) < creditCost
            ? denyCredits(creditCost)
            : (actor?.skillPointsUsed ?? 0) + spCost > (actor?.skillPointsCap ?? 250)
              ? DENY_SKILL_POINTS
              : null;
  return {
    node,
    professionId,
    costLabel: teachCostLabel(node, creditCost),
    canTrain: reason === null,
    reason,
  };
}

/**
 * The next trainable box per track for one profession: novice box while the
 * track is unlearned; then each named track's lowest untrained box; master
 * once every track box is behind the player. Trained-out professions return
 * an empty list (the NPC line carries that beat).
 */
export function nextTrainableBoxes(ctx: DialogueCtx, professionId: ProfessionId): TeachEntry[] {
  const shape = professionTreeShape(professionId);
  const trained = trainedSkillBoxes(ctx.state);
  if (!professionLearned(ctx.state, professionId)) {
    return shape.novice ? [teachEntryFor(ctx, professionId, shape.novice)] : [];
  }
  const entries: TeachEntry[] = [];
  for (const track of shape.tracks) {
    const next = track.find((node) => !trained.has(node.id));
    if (next) entries.push(teachEntryFor(ctx, professionId, next));
  }
  if (entries.length === 0 && shape.master && !trained.has(shape.master.id)) {
    entries.push(teachEntryFor(ctx, professionId, shape.master));
  }
  return entries;
}

/** Teach entries across every profession this NPC teaches (trainer order). */
export function teachListFor(ctx: DialogueCtx): TeachEntry[] {
  const entries: TeachEntry[] = [];
  for (const professionId of ctx.npc.professionIds) {
    const trainable = TRAINABLE_PROFESSIONS.find((candidate) => candidate === professionId) ?? null;
    if (!trainable) continue;
    entries.push(...nextTrainableBoxes(ctx, trainable));
  }
  return entries;
}

/**
 * Trainer conversation is a concise "available now" surface. The full Skills
 * ledger remains the discovery surface for future boxes, so an XP-short entry
 * is hidden here instead of appearing as a misleading grey dialogue choice.
 */
export function visibleTeachListFor(ctx: DialogueCtx): TeachEntry[] {
  return teachListFor(ctx).filter((entry) => !isXpShortReason(entry.reason));
}

function isXpShortReason(reason: string | null): boolean {
  return reason !== null && /^Needs [\d,.]+ more XP$/u.test(reason);
}

/** "SURVEY I · 100 XP · 8 SP" — profession-prefixed when the NPC teaches several. */
export function teachOptionLabel(entry: TeachEntry, multiProfession: boolean): string {
  const name = entry.node.label.toUpperCase();
  const prefixed = multiProfession
    ? `${(professionDefinitions[entry.professionId] ?? entry.professionId).toUpperCase()} · ${name}`
    : name;
  return `${prefixed} · ${entry.costLabel}`;
}

function teachCostLabel(node: SkillNodeState, creditCost: number): string {
  return [
    (node.xpCost ?? 0) > 0 ? `${formatInteger(node.xpCost ?? 0)} XP` : "STARTER",
    (node.skillPointCost ?? 0) > 0 ? `${formatInteger(node.skillPointCost ?? 0)} SP` : null,
    creditCost > 0 ? `${formatInteger(creditCost)} CR` : null,
  ].filter(Boolean).join(" · ");
}

export function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)).toLocaleString();
}
