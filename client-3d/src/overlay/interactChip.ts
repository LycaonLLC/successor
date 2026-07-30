import type { InteractionOption, PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { interactionOptions, isHarvestableCreatureCorpse } from "@successor/client/src/slice-core/interactionSystem";
import { CAMP_INTERACTION_HALF_EXTENT_CELLS } from "@successor/client/src/slice-core/campSystem";
import { packUpConfirmArmed } from "../ui/camp/actions";
import { cleanActorName, stripTypeRead } from "../ui/hud/actorNames";
import { getUiThemeColors } from "../ui/uiTheme";
import { softLockTarget } from "../combat/softLock";
import { lootHoldProgressForOption } from "./lootHold";
import type { OverlayWorldProjector } from "./index";

/**
 * World-anchored use indicator (F-chip rewrite, 2026-07-08) — the interact
 * affordance lives ON the interactable now, not in a bottom-of-screen banner.
 *
 * Journey lens: walk toward a door / corpse / extractor / terminal / trainer →
 * a small glass chip materializes AT the object (`F · VERB · NAME`, `+n ·V·` when
 * more are in reach) → F fires the identical dispatch (interactPrompt.ts) →
 * the verb flips live on the same anchor (OPEN→CLOSE, CRANK→STOP): the world
 * visibly changed state exactly where you acted. Nothing explains the verb;
 * the chip appearing on the object IS the lesson.
 *
 * Presentation rules:
 *  - Nearest eligible option by default; V cycles the selection through the in-reach list when more than one is eligible (chip advertises `+n ·V·`). One chip, one decision.
 *  - Chrome colors from the live theme (`getUiThemeColors()`, the canvas-UI
 *    retint pattern); this is chrome, not a semantic gameplay color.
 *  - 220ms ease-out pop on birth/retarget, then a subtle accent breathe.
 *    `prefers-reduced-motion` collapses both.
 *  - Distance fade toward the eligibility edge; off-screen anchors skip.
 *  - Whisper alpha while a soft-lock combat target lives — the fight's
 *    picture always outranks the use affordance.
 *  - Honest gray while the player is not alive: the verb is real, the gate
 *    is real, and the chip says so instead of promising phosphor.
 *  - Drawn on the pointer-transparent overlay canvas: it can never block a
 *    combat sightline or steal a click.
 */

export interface InteractChipAnchor {
  x: number;
  y: number;
  /** World height (cells) passed to the projector — object-honest, per kind. */
  height: number;
}

export interface InteractChipVm {
  optionId: string;
  verb: string;
  name: string;
  /** Count of additional in-reach options beyond the nearest. */
  more: number;
  anchor: InteractChipAnchor;
  /** 0..1 distance fade (1 = well inside reach, edge of reach ≈ floor). */
  reachAlpha: number;
  /** True when the player cannot act (not alive) — render the honest gray. */
  gated: boolean;
  /** True while a window bound to this target is open — VM lives, paint skips. */
  suppressed: boolean;
}

/**
 * Cycle-interactable keybind (2026-07-08): when more than one interactable is
 * in reach, V cycles the chip's selection through the nearest-first list; the
 * chip advertises the hint (`+n ·V·`). F still fires the act verb on the
 * selected option. KeyV is verified free across gameplay binds (WASD/Shift/
 * Space/R/F/I), window hotkeys (C/K/O/P/B/G), toolbar defaults, and Tab
 * (target-switch) — G is the CRAFT window, so V it is. Single source of truth
 * for the bound code + displayed letter (input.ts imports the code from here).
 */
export const CYCLE_INTERACT_KEY_CODE = "KeyV";
export const CYCLE_INTERACT_KEY_LETTER = "V";
const VERB_BY_KIND: Partial<Record<InteractionOption["kind"], string>> = {
  corpse: "LOOT",
  exchange: "EXCHANGE",
  trainer: "CONVERSE",
  lootCache: "LOOT",
  travelTerminal: "TRAVEL",
  bankTerminal: "BANK",
  cloneTerminal: "CLONE",
  paTerminal: "ASSOCIATION",
  factoryTerminal: "MANUFACTURE",
};

/**
 * Distance-fade extents per kind. Most mirror interactionSystem.ts's radial
 * gates; camp uses the corner distance of its 5×5 AABB only for fading because
 * eligibility itself is the shared footprint predicate.
 */
const REACH_BY_KIND: Record<InteractionOption["kind"], number> = {
  corpse: 1.75,
  exchange: 1.75,
  lootCache: 1.75,
  trainer: 1.75,
  factoryTerminal: 1.75,
  extractor: 1.5,
  camp: Math.SQRT2 * CAMP_INTERACTION_HALF_EXTENT_CELLS,
  door: 2.2,
  travelTerminal: 10,
  bankTerminal: 1.75,
  cloneTerminal: 1.75,
  paTerminal: 1.75,
};

/** Chip anchor heights (world cells) — follow each interactable's silhouette. */
const HEIGHT_BY_KIND: Record<InteractionOption["kind"], number> = {
  corpse: 0.35,
  lootCache: 0.6,
  extractor: 1.05,
  exchange: 1.1,
  door: 1.25,
  /** Above the fitted ~1.9-cell Grok kiosk so the chip never covers its screen. */
  travelTerminal: 2.05,
  bankTerminal: 1.35,
  cloneTerminal: 1.35,
  paTerminal: 1.35,
  factoryTerminal: 1.15,
  trainer: 1.35,
  /** Below the spine cap, above the door head — reads "on the tent". */
  camp: 1.55,
};

/** Alpha floor at the very edge of reach — eligible is never invisible. */
const REACH_EDGE_ALPHA = 0.45;
/** Fraction of the reach radius where the fade begins. */
const REACH_FADE_START = 0.78;
/** Combat precedence: chip alpha multiplier while a soft-lock target lives. */
const COMBAT_WHISPER_ALPHA = 0.38;
const POP_MS = 220;
const FONT_FAMILY = "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace";

/**
 * F-verb for an option — presentation twin of interactPrompt.performSelected's
 * dispatch precedence (extractor: release crank, else bank hopper, else crank;
 * door verb tracks live server state; creature corpses harvest).
 */
export function interactChipVerb(option: InteractionOption, state: PlayState): string {
  if (option.kind === "corpse") {
    const actor = state.serverAuthority.actors[option.targetId];
    if (actor && isHarvestableCreatureCorpse(actor)) return "HARVEST";
  }
  if (option.kind === "door") {
    const open = state.serverAuthority.propStates?.[option.targetId]?.doorOpen === true;
    return open ? "CLOSE" : "OPEN";
  }
  if (option.kind === "extractor") {
    const extractor = state.serverAuthority.placedExtractors.find(
      (entry) => entry.extractorId === option.targetId,
    );
    if (extractor?.mode === "manual") return "STOP";
    if ((extractor?.hopperPct ?? 0) > 0) return "COLLECT";
    return "CRANK";
  }
  if (option.kind === "camp") {
    // Two-step strike: the verb IS the confirm state (arm window lives in
    // ui/camp/actions; the verb joins the render key, so the flip repaints).
    return packUpConfirmArmed(option.targetId, performance.now()) ? "CONFIRM STRIKE" : "PACK UP";
  }
  return VERB_BY_KIND[option.kind] ?? "USE";
}

/**
 * Chip NAME for an option (C2 copy diet):
 *  - actor targets (corpse/trainer) ride the clean-name chain — the earlier sandbox design type
 *    read never eats the chip budget ("MORI MADDOX (A ROGUE TRO…" class);
 *  - prop labels drop the verb·noun stutter: "Travel Terminal — Dustgate"
 *    under the TRAVEL verb reads "Dustgate Terminal".
 */
export function interactChipName(option: InteractionOption, verb: string, state: PlayState): string {
  if (option.kind === "corpse" || option.kind === "trainer") {
    return cleanActorName(state.serverAuthority.actors[option.targetId], stripTypeRead(option.label));
  }
  const dash = option.label.indexOf("—");
  if (dash < 0) return option.label;
  const base = option.label.slice(0, dash).trim();
  const qualifier = option.label.slice(dash + 1).trim();
  if (!qualifier || !base.toLowerCase().startsWith(`${verb.toLowerCase()} `)) return option.label;
  const remainder = base.slice(verb.length).trim();
  return remainder ? `${qualifier} ${remainder}` : qualifier;
}

/**
 * Window-suppression seam: while a window bound to the selected target is
 * open (converse/loot/travel), the chip stops painting — it used to bleed
 * through the glass it had just opened. Wired by the composition root; the
 * options list + F dispatch are untouched (probe/journey contract).
 */
let chipSuppressor: ((option: InteractionOption) => boolean) | null = null;

export function setInteractChipSuppressor(fn: ((option: InteractionOption) => boolean) | null): void {
  chipSuppressor = fn;
}

/**
 * World anchor for an option — the point the chip floats over.
 * Doors anchor on their blocker (the actual doorway), never the prop's
 * footprint center (which for a shelter is the middle of the roof).
 */
export function interactChipAnchor(
  option: InteractionOption,
  slice: SliceSnapshot,
  state: PlayState,
): InteractChipAnchor | null {
  const height = HEIGHT_BY_KIND[option.kind];
  if (option.kind === "corpse" || option.kind === "trainer") {
    const actor = state.serverAuthority.actors[option.targetId];
    if (actor) {
      return { x: (actor.renderX ?? actor.x) + 0.5, y: (actor.renderY ?? actor.y) + 0.5, height };
    }
    // Slice-only trainer (no authority entry yet) — cell-centered fallback.
    const sliceActor = slice.actors.find((entry) => entry.id === option.targetId);
    if (sliceActor) return { x: sliceActor.cell.x + 0.5, y: sliceActor.cell.y + 0.5, height };
    return null;
  }
  if (option.kind === "extractor") {
    const extractor = state.serverAuthority.placedExtractors.find(
      (entry) => entry.extractorId === option.targetId,
    );
    if (!extractor) return null;
    return { x: extractor.cellX + 0.5, y: extractor.cellY + 0.5, height };
  }
  if (option.kind === "camp") {
    const camp = state.serverAuthority.placedCamps.find(
      (entry) => entry.campId === option.targetId,
    );
    if (!camp) return null;
    return { x: camp.cellX + 0.5, y: camp.cellY + 0.5, height };
  }
  const prop = slice.props.find((entry) => entry.id === option.targetId);
  if (!prop) return null;
  if (option.kind === "door" && prop.door) {
    // Same math as interactionSystem.doorWorldCenter (not exported there).
    const blocker = prop.door.blocker;
    return {
      x: prop.cell.x + (blocker.xMilli + blocker.wMilli / 2) / 1000,
      y: prop.cell.y + (blocker.yMilli + blocker.hMilli / 2) / 1000,
      height,
    };
  }
  return { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2, height };
}

/** Distance fade: 1 well inside reach, easing to the floor at the reach edge. */
export function interactChipReachAlpha(option: InteractionOption, slice: SliceSnapshot): number {
  let reach = REACH_BY_KIND[option.kind];
  if (option.kind === "door") {
    const prop = slice.props.find((entry) => entry.id === option.targetId);
    const override = prop?.door?.interactRadiusCells;
    if (typeof override === "number" && Number.isFinite(override) && override > 0) reach = override;
  }
  const start = reach * REACH_FADE_START;
  if (option.distanceCells <= start) return 1;
  const t = Math.min(1, (option.distanceCells - start) / Math.max(1e-6, reach - start));
  return 1 - t * (1 - REACH_EDGE_ALPHA);
}

/**
 * Per-frame view model for the selected interaction. ALSO publishes the
 * options list onto PlayState (`state.interactions.options`) — the single
 * per-frame writer now that the banner's RAF is gone; F dispatch
 * (interactPrompt.performSelected) recomputes at press time as before.
 *
 * Honors the V-cycle selection (`state.interactions.selectedIndex`), clamped
 * to the live option count — mirrors interactionSystem's probe clamp so a
 * stale index never reads past the list. F reads the same index, so the chip
 * and the act verb always target the same object. With nothing cycled the
 * index is 0, i.e. the nearest (unchanged behavior).
 */
export function computeInteractChipVm(slice: SliceSnapshot, state: PlayState): InteractChipVm | null {
  const options = interactionOptions(slice, state);
  state.interactions.options = options;
  if (options.length === 0) return null;
  const index = clampSelectionIndex(state.interactions.selectedIndex, options.length);
  state.interactions.selectedIndex = index;
  const selected = options[index];
  if (!selected) return null;
  const anchor = interactChipAnchor(selected, slice, state);
  if (!anchor) return null;
  const playerId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const player = state.serverAuthority.actors[playerId];
  const verb = interactChipVerb(selected, state);
  return {
    optionId: selected.id,
    verb,
    name: interactChipName(selected, verb, state).toUpperCase(),
    more: options.length - 1,
    anchor,
    reachAlpha: interactChipReachAlpha(selected, slice),
    gated: player !== undefined && player.lifeState !== "alive",
    suppressed: chipSuppressor !== null && chipSuppressor(selected),
  };
}

function clampSelectionIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  const truncated = Math.trunc(index) || 0;
  return truncated >= count ? count - 1 : truncated < 0 ? 0 : truncated;
}

/** Birth tracking for the pop pulse — retarget (id change) re-pops. */
let bornKey = "";
let bornAtMs = 0;

let reducedMotion = false;
if (typeof matchMedia !== "undefined") {
  const query = matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion = query.matches;
  query.addEventListener?.("change", (event) => {
    reducedMotion = event.matches;
  });
}

function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) ** 3;
}

export function drawInteractChip(
  ctx: CanvasRenderingContext2D,
  projector: OverlayWorldProjector,
  slice: SliceSnapshot,
  state: PlayState,
  timeMs: number,
  width: number,
  height: number,
): boolean {
  const vm = computeInteractChipVm(slice, state);
  publishChipProbe(vm, null, width, height);
  if (!vm) {
    bornKey = "";
    lastChipScreenRect = null;
    return false;
  }
  if (vm.optionId !== bornKey) {
    bornKey = vm.optionId;
    bornAtMs = timeMs;
  }

  const screen = projector.worldToScreen(vm.anchor.x, vm.anchor.y, vm.anchor.height);
  publishChipProbe(vm, screen, width, height);
  if (vm.suppressed) {
    // Window bound to this target is open — the chip yields to the glass it
    // opened (it used to bleed through). Options/F dispatch stay live.
    lastChipScreenRect = null;
    return false;
  }
  if (screen.px < -80 || screen.px > width + 80 || screen.py < -60 || screen.py > height + 60) {
    lastChipScreenRect = null;
    return false;
  }

  const theme = getUiThemeColors();
  const pop = reducedMotion ? 1 : easeOutCubic((timeMs - bornAtMs) / POP_MS);
  const scale = 1 + 0.14 * (1 - pop);

  let alpha = vm.reachAlpha * (reducedMotion ? 1 : Math.min(1, (timeMs - bornAtMs) / 120));
  if (softLockTarget()) alpha *= COMBAT_WHISPER_ALPHA;

  // Honest gray when gated (player down): hairline family, no accent promise.
  const accent = vm.gated ? theme.inkDim.css : theme.accent.css;
  const accentSoft = vm.gated
    ? `rgba(${theme.inkDim.r},${theme.inkDim.g},${theme.inkDim.b},0.18)`
    : `rgba(${theme.accentSoft.r},${theme.accentSoft.g},${theme.accentSoft.b},0.72)`;
  const ink = vm.gated ? theme.inkDim.css : theme.ink.css;
  const glassFill = `rgba(${theme.bgPanel.r},${theme.bgPanel.g},${theme.bgPanel.b},0.78)`;
  const hairline = `rgba(${theme.hairline.r},${theme.hairline.g},${theme.hairline.b},0.9)`;

  const keyFont = `700 10px ${FONT_FAMILY}`;
  const verbFont = `700 10px ${FONT_FAMILY}`;
  const nameFont = `600 11px ${FONT_FAMILY}`;
  const moreFont = `400 9px ${FONT_FAMILY}`;

  ctx.save();
  ctx.textBaseline = "middle";

  // Measure (unscaled CSS px), then truncate the name into the budget. The
  // 240px cap fits a full display_name at generous screen space (C2 — the
  // old 170px cut names the world had room for).
  ctx.font = nameFont;
  const name = truncateToWidth(ctx, vm.name, 240);
  const nameW = ctx.measureText(name).width;
  ctx.font = verbFont;
  const verbW = ctx.measureText(vm.verb).width;
  const moreText = vm.more > 0 ? `+${vm.more}` : "";
  // Cycle hint: only when there is something to cycle to (+n > 0). Ruled style `+n ·V·`.
  const cycleText = moreText ? `·${CYCLE_INTERACT_KEY_LETTER}·` : "";
  ctx.font = moreFont;
  const moreW = moreText ? ctx.measureText(moreText).width : 0;
  const cycleW = cycleText ? ctx.measureText(cycleText).width : 0;

  const keyBox = 14;
  const gap = 6;
  const padX = 7;
  const chipH = 22;
  const chipW = padX + keyBox + gap + verbW + gap + nameW + (moreText ? gap + moreW : 0) + (cycleText ? gap + cycleW : 0) + padX;

  // Chip floats above the anchor; a short pin tick grounds it to the object.
  const lift = 12;
  ctx.translate(screen.px, screen.py - lift);
  ctx.scale(scale, scale);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  // Pin tick.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.globalAlpha *= 0.9;
  ctx.beginPath();
  ctx.moveTo(0, 0 + 2);
  ctx.lineTo(0, lift - 4);
  ctx.stroke();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  const left = -chipW / 2;
  const top = -chipH;

  // Glass body — hairline HUD-glass, the house window material.
  ctx.beginPath();
  roundedRect(ctx, left, top, chipW, chipH, 2);
  ctx.fillStyle = glassFill;
  // Accent glow: strong during the pop, then a subtle phosphor breathe.
  const breathe = reducedMotion || vm.gated ? 0 : 1.5 + 1.5 * Math.sin(timeMs * 0.0045);
  ctx.shadowColor = accent;
  ctx.shadowBlur = vm.gated ? 0 : 10 * (1 - pop) + breathe;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hairline;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Key box: [F]
  const keyX = left + padX;
  const keyY = top + (chipH - keyBox) / 2;
  ctx.beginPath();
  roundedRect(ctx, keyX, keyY, keyBox, keyBox, 2);
  ctx.fillStyle = accentSoft;
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.font = keyFont;
  ctx.textAlign = "center";
  ctx.fillText("F", keyX + keyBox / 2, keyY + keyBox / 2 + 0.5);

  // HOLD-F take-all fill: a phosphor arc sweeping the [F] box while the loot
  // hold charges (owner ruling — radial, house restraint). Only paints while
  // this option is the one being held; completes at HOLD_TO_TAKE_ALL_MS.
  const holdProgress = lootHoldProgressForOption(vm.optionId, timeMs);
  if (holdProgress !== null) {
    const cx = keyX + keyBox / 2;
    const cy = keyY + keyBox / 2;
    const ringRadius = keyBox / 2 + 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = accentSoft;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, -Math.PI / 2, -Math.PI / 2 + holdProgress * Math.PI * 2);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  // VERB · NAME · +n ·V·
  ctx.textAlign = "left";
  const textY = top + chipH / 2 + 0.5;
  let cursor = keyX + keyBox + gap;
  ctx.font = verbFont;
  ctx.fillStyle = accent;
  ctx.fillText(vm.verb, cursor, textY);
  cursor += verbW + gap;
  ctx.font = nameFont;
  ctx.fillStyle = ink;
  ctx.fillText(name, cursor, textY);
  if (moreText) {
    cursor += nameW + gap;
    ctx.font = moreFont;
    ctx.fillStyle = theme.inkDim.css;
    ctx.fillText(moreText, cursor, textY);
    // Cycle hint in accent — the same color family as the F key box.
    if (cycleText) {
      cursor += moreW + gap;
      ctx.fillStyle = accent;
      ctx.fillText(cycleText, cursor, textY);
    }
  }

  ctx.restore();
  // Publish the painted rect (screen px, unscaled) — nameplates yield to the
  // chip instead of printing through it (§1.8 camp-chip × nameplate overlap).
  lastChipScreenRect = {
    left: screen.px - chipW / 2 - 4,
    top: screen.py - lift - chipH - 4,
    right: screen.px + chipW / 2 + 4,
    bottom: screen.py - lift + 4,
  };
  return true;
}

export interface ChipScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

let lastChipScreenRect: ChipScreenRect | null = null;

/** Last frame's painted chip rect (screen px), or null when no chip painted. */
export function interactChipScreenRect(): ChipScreenRect | null {
  return lastChipScreenRect;
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y - h + h + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Live verification surface (VisualSweep3D / lab probes): last frame's VM. */
interface InteractChipProbeWindow {
  __successor3dInteractChip?: {
    optionId: string;
    verb: string;
    /** Chip NAME as painted (clean-name chain + verb·noun dedupe, C1/C2). */
    name: string;
    /** Additional in-reach options beyond the selected one (drives the `+n ·V·` hint). */
    more: number;
    gated: boolean;
    /** True while a bound window suppresses the paint (VM stays live). */
    suppressed: boolean;
    reachAlpha: number;
    anchor: InteractChipAnchor;
    screen: { px: number; py: number } | null;
    viewport: { width: number; height: number };
  } | null;
}

function publishChipProbe(
  vm: InteractChipVm | null,
  screen: { px: number; py: number } | null,
  width: number,
  height: number,
): void {
  if (typeof window === "undefined") return;
  (window as unknown as InteractChipProbeWindow).__successor3dInteractChip = vm
    ? {
        optionId: vm.optionId,
        verb: vm.verb,
        name: vm.name,
        more: vm.more,
        gated: vm.gated,
        suppressed: vm.suppressed,
        reachAlpha: vm.reachAlpha,
        anchor: vm.anchor,
        screen: screen ? { px: screen.px, py: screen.py } : null,
        viewport: { width, height },
      }
    : null;
}
