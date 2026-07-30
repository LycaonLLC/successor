// Exact-SHA RC first slice: one barrier-synchronized journey for three real players.
// The real transport reuses client3d/lib/browser.mjs (headed Xvfb/CDP). A tiny
// transport seam keeps causal ordering tests deterministic without a fake PASS.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadChromium } from "../client3d/lib/browser.mjs";
import { delay } from "../client3d/lib/util.mjs";
import { isForbiddenEvidenceField } from "./evidence.mjs";
import { runTuiWorldProof, tuiGateStatus } from "./tui.mjs";
import { ensurePrivateDirectory } from "./path-security.mjs";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const ACTORS = ["p1", "p2", "p3"];
const CHARACTER_NAMES = { p1: "Mara-Pea", p2: "Mara-Peb", p3: "Mara-Pec" };
const CHARACTER_PROFESSIONS = { p1: "craftsman", p2: "scout", p3: "scout" };
const OBSERVE_MS = 30_000;
const READY_TYPES = ["successor.creator.ready.v1", "successor.client.ready.v1", "successor.launch.v1", "successor.launch.failed.v1"];
const MANAGED_BROWSER_BIN = path.join(os.homedir(), "bin", "omp-headed-browser");

// Collision-proven Dustgate clone exit + commerce south approach (bank-clone-corpse).
// Axis-separated: interior x=518.5 corridor south to exterior lane y=512, then west to x=506, north to door.
const TRAINER_CLONE_CLEAR_LEFT = { x: 516.8, y: 504.8 };
const TRAINER_CLONE_ENTRY = { x: 518.5, y: 506 };
const TRAINER_CLONE_SOUTH_PORTAL = { x: 518.5, y: 508.5 };
const TRAINER_CLONE_SOUTH_LANE = { x: 518.5, y: 512 };
const TRAINER_COMMERCE_SOUTH_LANE = { x: 506, y: 512 };
const TRAINER_COMMERCE_DOOR_APPROACH = { x: 506, y: 508 };
const TRAINER_STAND = { x: 510.6, y: 503.0 };

export class EntryProofIncomplete extends Error { constructor(gate, message) { super(message); this.name = "EntryProofIncomplete"; this.gate = gate; } }
export class EntryProofFailure extends Error { constructor(gate, message) { super(message); this.name = "EntryProofFailure"; this.gate = gate; } }

/**
 * `stack` is startLocalStack's result. For focused tests it may contain a
 * `transport` with players() returning three objects implementing this module's
 * player methods (see createInstrumentedTransport). No task or step retries.
 */
export async function runTwoPlayerEntryProof({ stack, runRoot, signal, onEvent } = {}) {
  if (!stack || typeof stack !== "object") throw new TypeError("runTwoPlayerEntryProof requires stack");
  if (typeof runRoot !== "string" || !runRoot) throw new TypeError("runTwoPlayerEntryProof requires runRoot");
  const emit = emitter(onEvent);
  const gates = Object.fromEntries(["register", "creatorHandshake", "creatorCreate", "logoutLogin", "creatorStageDesktop", "creatorStageMobile", "tuiWorldReady", "roster", "pointerBeforeTicket", "clientReadyLaunch", "playStageDesktop", "worldReady", "sharedWorld", "hostedMacros", "equipmentAuthority", "equipmentDoll", "equipmentPawn", "chatOwnership", "linkDeadSet", "linkDeadCleared", "trainerReject", "trainerSuccess", "desktopNoScroll", "cleanup"].map((key) => [key, "blocked"]));
  const aliases = { p1: "p1", p2: "p2", p3: "p3" };
  const screenshots = [];
  let transport = stack.transport;
  let owned = false;
  try {
    assertLive(signal);
    if (!transport) { transport = await createBrowserTransport({ stack, runRoot, signal, emit }); owned = true; }
    await transport.open?.();
    await barrier("register", transport, signal, emit, async (player) => { await player.register(); });
    gates.register = "pass";

    await barrier("creator", transport, signal, emit, async (player) => {
      const result = requireProbe(await player.creator(), "creatorHandshake", "creator handshake");
      if (result.handshake !== true) throw new EntryProofIncomplete("creatorHandshake", "creator READY event missing");
      if (result.created !== true) throw new EntryProofFailure("creatorCreate", "creator did not report persisted create");
      if (result.characterId !== undefined) {
        if (typeof result.characterId !== "string" || result.characterId.length === 0) throw new EntryProofFailure("creatorCreate", "created character identity unavailable");
        player.createdCharacterId = result.characterId;
      }
      emit({ type: "creator.ready", actor: player.alias });
      emit({ type: "creator.created", actor: player.alias, appearance: "selected" });
    });
    gates.creatorHandshake = "pass";
    gates.creatorCreate = "pass";

    await barrier("logout-login", transport, signal, emit, async (player) => {
      const result = requireProbe(await player.logoutLogin?.(), "logoutLogin", "account logout/login");
      if (result.loggedOut !== true || result.loggedIn !== true) throw new EntryProofFailure("logoutLogin", "account session did not complete logout and login");
      if (result.rosterPresent !== true || result.selected !== true || result.enterEnabled !== true) throw new EntryProofFailure("logoutLogin", "created roster row was not present, selected, and enter-ready after login");
      emit({ type: "logout.login", actor: player.alias, loggedOut: true, loggedIn: true, rosterPresent: true, selected: true, enterEnabled: true });
    });
    gates.logoutLogin = "pass";

    const tuiPlayer = transport.players().find((player) => player?.alias === "p1");
    if (!tuiPlayer) throw new EntryProofFailure("tuiWorldReady", "P1 TUI authority actor unavailable");
    const tuiResult = typeof tuiPlayer?.tuiWorldReady === "function"
      ? await tuiPlayer.tuiWorldReady({ stack, player: tuiPlayer, runRoot, signal })
      : await runTuiWorldProof({ stack, player: tuiPlayer, runRoot, signal, onEvent: emit });
    const tuiGate = tuiGateStatus(tuiResult, tuiResult?.processExited !== false);
    emit({ type: "tui.world.ready", status: tuiGate.status, authorityConnected: tuiGate.authorityConnected === true, tickPositive: tuiGate.tickPositive === true, identityMatch: tuiGate.identityMatch === true, sourceMatchesClient: tuiGate.sourceMatchesClient === true, processExited: tuiResult?.processExited === true, cleanupComplete: tuiResult?.cleanupComplete === true });
    if (tuiGate.status !== "pass") {
      if (tuiGate.status === "incomplete") throw new EntryProofIncomplete("tuiWorldReady", tuiGate.reason ?? "TUI world probe incomplete");
      throw new EntryProofFailure("tuiWorldReady", tuiGate.reason ?? "TUI world probe failed");
    }
    gates.tuiWorldReady = "pass";

    const creatorMeasures = await barrier("creator-measure", transport, signal, emit, async (player) => {
      const desktop = requireDimensions(await player.measureStage("creator", DESKTOP), "creator desktop stage", "creatorStageDesktop");
      emitMeasure(emit, player.alias, "creator", desktop);
      if (!desktop.noScroll) throw new EntryProofFailure("desktopNoScroll", "creator stage scrolls on desktop");
      let mobile = null;
      if (typeof player.measureMobileStage === "function") mobile = await player.measureMobileStage("creator", MOBILE);
      return { desktop, mobile };
    });
    if (!creatorMeasures.every(({ desktop }) => stageOwnsViewport(desktop))) throw new EntryProofFailure("creatorStageDesktop", "creator frame does not own the viewport below the topbar");
    gates.creatorStageDesktop = "pass"; gates.desktopNoScroll = "pass";
    gates.creatorStageMobile = creatorMeasures.every(({ mobile }) => mobile && stageDimensions(mobile) && stageOwnsViewport(mobile)) ? "pass" : "incomplete";
    if (gates.creatorStageMobile === "incomplete") emit({ type: "gate.incomplete", gate: "creatorStageMobile", reason: "mobile stage probe unavailable or unsafe" });

    const entries = await barrier("roster-enter", transport, signal, emit, async (player) => {
      const result = requireProbe(await player.rosterEnter(), "roster", "roster selection");
      if (result.pointerBeforeTicket !== true) throw new EntryProofFailure("pointerBeforeTicket", "ticket was observed before runtime pointer");
      if (result.clientReadyBeforeLaunch !== true || result.launchSent !== true) throw new EntryProofFailure("clientReadyLaunch", "launch was not ordered after client READY");
      if (result.worldReady !== true) throw new EntryProofFailure("worldReady", "world-ready probe missing");
      const desktop = requireDimensions(await player.measureStage("play", DESKTOP), "play desktop stage", "playStageDesktop");
      emitMeasure(emit, player.alias, "play", desktop);
      return { ...result, desktop };
    });
    gates.roster = "pass"; gates.pointerBeforeTicket = "pass"; gates.clientReadyLaunch = "pass";
    if (!entries.every(({ desktop }) => fullStage(desktop))) throw new EntryProofFailure("playStageDesktop", "play canvas is not full-stage");
    gates.playStageDesktop = "pass"; gates.worldReady = "pass";
    const actorKeys = entries.map((entry) => entry.runtimeActorKey).filter((value) => typeof value === "string" && value.length > 0);
    if (new Set(actorKeys).size !== ACTORS.length) throw new EntryProofFailure("sharedWorld", "clients did not receive distinct local authority actors");
    const shared = await barrier("shared-world", transport, signal, emit, async (player) => requireProbe(await player.observeSharedWorld?.(actorKeys), "sharedWorld", "mutual authority projection"));
    if (!shared.every((result) => result.mutualProjection === true)) throw new EntryProofFailure("sharedWorld", "every client did not project every authority actor");
    gates.sharedWorld = "pass";
    emit({ type: "world.shared", actors: ACTORS, distinct: true, mutualProjection: true });
    for (const player of transport.players()) {
      const shot = await player.screenshot?.("entry");
      if (shot) screenshots.push(shot);
    }

    const macroPlayer = transport.players().find((player) => player?.alias === "p1");
    if (!macroPlayer) throw new EntryProofFailure("hostedMacros", "P1 hosted macro actor unavailable");
    const macros = requireProbe(await macroPlayer.hostedMacroCrud?.(), "hostedMacros", "hosted macro CRUD");
    if (macros.saved !== true || macros.deleted !== true) throw new EntryProofFailure("hostedMacros", "hosted macro save/delete did not complete");
    if (macros.parentPost !== true || macros.parentDelete !== true) throw new EntryProofFailure("hostedMacros", "parent MessagePort API path did not handle POST and DELETE");
    if (macros.versionAdvanced !== true) throw new EntryProofFailure("hostedMacros", "macro store version did not advance through save and delete");
    gates.hostedMacros = "pass";
    emit({
      type: "hosted.macros",
      actor: "p1",
      saved: true,
      deleted: true,
      parentPost: true,
      parentDelete: true,
      versionAdvanced: true,
      listCountAfterSave: Number(macros.listCountAfterSave ?? 0),
      listCountAfterDelete: Number(macros.listCountAfterDelete ?? 0),
      versionAfterSave: Number(macros.versionAfterSave ?? 0),
      versionAfterDelete: Number(macros.versionAfterDelete ?? 0),
    });

    const equipment = await barrier("equipment", transport, signal, emit, async (player) => requireProbe(await player.equipmentRoundTrip?.(), "equipmentAuthority", "equipment round-trip"));
    if (!equipment.every((result) => result.authorityChanged && result.authorityRestored)) throw new EntryProofFailure("equipmentAuthority", "authority worn set did not change and restore");
    gates.equipmentAuthority = "pass";
    if (!equipment.every((result) => result.dollChanged && result.dollRestored)) throw new EntryProofFailure("equipmentDoll", "inventory paper doll did not change and restore");
    gates.equipmentDoll = "pass";
    if (!equipment.every((result) => result.pawnChanged && result.pawnRestored)) throw new EntryProofFailure("equipmentPawn", "world pawn did not change and restore");
    gates.equipmentPawn = "pass";

    const [p1, p2] = transport.players();
    const chatProof = await p2.sendSpatialChat?.();
    const chatObserved = requireProbe(await p1.observeSpatialChat?.(entries[1].runtimeActorKey, chatProof), "chatOwnership", "spatial chat ownership");
    if (chatObserved.correctAnchor !== true) throw new EntryProofFailure("chatOwnership", "remote spatial bubble was not anchored to its speaker");
    gates.chatOwnership = "pass";

    await p2.disconnectGame?.();
    const linkDead = requireProbe(await p1.observeLinkDead?.(entries[1].runtimeActorKey, true), "linkDeadSet", "link-dead true transition");
    if (linkDead.observed !== true) throw new EntryProofFailure("linkDeadSet", "observer did not receive link-dead true");
    gates.linkDeadSet = "pass";
    const reentry = requireProbe(await p2.reconnectGame?.(), "linkDeadCleared", "same-character reconnect");
    if (reentry.sameActor !== true) throw new EntryProofFailure("linkDeadCleared", "reconnect did not restore the same authority actor");
    const linkLive = requireProbe(await p1.observeLinkDead?.(entries[1].runtimeActorKey, false), "linkDeadCleared", "link-dead false transition");
    if (linkLive.observed !== true) throw new EntryProofFailure("linkDeadCleared", "observer did not receive link-dead false");
    gates.linkDeadCleared = "pass";

    const trainer = requireProbe(await p1.trainerXpRoundTrip?.(), "trainerReject", "trainer XP round-trip");
    if (trainer.insufficientXpBlocked !== true) throw new EntryProofFailure("trainerReject", "trainer UI did not block the insufficient-XP purchase");
    gates.trainerReject = "pass";
    if (trainer.earnedAuthorityXp !== true || trainer.acceptedAfterXp !== true) throw new EntryProofFailure("trainerSuccess", "authority XP did not unlock a valid trainer purchase");
    gates.trainerSuccess = "pass";
    emit({ type: "journey.complete", gates });
  } catch (error) {
    const gate = error?.gate ?? firstBlocked(gates);
    gates[gate] = error instanceof EntryProofIncomplete ? "incomplete" : "fail";
    emit({ type: gates[gate] === "incomplete" ? "gate.incomplete" : "gate.fail", gate, reason: reason(error) });
  } finally {
    if (transport) {
      for (const shot of transport.evidenceScreenshots?.() ?? []) if (!screenshots.includes(shot)) screenshots.push(shot);
      try { await transport.close?.(); gates.cleanup = "pass"; }
      catch (error) { gates.cleanup = "fail"; emit({ type: "gate.fail", gate: "cleanup", reason: reason(error) }); }
    }
    if (owned) transport = null;
  }
  return { gates, aliases, screenshots };
}

function emitter(onEvent) {
  const started = Date.now(); let previous = 0;
  return (event) => {
    if (typeof onEvent !== "function") return;
    const atMs = Math.max(previous, Date.now() - started); previous = atMs;
    onEvent({ type: String(event?.type ?? "observation").slice(0, 64), atMs, ...safeFields(event) });
  };
}
function safeFields(event) {
  const output = {};
  for (const [key, value] of Object.entries(event ?? {})) {
    if (key === "type" || key === "atMs" || key === "origin" || key === "url" || isForbiddenEvidenceField(key)) continue;
    const safe = safeFieldValue(value);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}
function safeFieldValue(value) {
  if (typeof value === "string") return value.slice(0, 96);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(safeFieldValue).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "origin" || key === "url" || isForbiddenEvidenceField(key)) continue;
      const safe = safeFieldValue(item);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }
  return undefined;
}
async function barrier(step, transport, signal, emit, action) {
  assertLive(signal); const players = transport.players();
  if (!Array.isArray(players) || players.length !== ACTORS.length) throw new EntryProofFailure(step, `exactly ${ACTORS.length} players are required`);
  emit({ type: "barrier.start", step, actors: ACTORS });
  const results = await Promise.allSettled(players.map(async (player) => {
    assertLive(signal);
    return action(player);
  }));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  const values = results.map((result) => result.value);
  for (const player of players) {
    const live = requireProbe(await player.liveness?.(), step, `${player.alias} rAF/visibility`);
    emit({ type: "liveness.observe", step, actor: player.alias, raf: Number(live.raf), visible: live.visible === true });
    if (live.visible !== true || Number(live.raf) < 2) throw new EntryProofFailure(barrierGate(step), `${player.alias} liveness produced ${Number(live.raf)} rAF frames with visible=${live.visible === true}`);
    emit({ type: "barrier.ready", step, actor: player.alias, raf: Number(live.raf), visible: true });
  }
  emit({ type: "barrier.complete", step, actors: ACTORS }); return values;
}

function barrierGate(step) { return ({ creator: "creatorHandshake", "logout-login": "logoutLogin", "creator-measure": "creatorStageDesktop", "roster-enter": "roster", "shared-world": "sharedWorld", equipment: "equipmentAuthority" })[step] ?? step; }
function requireProbe(value, gate, label) { if (!value || value.probeAvailable === false) throw new EntryProofIncomplete(gate, `${label} probe unavailable`); return value; }
function requireDimensions(value, label, gate = "creatorStageDesktop") {
  if (!value || value.probeAvailable === false) throw new EntryProofIncomplete(gate, label + " probe unavailable");
  if (!stageDimensions(value)) throw new EntryProofIncomplete(gate, label + " dimensions unavailable");
  return value;
}function stageDimensions(value) { return ["viewport", "frame", "canvas"].every((key) => value[key] && Number.isFinite(value[key].width) && Number.isFinite(value[key].height)); }
function stageOwnsViewport(value) { return stageDimensions(value) && value.frame.width >= value.viewport.width * 0.95 && value.frame.height >= value.viewport.height - 72; }
function fullStage(value) { return stageOwnsViewport(value) && value.canvas.width >= value.frame.width * 0.95 && value.canvas.height >= value.frame.height * 0.95; }
function emitMeasure(emit, actor, stage, value) { emit({ type: "stage.measure", actor, stage, viewport: value.viewport, frame: value.frame, canvas: value.canvas, noScroll: value.noScroll === true }); }
function firstBlocked(gates) { return Object.entries(gates).find(([, value]) => value === "blocked")?.[0] ?? "journey"; }
function reason(error) { return String(error?.message ?? error).replace(/\s+/gu, " ").slice(0, 240); }
export function sanitizeCleanupError(error, alias) {
  const safeAlias = typeof alias === "string" && alias.length > 0 ? alias : "player";
  const raw = String(error?.message ?? error ?? "account cleanup failed");
  // Strip any accidental credential-shaped payloads; keep only status codes / generic labels.
  const scrubbed = raw
    .replace(/[A-Za-z0-9_-]{16,}/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  const statusMatch = scrubbed.match(/\b(\d{3})\b/u);
  if (statusMatch) return new Error(`account cleanup failed for ${safeAlias} (${statusMatch[1]})`);
  if (/login/iu.test(scrubbed)) return new Error(`account cleanup login failed for ${safeAlias}`);
  if (/session inactive/iu.test(scrubbed)) return new Error(`account cleanup session inactive for ${safeAlias}`);
  if (/deletion returned/iu.test(scrubbed)) return new Error(`account cleanup deletion failed for ${safeAlias}`);
  return new Error(`account cleanup failed for ${safeAlias}`);
}
function assertLive(signal) { if (signal?.aborted) throw new EntryProofFailure("aborted", "proof aborted"); }

export function csrfHeaders(csrfToken) {
  if (typeof csrfToken !== "string" || csrfToken.length === 0) throw new Error("csrf token unavailable");
  return { "content-type": "application/json", "x-csrf-token": csrfToken };
}

export function assertPlayTicketCharacter(requestedCharacterId, body) {
  if (typeof requestedCharacterId !== "string" || requestedCharacterId.length === 0 || body?.characterId !== requestedCharacterId) throw new EntryProofFailure("tuiWorldReady", "play ticket character does not match requested character");
  return true;
}


/**
 * Pure parent /play/ launch activation decision from a non-sensitive snapshot.
 * Character ids stay out of reasons/events; callers pass equality booleans only.
 * ok means the submit is focused and one trusted keyboard Enter may proceed.
 */
export function evaluateParentPlayLaunchActivation(snapshot) {
  const base = snapshot && typeof snapshot === "object" ? snapshot : {};
  const optionMatchCount = Number(base.optionMatchCount);
  const selectedMatches = base.selectedMatches === true;
  const formBound = base.formBound === true;
  const submitEnabled = base.submitEnabled === true;
  const submitVisible = base.submitVisible === true;
  const activeIsSubmit = base.activeIsSubmit === true;
  const requireFocus = base.requireFocus !== false;

  if (!Number.isInteger(optionMatchCount) || optionMatchCount <= 0) {
    return { ok: false, reason: "missing-character-option" };
  }
  if (optionMatchCount !== 1) return { ok: false, reason: "duplicate-character-option" };
  if (!selectedMatches) return { ok: false, reason: "wrong-character-selected" };
  if (!formBound) return { ok: false, reason: "launch-form-unbound" };
  if (!submitVisible) return { ok: false, reason: "submit-not-visible" };
  if (!submitEnabled) return { ok: false, reason: "submit-disabled" };
  if (requireFocus && !activeIsSubmit) return { ok: false, reason: "submit-unfocused" };
  return {
    ok: true,
    reason: "ready",
    selectedMatches: true,
    formBound: true,
    submitEnabled: true,
    submitVisible: true,
    activeIsSubmit: requireFocus ? true : activeIsSubmit,
  };
}

/**
 * Pure disposition for trusted parent Enter delivery under multi-session focus races.
 * A second trusted Enter is allowed only when the first produced no launch request.
 * Any pointer/ticket observation consumes the attempt and forbids retry.
 */
export function decideParentPlayEnterRetry({ attempt, maxAttempts = 2, sawPointer = false, sawTicket = false } = {}) {
  const n = Number(attempt);
  const max = Number(maxAttempts);
  const attemptNumber = Number.isInteger(n) && n > 0 ? n : 0;
  const limit = Number.isInteger(max) && max > 0 ? max : 2;
  if (sawPointer === true || sawTicket === true) {
    return { action: "continue", reason: sawPointer === true ? "pointer-observed" : "ticket-observed" };
  }
  if (attemptNumber < 1) return { action: "fail", reason: "invalid-attempt" };
  if (attemptNumber < limit) return { action: "retry", reason: "no-launch-request" };
  return { action: "fail", reason: "no-launch-request" };
}




/** Character macros route on the site parent (/alpha-api/...), exact path only. */
const CHARACTER_MACROS_PATH = /^\/alpha-api\/characters\/[^/]+\/macros(?:\/[^/]+)?$/u;

/**
 * Classify a parent-frame macro mutation response for count-only proof.
 * Counts only same-origin successful 2xx POST/DELETE on the exact character macros route
 * whose request frame is the page main frame. Rejects 4xx/5xx, wrong origin, iframe,
 * wrong method, and neighboring paths without recording URLs or bodies.
 */
export function classifySuccessfulParentMacroResponse(response, { siteOrigin, mainFrame } = {}) {
  try {
    if (!response || typeof response.url !== "function") return null;
    const rawUrl = response.url();
    const parsed = new URL(rawUrl);
    if (typeof siteOrigin === "string" && siteOrigin.length > 0 && parsed.origin !== siteOrigin) return null;
    if (!CHARACTER_MACROS_PATH.test(parsed.pathname)) return null;
    const request = typeof response.request === "function" ? response.request() : null;
    if (!request || typeof request.method !== "function") return null;
    const method = request.method();
    if (method !== "POST" && method !== "DELETE") return null;
    if (mainFrame != null) {
      const frame = typeof request.frame === "function" ? request.frame() : null;
      if (frame !== mainFrame) return null;
    }
    const status = typeof response.status === "function" ? Number(response.status()) : NaN;
    if (!Number.isInteger(status) || status < 200 || status >= 300) return null;
    return method === "POST" ? "post" : "delete";
  } catch {
    return null;
  }
}

export function applySuccessfulParentMacroResponse(counts, response, options) {
  const kind = classifySuccessfulParentMacroResponse(response, options);
  if (kind === "post") counts.post += 1;
  else if (kind === "delete") counts.delete += 1;
  return kind;
}

/**
 * Safe page response observer entrypoint. Resolves mainFrame outside the classifier
 * so a late navigation/teardown throw cannot escape the response listener.
 */
export function observeSuccessfulParentMacroResponse(counts, response, { siteOrigin, page } = {}) {
  let mainFrame = null;
  try {
    mainFrame = typeof page?.mainFrame === "function" ? page.mainFrame() : null;
  } catch {
    return null;
  }
  return applySuccessfulParentMacroResponse(counts, response, { siteOrigin, mainFrame });
}

/** Gated wait used by hosted macro parent proof; default gate remains observation elsewhere. */
export async function waitForProofPredicate(predicate, label, timeoutMs = OBSERVE_MS, gate = "observation") {
  return waitUntil(predicate, label, timeoutMs, gate);
}


/**
 * Cleanup path only: open /account/, and if the session is not active use the
 * retained private callsign/password through the visible login form before delete.
 * Never re-registers. Callers must keep credentials out of thrown errors.
 */
export async function ensureActiveAccountSessionForCleanup(page, { siteUrl, callsign, password, alias } = {}) {
  if (!page || typeof page.goto !== "function") throw new Error("account cleanup page unavailable");
  await page.goto(new URL("/account/", siteUrl).href, { waitUntil: "domcontentloaded" });
  // Account page boots as data-session-state=unknown until /session resolves.
  await page.waitForFunction(
    () => {
      const state = document.body?.dataset?.sessionState ?? "unknown";
      return state === "active" || state === "none";
    },
    undefined,
    { timeout: 20_000 },
  );
  const sessionState = await page.evaluate(() => document.body?.dataset?.sessionState ?? "unknown");
  if (sessionState === "active") {
    await page.locator("body[data-session-state=active]").waitFor({ timeout: 20_000 });
    return { relogin: false };
  }
  if (typeof callsign !== "string" || callsign.length === 0 || typeof password !== "string" || password.length === 0) {
    throw new Error(`account cleanup session inactive for ${typeof alias === "string" && alias.length ? alias : "player"}`);
  }
  await page.locator("#login-callsign").waitFor({ timeout: 20_000 });
  await page.locator("#login-callsign").fill(callsign);
  await page.locator("#login-password").fill(password);
  const loginResponse = page.waitForResponse((response) => {
    try { return new URL(response.url()).pathname.endsWith("/login") && response.request().method() === "POST"; }
    catch { return false; }
  });
  await page.locator("#login-form button[type=submit]").click();
  const login = await loginResponse;
  if (login.status() !== 200) throw new Error(`account cleanup login returned ${login.status()}`);
  await page.locator("body[data-session-state=active]").waitFor({ timeout: 20_000 });
  return { relogin: true };
}


export function managedSessionName(runId, alias) {
  const clean = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  const suffix = clean(alias).slice(0, 2) || "p";
  return `${(clean(runId) || "rc").slice(0, 29 - suffix.length).replace(/-+$/u, "")}-${suffix}`;
}

async function createBrowserTransport({ stack, runRoot, signal, emit }) {
  const repoRoot = stack.repoRoot ?? process.cwd();
  const loaded = loadChromium(repoRoot);
  const privateRoot = path.join(runRoot, "private", "two-player");
  const screenshotRoot = path.join(runRoot, "evidence", "screenshots");
  await ensurePrivateDirectory(runRoot, "private/two-player");
  await ensurePrivateDirectory(runRoot, "evidence/screenshots");
  const players = [];
  const sessionNames = [];
  try {
    for (const alias of ACTORS) {
      assertLive(signal);
      const sessionName = managedSessionName(stack.runId, alias);
      sessionNames.push(sessionName);
      const started = spawnSync(MANAGED_BROWSER_BIN, ["start", sessionName, stack.siteUrl, "--viewport", `${DESKTOP.width}x${DESKTOP.height}`, "--ttl", "3600", "--memory", "12G", "--cpu", "800%"], { encoding: "utf8", timeout: 60_000 });
      if (started.status !== 0) throw new EntryProofIncomplete("browserInfra", `managed browser ${alias} failed to start`);
      const session = parseManagedSession(started.stdout, sessionName);
      const browser = await loaded.chromium.connectOverCDP(`http://127.0.0.1:${session.cdp_port}`);
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      if (!context || !page) throw new EntryProofIncomplete("browserInfra", `managed browser ${alias} has no page`);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true });
      emit({ type: "browser.tls", actor: alias, mode: "loopback-self-signed-cdp" });
      await page.setViewportSize(DESKTOP);
      page.setDefaultTimeout(OBSERVE_MS);
      await page.addInitScript(messageProbeScript);
      players.push(new BrowserPlayer({ alias, page, context, browser, cdp, siteUrl: stack.siteUrl, releaseId: stack.releaseId, shardId: stack.shardId, privateRoot, screenshotRoot, emit, sessionName, registerSensitive: (values) => stack.registerSensitive?.(values) }));
    }
  } catch (error) {
    const cleanupFailures = [];
    for (const player of players) {
      try { await player.close({ cleanupAccount: false }); } catch (cleanupError) { cleanupFailures.push(`${player.alias}: ${cleanupError?.message ?? cleanupError}`); }
    }
    try { await stopManagedSessions(sessionNames); } catch (cleanupError) { cleanupFailures.push(String(cleanupError?.message ?? cleanupError)); }
    if (cleanupFailures.length) throw new EntryProofIncomplete("cleanup", "managed browser cleanup failed");
    throw error;
  }
  return {
    players: () => players,
    evidenceScreenshots: () => players.flatMap((player) => player.screenshotPaths),
    open: async () => {},
    close: async () => {
      const results = await Promise.allSettled(players.map((player) => player.close()));
      let stopFailure = null;
      try { await stopManagedSessions(sessionNames); } catch (error) { stopFailure = error; }
      const failed = results.filter((result) => result.status === "rejected");
      const persistent = failed.filter((result) => result.reason?.cleanupClass !== "managed-browser" || stopFailure);
      for (const result of persistent) emit({ type: "cleanup.failure", reasonClass: result.reason?.cleanupClass ?? "player" });
      if (stopFailure) emit({ type: "cleanup.failure", reasonClass: "managed-browser" });
      if (persistent.length || stopFailure) throw new Error(`${persistent.length + (stopFailure ? 1 : 0)} player cleanup(s) failed`);
    },
  };
}

function parseManagedSession(stdout, expectedName) {
  const lines = String(stdout ?? "").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (Number.isInteger(value.cdp_port) && value.cdp_port >= 1024 && value.cdp_port <= 65535 && value.name === expectedName) return value;
    } catch { /* try earlier line */ }
  }
  throw new EntryProofIncomplete("browserInfra", "managed browser returned no matching session record");
}

export async function stopManagedSessions(names, command = managedBrowserCommand, wait = delay) {
  const failures = [];
  for (const name of new Set(names)) {
    let stopped = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      command(["stop", name]);
      if (!managedSessionPresent(command(["status"]), name)) {
        stopped = true;
        break;
      }
      if (attempt < 11) await wait(500);
    }
    if (!stopped) failures.push(name);
  }
  if (failures.length) throw new Error(`managed browser survivors: ${failures.length}`);
  return { ok: true };
}

function managedBrowserCommand(argv) {
  return spawnSync(MANAGED_BROWSER_BIN, argv, { encoding: "utf8", timeout: 60_000 });
}
function managedSessionPresent(result, expectedName) {
  if (!result || result.status !== 0) return true;
  const output = String(result.stdout ?? "").trim();
  if (!output) return false;
  try {
    const value = JSON.parse(output);
    return Array.isArray(value?.sessions) && value.sessions.some((session) => session?.name === expectedName);
  } catch { return true; }
}

class BrowserPlayer {
  constructor({ alias, page, context, browser, cdp, siteUrl, releaseId, shardId, privateRoot, screenshotRoot, emit, sessionName, registerSensitive }) {
    this.alias = alias;
    this.page = page;
    this.context = context;
    this.browser = browser;
    this.cdp = cdp;
    this.registerSensitive = registerSensitive ?? (() => {});
    this.siteUrl = siteUrl;
    try { this.siteOrigin = new URL(siteUrl).origin; } catch { this.siteOrigin = null; }
    this.releaseId = releaseId;
    this.shardId = shardId;
    this.privateRoot = privateRoot;
    this.screenshotRoot = screenshotRoot;
    this.screenshotPaths = [];
    this.webSockets = [];
    this.emit = emit;
    this.sessionName = sessionName;
    this.network = [];
    this.password = null;
    this.callsign = null;
    this.csrfToken = null;
    this.registered = false;
    this.creatorFrame = null;
    this.gameFrame = null;
    this.macroMutations = { post: 0, delete: 0 };
    page.on("websocket", (socket) => {
      let pathname = "invalid";
      try { const parsed = new URL(socket.url()); pathname = `${parsed.origin}${parsed.pathname}`; } catch { /* retain invalid */ }
      const state = { endpoint: pathname.slice(0, 120), state: "open" };
      this.webSockets.push(state);
      socket.on("close", () => { state.state = "closed"; });
      socket.on("socketerror", () => { state.state = "error"; });
    });
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/client/release.json") this.network.push("pointer");
      else if (pathname.endsWith("/play-ticket")) this.network.push("ticket");
    });
    page.on("response", (response) => {
      observeSuccessfulParentMacroResponse(this.macroMutations, response, {
        siteOrigin: this.siteOrigin,
        page: this.page,
      });
    });
  }
  async close({ cleanupAccount = true } = {}) {
    let cleanupError = null;
    if (cleanupAccount && this.registered && this.password) {
      try {
        await this.restoreAccountSessionForCleanup();
        await this.page.locator("#delete-password").fill(this.password);
        await this.page.locator("#delete-confirm").check();
        const deletionResponse = this.page.waitForResponse((response) => {
          try { return new URL(response.url()).pathname.endsWith("/account") && response.request().method() === "DELETE"; }
          catch { return false; }
        });
        await this.page.locator("#delete-form button[type=submit]").click();
        const deletion = await deletionResponse;
        if (deletion.status() !== 202) throw new Error(`account deletion returned ${deletion.status()}`);
        this.registered = false;
        await this.page.waitForFunction(() => document.body.dataset.sessionState !== "active", undefined, { timeout: 20_000 });
      } catch (error) {
        cleanupError = sanitizeCleanupError(error, this.alias);
      }
    }
    let browserCleanupError = null;
    try { await stopManagedSessions([this.sessionName]); } catch (error) { browserCleanupError = error; }
    await this.browser.close().catch(() => {});
    this.password = null;
    this.callsign = null;
    if (cleanupError) throw Object.assign(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)), { cleanupClass: "account" });
    if (browserCleanupError) throw Object.assign(new Error(`managed browser ${this.alias} did not stop`), { cleanupClass: "managed-browser" });
  }

  async restoreAccountSessionForCleanup() {
    await ensureActiveAccountSessionForCleanup(this.page, {
      siteUrl: this.siteUrl,
      callsign: this.callsign,
      password: this.password,
      alias: this.alias,
    });
  }

  async register() {
    await this.page.goto(new URL("/account/", this.siteUrl).href, { waitUntil: "domcontentloaded" });
    const suffix = crypto.randomBytes(6).toString("hex");
    const callsign = `rc${suffix}`;
    this.callsign = callsign;
    this.password = crypto.randomBytes(32).toString("base64url");
    await this.page.locator("#reg-callsign").fill(callsign);
    await this.page.locator("#reg-password").fill(this.password);
    await this.page.locator("#reg-password-repeat").fill(this.password);
    await this.page.locator("#reg-legal").check();
    this.registerSensitive([this.password]);
    const registrationResponse = this.page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/register") && response.request().method() === "POST");
    await this.page.locator("#register-form button[type=submit]").click();
    const registration = await registrationResponse;
    if (registration.status() !== 201) throw new EntryProofFailure("register", `registration returned ${registration.status()}`);
    this.registered = true;
    await this.page.locator("body[data-session-state=active]").waitFor();
    await this.page.locator("#creator-stage iframe").waitFor();
    this.creatorFrame = await stageFrame(this.page, "#creator-stage iframe");
  }
  async creator() {
    const frame = await childFrame(this.page, "mode=creator");
    this.creatorFrame = frame;
    await frame.waitForFunction(() => window.__successor3dCharacterSelect?.serverOnline === true);
    await frame.locator('[data-ref="newButton"]').click();
    const name = CHARACTER_NAMES[this.alias] ?? `Mara-${this.alias}`;
    await frame.locator('[data-ref="nameInput"]').fill(name);
    await frame.locator(`[data-ref="createProfessionGrid"] [data-profession-id="${CHARACTER_PROFESSIONS[this.alias] ?? "scout"}"]`).click();
    await frame.locator('[data-ref="faceRandomize"]').click();
    await frame.locator('[data-ref="createButton"]:not([disabled])').click();
    await frame.waitForFunction(() => window.__successor3dCharacterSelect?.mode === "select" && window.__successor3dCharacterSelect?.characterCount === 1 && window.__successor3dCharacterSelect?.lastError === null);
    const parentMessages = await this.page.evaluate(() => window.__rcMessageLog ?? []);
    return { probeAvailable: true, created: true, handshake: parentMessages.some(({ type }) => type === "successor.creator.ready.v1"), characterId: await frame.evaluate(() => window.__successor3dCharacterSelect?.selectedId ?? null) };
  }
  async logoutLogin() {
    if (typeof this.callsign !== "string" || this.callsign.length === 0 || typeof this.password !== "string" || this.password.length === 0) {
      throw new EntryProofIncomplete("logoutLogin", "private callsign/password unavailable for logout/login");
    }
    const expectedCharacterId = typeof this.createdCharacterId === "string" && this.createdCharacterId.length > 0 ? this.createdCharacterId : null;
    await this.page.goto(new URL("/account/", this.siteUrl).href, { waitUntil: "domcontentloaded" });
    await this.page.locator("body[data-session-state=active]").waitFor({ timeout: 20_000 });
    const logoutResponse = this.page.waitForResponse((response) => {
      try { return new URL(response.url()).pathname.endsWith("/logout") && response.request().method() === "POST"; }
      catch { return false; }
    });
    await this.page.locator("#logout-button").click();
    const logout = await logoutResponse;
    if (logout.status() < 200 || logout.status() >= 300) throw new EntryProofFailure("logoutLogin", `logout returned ${logout.status()}`);
    await this.page.waitForFunction(() => document.body.dataset.sessionState !== "active", undefined, { timeout: 20_000 });
    await this.page.locator("#login-callsign").waitFor({ timeout: 20_000 });
    await this.page.locator("#login-callsign").fill(this.callsign);
    await this.page.locator("#login-password").fill(this.password);
    const loginResponse = this.page.waitForResponse((response) => {
      try { return new URL(response.url()).pathname.endsWith("/login") && response.request().method() === "POST"; }
      catch { return false; }
    });
    await this.page.locator("#login-form button[type=submit]").click();
    const login = await loginResponse;
    if (login.status() !== 200) throw new EntryProofFailure("logoutLogin", `login returned ${login.status()}`);
    await this.page.locator("body[data-session-state=active]").waitFor({ timeout: 20_000 });
    await this.page.locator("#creator-stage iframe").waitFor({ timeout: 20_000 });
    this.creatorFrame = await stageFrame(this.page, "#creator-stage iframe");
    const frame = await childFrame(this.page, "mode=creator");
    this.creatorFrame = frame;
    await frame.waitForFunction(() => window.__successor3dCharacterSelect?.serverOnline === true && window.__successor3dCharacterSelect?.mode === "select" && Number(window.__successor3dCharacterSelect?.characterCount ?? 0) >= 1, undefined, { timeout: OBSERVE_MS });
    if (expectedCharacterId) {
      const selected = await frame.evaluate((id) => window.__successor3dCharacterSelect?.selectedId === id, expectedCharacterId);
      if (!selected) {
        const row = frame.locator(`[data-character-id="${expectedCharacterId}"]`);
        if (await row.count()) await row.click();
      }
      await frame.waitForFunction((id) => window.__successor3dCharacterSelect?.selectedId === id && window.__successor3dCharacterSelect?.characterCount >= 1, expectedCharacterId, { timeout: OBSERVE_MS });
    }
    const state = await frame.evaluate((expectedId) => {
      const probe = window.__successor3dCharacterSelect;
      const enter = document.querySelector('[data-ref="enterButton"]');
      const selectedId = probe?.selectedId ?? null;
      return {
        mode: probe?.mode ?? null,
        characterCount: Number(probe?.characterCount ?? 0),
        selectedMatches: expectedId ? selectedId === expectedId : typeof selectedId === "string" && selectedId.length > 0,
        enterEnabled: enter instanceof HTMLButtonElement && !enter.disabled,
      };
    }, expectedCharacterId);
    if (state.mode !== "select" || state.characterCount < 1) throw new EntryProofFailure("logoutLogin", "creator roster missing after login");
    if (state.selectedMatches !== true) throw new EntryProofFailure("logoutLogin", "created character was not selected after login");
    if (state.enterEnabled !== true) throw new EntryProofFailure("logoutLogin", "enter control was not enabled after login");
    return { probeAvailable: true, loggedOut: true, loggedIn: true, rosterPresent: true, selected: true, enterEnabled: true };
  }
  async hostedMacroCrud() {
    if (this.alias !== "p1") throw new EntryProofIncomplete("hostedMacros", "hosted macro CRUD requires the P1 proof actor");
    const frame = await this.currentGameFrame();
    const postsBefore = this.macroMutations.post;
    const deletesBefore = this.macroMutations.delete;
    const before = await frame.evaluate(() => {
      const api = window.__successor3dMacros;
      return {
        bound: Boolean(api && typeof api.save === "function" && typeof api.delete === "function" && typeof api.list === "function"),
        version: Number(api?.version ?? 0),
        count: Array.isArray(api?.list?.()) ? api.list().length : 0,
        phase: typeof api?.storePhase === "string" ? api.storePhase : null,
      };
    });
    if (!before.bound) throw new EntryProofIncomplete("hostedMacros", "window.__successor3dMacros parent-bound API unavailable");
    if (before.phase === "unbound" || before.phase === "link_down") throw new EntryProofFailure("hostedMacros", "macro store is not parent-bound for hosted CRUD");
    const name = `rc${crypto.randomBytes(4).toString("hex")}`;
    const body = "/stand";
    const saveResult = await frame.evaluate(async (input) => {
      const api = window.__successor3dMacros;
      const result = await api.save(input);
      const list = api.list();
      return {
        ok: result?.ok === true,
        version: Number(api.version ?? 0),
        count: list.length,
        phase: typeof api.storePhase === "string" ? api.storePhase : null,
        present: list.some((row) => row?.name === input.name),
        id: typeof result?.macro?.id === "string" ? result.macro.id : null,
      };
    }, { name, body });
    if (saveResult.ok !== true || saveResult.present !== true || typeof saveResult.id !== "string" || saveResult.id.length === 0) {
      throw new EntryProofFailure("hostedMacros", "hosted macro save did not persist into the bound store list");
    }
    if (!(saveResult.version > before.version) || !(saveResult.count > before.count)) {
      throw new EntryProofFailure("hostedMacros", "hosted macro save did not advance store version/list count");
    }
    await waitUntil(() => this.macroMutations.post > postsBefore, "parent macro POST", OBSERVE_MS, "hostedMacros");
    const deleteResult = await frame.evaluate(async (id) => {
      const api = window.__successor3dMacros;
      const result = await api.delete(id);
      const list = api.list();
      return {
        ok: result?.ok === true,
        version: Number(api.version ?? 0),
        count: list.length,
        phase: typeof api.storePhase === "string" ? api.storePhase : null,
        absent: !list.some((row) => row?.id === id),
      };
    }, saveResult.id);
    if (deleteResult.ok !== true || deleteResult.absent !== true) {
      throw new EntryProofFailure("hostedMacros", "hosted macro delete did not remove the saved macro");
    }
    if (!(deleteResult.version > saveResult.version)) {
      throw new EntryProofFailure("hostedMacros", "hosted macro delete did not advance store version");
    }
    await waitUntil(() => this.macroMutations.delete > deletesBefore, "parent macro DELETE", OBSERVE_MS, "hostedMacros");
    return {
      probeAvailable: true,
      saved: true,
      deleted: true,
      parentPost: this.macroMutations.post > postsBefore,
      parentDelete: this.macroMutations.delete > deletesBefore,
      versionAdvanced: true,
      listCountAfterSave: saveResult.count,
      listCountAfterDelete: deleteResult.count,
      versionAfterSave: saveResult.version,
      versionAfterDelete: deleteResult.version,
    };
  }
  async rosterEnter() {
    if (!this.creatorFrame) throw new EntryProofFailure("roster", "creator frame missing before selection");
    const expectedCharacterId = typeof this.createdCharacterId === "string" && this.createdCharacterId.length > 0
      ? this.createdCharacterId
      : await this.creatorFrame.evaluate(() => window.__successor3dCharacterSelect?.selectedId ?? null);
    if (typeof expectedCharacterId !== "string" || expectedCharacterId.length === 0) {
      throw new EntryProofFailure("roster", "created character id unavailable before parent launch");
    }
    this.createdCharacterId = expectedCharacterId;
    this.network.length = 0;
    await this.creatorFrame.locator('[data-ref="enterButton"]:not([disabled])').click();
    await this.page.waitForURL((url) => url.pathname === "/play/");
    // The roster/workshop ENTER is the player's launch action. The one-shot
    // handoff now takes /play/ directly into the client; waiting for or
    // activating the fallback picker would reintroduce the retired second
    // confirmation stage. Ordering is certified below from parent network and
    // exact-window message probes.
    let frame;
    try {
      frame = await stableStageFrame(this.page, "#game-frame", async (candidate) => {
        if (await candidate.locator("canvas").count() === 0) return false;
        return candidate.evaluate(() => {
          const probe = window.__successor3d;
          return probe?.serverStatus === "connected" && Number(probe.tick ?? 0) > 0 && probe.authorityPlayer != null && Array.isArray(probe.authorityActorKeys);
        });
      }, "world-ready game frame", 60_000);
    } catch {
      const diagnostic = await stageDiagnostic(this.page, "#game-frame");
      diagnostic.webSockets = this.webSockets.map((value) => ({ ...value }));
      await this.screenshot("world-timeout").catch(() => {});
      this.emit({ type: "world.timeout", actor: this.alias, diagnostic });
      throw new EntryProofFailure("worldReady", `world-ready timeout: ${JSON.stringify(diagnostic)}`);
    }
    this.gameFrame = frame;
    const parentMessages = await this.page.evaluate(() => window.__rcMessageLog ?? []);
    const childMessages = await frame.evaluate(() => window.__rcMessageLog ?? []);
    const pointer = this.network.indexOf("pointer");
    const ticket = this.network.indexOf("ticket");
    const readyAt = parentMessages.find(({ type }) => type === "successor.client.ready.v1")?.at;
    const launchAt = childMessages.find(({ type }) => type === "successor.launch.v1")?.at;
    const authority = await frame.evaluate(() => ({ ownKey: window.__successor3d?.playerActorId ?? null, visibleKeys: [...(window.__successor3d?.authorityActorKeys ?? [])] }));
    return { probeAvailable: true, pointerBeforeTicket: pointer >= 0 && ticket > pointer, clientReadyBeforeLaunch: Number.isFinite(readyAt) && Number.isFinite(launchAt) && launchAt >= readyAt, launchSent: Number.isFinite(launchAt), worldReady: true, runtimeActorKey: authority.ownKey, visibleActorKeys: authority.visibleKeys };
  }
  async mintTuiLaunch() {
    const characterId = await this.creatorFrame?.evaluate(() => window.__successor3dCharacterSelect?.selectedId ?? null);
    if (typeof characterId !== "string" || characterId.length === 0) throw new EntryProofIncomplete("tuiWorldReady", "created character identity unavailable");
    if (this.createdCharacterId && this.createdCharacterId !== characterId) throw new EntryProofFailure("tuiWorldReady", "TUI actor is not the selected browser character");
    const csrf = await this.page.evaluate(async () => {
      const response = await fetch("/alpha-api/csrf", { credentials: "same-origin", cache: "no-store" });
      const body = await response.json().catch(() => null);
      return response.ok && body && typeof body.csrfToken === "string" ? body.csrfToken : null;
    });
    if (typeof csrf !== "string" || csrf.length === 0) throw new EntryProofIncomplete("tuiWorldReady", "browser CSRF token unavailable");
    this.csrfToken = csrf;
    this.registerSensitive([csrf]);
    const launch = await this.page.evaluate(async ({ characterId: id, shardId, clientReleaseId, csrfToken }) => {
      const response = await fetch("/alpha-api/play-ticket", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ characterId: id, shardId, clientReleaseId }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, { characterId, shardId: this.shardId, clientReleaseId: this.releaseId, csrfToken: this.csrfToken });
    this.csrfToken = null;
    const body = launch.body;
    if (launch.status !== 200 || !body || typeof body.gameTicket !== "string" || typeof body.characterId !== "string" || typeof body.endpoints?.game !== "string") throw new EntryProofIncomplete("tuiWorldReady", "one-use TUI launch was unavailable");
    this.registerSensitive([body.gameTicket, typeof body.chatTicket === "string" ? body.chatTicket : ""]);
    assertPlayTicketCharacter(characterId, body);
    return { gameTicket: body.gameTicket, characterId: body.characterId, origin: this.siteUrl, endpoints: { game: body.endpoints.game } };
  }

  async observeSharedWorld(actorKeys) {
    if (!Array.isArray(actorKeys) || actorKeys.length !== ACTORS.length) throw new EntryProofIncomplete("sharedWorld", "expected actor keys unavailable");
    const frame = await this.currentGameFrame();
    await waitUntil(() => frame.evaluate((keys) => keys.every((key) => (window.__successor3d?.authorityActorKeys ?? []).includes(key)), actorKeys), "mutual authority actor projection");
    return { probeAvailable: true, mutualProjection: true };
  }
  async equipmentRoundTrip() {
    const frame = await this.currentGameFrame();
    await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyI", key: "i", bubbles: true })));
    await frame.locator('.sc3d-window[data-window="inventory"]').waitFor({ state: "visible" });
    const wornKey = "boots_canvas_ankle";
    await frame.waitForFunction((key) => (window.__successor3dInventoryPaperDollEquipmentIds ?? []).includes(key) && (window.__successor3d?.localEquipmentIds ?? []).includes(key), wornKey);
    const row = frame.locator('.inv-slot[data-item-id="7319"]');
    await row.waitFor();
    const before = await equipmentProjection(frame, wornKey);
    if (!before.authority || !before.doll || !before.pawn) throw new EntryProofFailure("equipmentAuthority", "starter boots missing before unequip");
    await row.click();
    await frame.locator('[data-ref="actionBtn"]:not([hidden]):not([disabled])').click();
    await waitUntil(async () => {
      const next = await equipmentProjection(frame, wornKey);
      if (next.rejected > before.rejected) throw new EntryProofFailure("equipmentAuthority", `authority rejected unequip: ${next.lastReason ?? "unknown"}`);
      return next.accepted > before.accepted && !next.authority && !next.doll && !next.pawn;
    }, "authority equipment unequip");
    const unequipped = await equipmentProjection(frame, wornKey);
    await row.click();
    await frame.locator('[data-ref="actionBtn"]:not([hidden]):not([disabled])').click();
    await waitUntil(async () => {
      const next = await equipmentProjection(frame, wornKey);
      if (next.rejected > unequipped.rejected) throw new EntryProofFailure("equipmentAuthority", `authority rejected re-equip: ${next.lastReason ?? "unknown"}`);
      return next.accepted > unequipped.accepted && next.authority && next.doll && next.pawn;
    }, "authority equipment re-equip");
    const restored = await equipmentProjection(frame, wornKey);
    await pressFrameKey(frame, "KeyI", "i");
    await frame.locator('.sc3d-window[data-window="inventory"]').waitFor({ state: "hidden" });
    return { probeAvailable: true, authorityChanged: !unequipped.authority, authorityRestored: restored.authority, dollChanged: !unequipped.doll, dollRestored: restored.doll, pawnChanged: !unequipped.pawn, pawnRestored: restored.pawn };
  }
  async sendSpatialChat() {
    const frame = await this.currentGameFrame();
    const marker = `rc-${crypto.randomBytes(12).toString("base64url")}`;
    this.registerSensitive([marker]);
    const input = frame.locator("#chat-input, input.sc3d-chat-input");
    await input.fill(marker);
    await input.press("Enter");
    return { probeAvailable: true };
  }
  async observeSpatialChat(actorKey) {
    if (typeof actorKey !== "string" || actorKey.length === 0) throw new EntryProofIncomplete("chatOwnership", "speaker actor key unavailable");
    const frame = await this.currentGameFrame();
    await waitUntil(() => frame.evaluate((key) => (window.__successor3d?.bubbleActorKeys ?? []).includes(key), actorKey), "remote spatial bubble anchor");
    const correctAnchor = await frame.evaluate((key) => (window.__successor3d?.bubbleActorKeys ?? []).includes(key) && window.__successor3d?.playerActorId !== key, actorKey);
    return { probeAvailable: true, correctAnchor };
  }
  async disconnectGame() {
    const frame = await this.currentGameFrame();
    this.disconnectedActorKey = await frame.evaluate(() => window.__successor3d?.playerActorId ?? null);
    if (typeof this.disconnectedActorKey !== "string") throw new EntryProofIncomplete("linkDeadSet", "disconnect actor key unavailable");
    await this.cdp.send("Network.enable");
    await this.cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await delay(750);
  }
  async observeLinkDead(actorKey, expected) {
    if (typeof actorKey !== "string" || actorKey.length === 0) throw new EntryProofIncomplete(expected ? "linkDeadSet" : "linkDeadCleared", "observer actor key unavailable");
    const frame = await this.currentGameFrame();
    await waitUntil(() => frame.evaluate(({ key, value }) => window.__successor3dActorLinkDead?.(key) === value, { key: actorKey, value: expected }), `link-dead ${expected}`);
    return { probeAvailable: true, observed: true };
  }
  async reconnectGame() {
    if (typeof this.disconnectedActorKey !== "string") throw new EntryProofIncomplete("linkDeadCleared", "reconnect actor key unavailable");
    await this.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await this.cdp.send("Network.disable");
    await waitUntil(() => this.page.evaluate(() => fetch("/healthz", { cache: "no-store" }).then((response) => response.ok).catch(() => false)), "network restoration");
    await this.page.goto(new URL("/play/", this.siteUrl).href, { waitUntil: "domcontentloaded" });
    try {
      await this.page.locator("body[data-session-state=active]").waitFor({ timeout: 60_000 });
      await this.page.locator("#launch-character option").first().waitFor({ state: "attached", timeout: 60_000 });
    } catch {
      await this.screenshot("link-reconnect-timeout").catch(() => {});
      const diagnostic = await this.page.evaluate(() => ({ sessionState: document.body.dataset.sessionState ?? "absent", optionCount: document.querySelectorAll("#launch-character option").length, apiNotice: document.querySelector("#api-status")?.hasAttribute("hidden") === false }));
      this.emit({ type: "link.reconnect.timeout", actor: this.alias, diagnostic });
      throw new EntryProofFailure("linkDeadCleared", `reconnect roster timeout: ${JSON.stringify(diagnostic)}`);
    }
    await this.page.locator('#launch-form button[type="submit"]').click();
    const frame = await stableStageFrame(this.page, "#game-frame", (candidate) => candidate.evaluate(() => {
      const probe = window.__successor3d;
      return probe?.serverStatus === "connected" && Number(probe.tick ?? 0) > 0 && probe.authorityPlayer != null;
    }), "reconnected authority world");
    this.gameFrame = frame;
    const actorKey = await frame.evaluate(() => window.__successor3d?.playerActorId ?? null);
    return { probeAvailable: true, sameActor: actorKey === this.disconnectedActorKey };
  }
  async trainerXpRoundTrip() {
    if (this.alias !== "p1") throw new EntryProofIncomplete("trainerReject", "trainer journey requires the Craftsman proof actor");
    await this.page.bringToFront();
    const frame = await this.currentGameFrame();
    await moveToCampTrainer(frame, this.emit, this.page);
    await openCampTrainer(frame, this.page);

    await frame.locator('.sc3d-window[data-window="converse"] [data-option="teach"]').click();
    const skill = frame.locator('.sc3d-window[data-window="converse"] [data-option="train:craftsman-survey-i"]');
    await frame.locator('.sc3d-window[data-window="converse"] [data-option="back"]').waitFor();
    const purchasesBefore = await receiptKindCount(frame, "PurchaseSkillBox");
    if (await skill.count() !== 0) {
      throw new EntryProofFailure("trainerReject", "Survey I was visible before the player earned its required XP");
    }
    await frame.locator('.sc3d-window[data-window="converse"] [data-option="back"]').click();
    await delay(250);
    const insufficientXpBlocked = await receiptKindCount(frame, "PurchaseSkillBox") === purchasesBefore;
    if (!insufficientXpBlocked) throw new EntryProofFailure("trainerReject", "hidden Survey I emitted an authority purchase command");
    this.emit({ type: "trainer.hidden", actor: this.alias, reasonClass: "insufficient-profession-xp", authorityCommandSent: !insufficientXpBlocked });

    await frame.locator('.sc3d-window[data-window="converse"] [data-option="tools"]').click();
    const starterTool = frame.locator('.sc3d-window[data-window="converse"] [data-option="starter-tool"]');
    if (await starterTool.count()) {
      await starterTool.click();
      await waitUntil(() => frame.evaluate(() => window.__successor3d?.authorityReceiptTail?.some((entry) => entry.kind === "RequestStarterTool" && entry.accepted === true) === true), "accepted starter-tool authority receipt");
    }
    await frame.locator('.sc3d-window[data-window="converse"] .sc3d-window-close').click();

    await pressFrameKey(frame, "KeyB", "b");
    const sampleAction = frame.locator('.sc3d-window[data-window="actions"] [data-action="sample"]');
    await sampleAction.waitFor();
    await sampleAction.dblclick();
    await frame.locator('.sc3d-toolbar [data-slot="0"]').click();
    const sampleButton = frame.locator('.sc3d-window[data-window="surveyTool"] [data-ref="sampleBtn"]');
    await sampleButton.waitFor();
    const xpBefore = await frame.evaluate(() => window.__successor3dProfessionTrackXp?.("craftsman", "survey") ?? null);
    if (xpBefore !== 0) throw new EntryProofFailure("trainerReject", `fresh Craftsman survey XP was ${xpBefore ?? "unavailable"}, expected 0`);
    await sampleButton.click();
    await waitUntil(() => frame.evaluate(() => window.__successor3d?.authorityReceiptTail?.some((entry) => entry.kind === "SampleResource" && entry.accepted === true) === true), "accepted hand-sample authority receipt");
    await waitUntil(() => frame.evaluate(() => (window.__successor3dProfessionTrackXp?.("craftsman", "survey") ?? 0) >= 100), "authority Craftsman survey XP", 60_000);
    const xpAfter = await frame.evaluate(() => window.__successor3dProfessionTrackXp?.("craftsman", "survey") ?? null);
    this.emit({ type: "trainer.xp", actor: this.alias, profession: "craftsman", track: "survey", source: "hand-sample", before: xpBefore, after: xpAfter });
    await frame.locator('.sc3d-window[data-window="surveyTool"] .sc3d-window-close').click();
    await frame.locator('.sc3d-window[data-window="actions"] .sc3d-window-close').click();
    await stopHandSamplingLoop(frame, this.emit);

    await openCampTrainer(frame, this.page);
    await frame.locator('.sc3d-window[data-window="converse"] [data-option="teach"]').click();
    const unlockedSkill = frame.locator('.sc3d-window[data-window="converse"] [data-option="train:craftsman-survey-i"]');
    await unlockedSkill.waitFor();
    if (await unlockedSkill.getAttribute("aria-disabled") === "true") throw new EntryProofFailure("trainerSuccess", "Survey I remained disabled after authority XP");
    const acceptedBefore = await receiptKindCount(frame, "PurchaseSkillBox", true);
    let rejectedSeen = await receiptKindCount(frame, "PurchaseSkillBox", false);
    let purchased = false;
    for (let attempt = 0; attempt < 20 && !purchased; attempt += 1) {
      await unlockedSkill.click();
      const result = await waitUntilValue(async () => {
        const current = await frame.evaluate(() => {
          const receipts = (window.__successor3d?.authorityReceiptTail ?? []).filter((entry) => entry.kind === "PurchaseSkillBox");
          return {
            accepted: receipts.filter((entry) => entry.accepted === true).length,
            rejected: receipts.filter((entry) => entry.accepted === false).length,
            lastReason: receipts.at(-1)?.reasonCode ?? null,
            lastTick: receipts.at(-1)?.tick ?? null,
            learned: window.__successor3dHasSkillBox?.("craftsman-survey-i") === true,
          };
        });
        return current.accepted > acceptedBefore || current.rejected > rejectedSeen ? current : null;
      }, "authority trainer purchase receipt", 5_000);
      if (result.accepted > acceptedBefore) {
        if (!result.learned) await waitUntil(() => frame.evaluate(() => window.__successor3dHasSkillBox?.("craftsman-survey-i") === true), "learned trainer skill projection");
        purchased = true;
        break;
      }
      if (result.lastReason !== "economy_cooldown") throw new EntryProofFailure("trainerSuccess", `authority rejected trainer purchase: ${result.lastReason ?? "unknown"}`);
      rejectedSeen = result.rejected;
      this.emit({ type: "trainer.cooldown", actor: this.alias, reasonClass: "economy-cooldown", retry: attempt + 1 });
      if (typeof result.lastTick !== "number") throw new EntryProofFailure("trainerSuccess", "economy cooldown receipt lacked authority tick");
      await waitUntil(() => frame.evaluate((goal) => Number(window.__successor3d?.tick ?? 0) >= goal, result.lastTick + 15), "authority economy cooldown progress", 3_000);
    }
    if (!purchased) throw new EntryProofFailure("trainerSuccess", "authority economy cooldown did not clear after bounded retries");
    const acceptedAfter = await receiptKindCount(frame, "PurchaseSkillBox", true);
    const learned = await frame.evaluate(() => window.__successor3dHasSkillBox?.("craftsman-survey-i") === true);
    this.emit({ type: "trainer.accepted", actor: this.alias, skill: "craftsman-survey-i", authorityReceipt: acceptedAfter > acceptedBefore, learned });
    return { probeAvailable: true, insufficientXpBlocked, earnedAuthorityXp: Number(xpAfter) >= 100, acceptedAfterXp: acceptedAfter > acceptedBefore && learned };
  }
  async currentGameFrame() {
    if (this.gameFrame && !this.gameFrame.isDetached()) return this.gameFrame;
    this.gameFrame = await stageFrame(this.page, "#game-frame");
    return this.gameFrame;
  }
  async measureStage(stage, viewport) {
    const selector = stage === "creator" ? "#creator-stage iframe" : "#game-frame";
    const gate = stage === "creator" ? "creatorStageDesktop" : "playStageDesktop";
    if (viewport.width !== DESKTOP.width) await this.page.setViewportSize(viewport);
    try {
      const deadline = Date.now() + OBSERVE_MS;
      while (Date.now() <= deadline) {
        try {
          const frame = await stableStageFrame(this.page, selector, (candidate) => candidate.evaluate(() => Boolean(document.querySelector("canvas"))), `${stage} stage canvas`, 5_000);
          const measurement = await measureFrame(this.page, frame, viewport, selector);
          if (measurement.probeAvailable) {
            if (stage === "creator") this.creatorFrame = frame;
            else this.gameFrame = frame;
            return measurement;
          }
        } catch (error) {
          if (!/execution context was destroyed|frame was detached|cannot find context|timeout|timed out/iu.test(String(error?.message ?? error))) throw error;
        }
        await delay(100);
      }
      throw new EntryProofIncomplete(gate, `${stage} frame unavailable`);
    } finally { if (viewport.width !== DESKTOP.width) await this.page.setViewportSize(DESKTOP); }
  }
  async measureMobileStage(stage, viewport) { try { return await this.measureStage(stage, viewport); } catch { return null; } }
  async liveness() {
    await this.page.bringToFront();
    const deadline = Date.now() + OBSERVE_MS;
    while (Date.now() <= deadline) {
      const frame = this.gameFrame && !this.gameFrame.isDetached() ? this.gameFrame : this.creatorFrame && !this.creatorFrame.isDetached() ? this.creatorFrame : null;
      if (!frame) { await delay(100); continue; }
      try {
        const result = await frame.evaluate(() => new Promise((resolve) => { let raf = 0; const next = () => { raf += 1; if (raf >= 2) resolve({ probeAvailable: true, visible: document.visibilityState === "visible", raf }); else requestAnimationFrame(next); }; requestAnimationFrame(next); setTimeout(() => resolve({ probeAvailable: true, visible: document.visibilityState === "visible", raf }), 1200); }));
        if (Number(result?.raf) >= 2) return result;
        await delay(100);
      } catch (error) {
        if (!/execution context was destroyed|frame was detached|cannot find context/iu.test(String(error?.message ?? error))) throw error;
        await delay(100);
      }
    }
    return { probeAvailable: false };
  }
  async screenshot(label = "stage") {
    if (!this.screenshotRoot) return null;
    const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "stage";
    const name = `${this.alias}-${safeLabel}.png`;
    await this.page.screenshot({ path: path.join(this.screenshotRoot, name), fullPage: false });
    const relative = `screenshots/${name}`;
    if (!this.screenshotPaths.includes(relative)) this.screenshotPaths.push(relative);
    return relative;
  }
}

async function pressFrameKey(frame, code, key) {
  await frame.evaluate(({ code: eventCode, key: eventKey }) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: eventCode, key: eventKey, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: eventCode, key: eventKey, bubbles: true }));
  }, { code, key });
}

async function moveAxisTo(frame, axis, target, code, key, direction) {
  const reached = (value) => direction < 0 ? value <= target : value >= target;
  const start = await frame.evaluate((name) => window.__successor3d?.authorityPlayer?.[name] ?? null, axis);
  if (typeof start !== "number" || reached(start)) return;
  await frame.evaluate(({ eventCode, eventKey }) => window.dispatchEvent(new KeyboardEvent("keydown", { code: eventCode, key: eventKey, bubbles: true })), { eventCode: code, eventKey: key });
  try {
    await waitUntil(() => frame.evaluate(({ name, goal, sign }) => {
      const value = window.__successor3d?.authorityPlayer?.[name];
      return typeof value === "number" && (sign < 0 ? value <= goal : value >= goal);
    }, { name: axis, goal: target, sign: direction }), `movement ${axis} to trainer`, 45_000);
  } catch (error) {
    const end = await frame.evaluate((name) => window.__successor3d?.authorityPlayer?.[name] ?? null, axis).catch(() => null);
    throw new EntryProofFailure("trainerReject", `movement ${axis} to trainer stalled from ${start.toFixed(3)} at ${typeof end === "number" ? end.toFixed(3) : "unavailable"}`);
  } finally {
    await frame.evaluate(({ eventCode, eventKey }) => window.dispatchEvent(new KeyboardEvent("keyup", { code: eventCode, key: eventKey, bubbles: true })), { eventCode: code, eventKey: key }).catch(() => {});
  }
}

/**
 * Plan axis-separated interior commerce-facility legs to trainer stand from entry position.
 * Moves north along x=506 clear corridor to y=503.0, then east along y=503.0 lane to trainer stand (510.6, 503.0).
 * @param {{x:number,y:number}|null|undefined} position
 * @returns {{step:string,x:number,y:number,axisOrder:("x"|"y")[],tolerance:number}[]}
 */
export function planTrainerInteriorRoute(position = { x: 506, y: 508 }) {
  const startX = typeof position?.x === "number" ? position.x : 506;
  const startY = typeof position?.y === "number" ? position.y : 508;
  const legs = [];
  let curX = startX;
  let curY = startY;

  if (Math.abs(curY - 503.0) > 0.35) {
    legs.push({
      step: "trainer-north-corridor",
      x: 506,
      y: 503.0,
      axisOrder: ["y", "x"],
      tolerance: 0.35,
    });
    curX = 506;
    curY = 503.0;
  }

  if (Math.abs(curX - TRAINER_STAND.x) > 0.35 || Math.abs(curY - TRAINER_STAND.y) > 0.35) {
    legs.push({
      step: "trainer-stand-approach",
      x: TRAINER_STAND.x,
      y: TRAINER_STAND.y,
      axisOrder: ["x", "y"],
      tolerance: 0.35,
    });
  }

  return legs;
}

export function planTrainerCloneExitRoute(position) {
  if (!position || typeof position.x !== "number" || typeof position.y !== "number") return [];
  if (Math.hypot(position.x - TRAINER_STAND.x, position.y - TRAINER_STAND.y) <= 1.5) return [];
  if (Math.hypot(position.x - TRAINER_COMMERCE_DOOR_APPROACH.x, position.y - TRAINER_COMMERCE_DOOR_APPROACH.y) <= 1.2) {
    return [];
  }

  const legs = [];
  let x = position.x;
  let y = position.y;
  const insideCloneBand = x >= 514 && y <= 510.8;
  const onExteriorSouth = y >= 511.2;

  if (insideCloneBand) {
    // Authored interior exit (bank-clone-corpse): clear left of terminal/pod before
    // joining x=518.5 corridor. Never drive x to 518.5 first while still in the pod lane.
    if (y < TRAINER_CLONE_SOUTH_PORTAL.y - 0.35) {
      const needsClearLeft = (
        Math.abs(x - TRAINER_CLONE_CLEAR_LEFT.x) > 0.45
        || Math.abs(y - TRAINER_CLONE_CLEAR_LEFT.y) > 0.45
        || x > TRAINER_CLONE_CLEAR_LEFT.x + 0.2
      ) && (y < TRAINER_CLONE_ENTRY.y + 0.2 || x > 517.4);
      if (needsClearLeft && (Math.abs(x - TRAINER_CLONE_ENTRY.x) > 0.55 || y < TRAINER_CLONE_ENTRY.y - 0.2)) {
        // From pod/respawn (~519,503): south at x~518.5 hits terminal/pod. Reach clear-left
        // stand first (west on north clear line, then south), then finish south on x=516.8 before east to entry corridor.
        legs.push({
          step: "clone-clear-left",
          x: TRAINER_CLONE_CLEAR_LEFT.x,
          y: TRAINER_CLONE_CLEAR_LEFT.y,
          axisOrder: ["x", "y"],
          tolerance: 0.45,
        });
        x = TRAINER_CLONE_CLEAR_LEFT.x;
        y = TRAINER_CLONE_CLEAR_LEFT.y;
      }
      if (Math.abs(x - TRAINER_CLONE_ENTRY.x) > 0.55 || y < TRAINER_CLONE_ENTRY.y - 0.35) {
        // Clear-left → entry needs simultaneous WASD (bank walkToCell); pure y-then-x stalls
        // against the pod corner at settled y≈505.15 / x≈516.8.
        legs.push({
          step: "clone-entry",
          x: TRAINER_CLONE_ENTRY.x,
          y: TRAINER_CLONE_ENTRY.y,
          axisOrder: ["y", "x"],
          drive: "point",
          tolerance: 0.45,
        });
        x = TRAINER_CLONE_ENTRY.x;
        y = TRAINER_CLONE_ENTRY.y;
      }
      legs.push({
        step: "clone-south-portal",
        x: TRAINER_CLONE_SOUTH_PORTAL.x,
        y: TRAINER_CLONE_SOUTH_PORTAL.y,
        axisOrder: ["x", "y"],
        tolerance: 0.5,
      });
      x = TRAINER_CLONE_SOUTH_PORTAL.x;
      y = TRAINER_CLONE_SOUTH_PORTAL.y;
    }
    if (y < TRAINER_CLONE_SOUTH_LANE.y - 0.4 || Math.abs(x - TRAINER_CLONE_SOUTH_LANE.x) > 0.6) {
      legs.push({
        step: "clone-south-lane",
        x: TRAINER_CLONE_SOUTH_LANE.x,
        y: TRAINER_CLONE_SOUTH_LANE.y,
        axisOrder: ["x", "y"],
        tolerance: 0.5,
      });
      x = TRAINER_CLONE_SOUTH_LANE.x;
      y = TRAINER_CLONE_SOUTH_LANE.y;
    }
  } else if (onExteriorSouth && x > 507) {
    // Already outside: never walk north into the facility. Hold exterior y≈512, optionally pin clone lane x.
    if (x >= 516 && (Math.abs(x - TRAINER_CLONE_SOUTH_LANE.x) > 0.6 || Math.abs(y - TRAINER_CLONE_SOUTH_LANE.y) > 0.6)) {
      legs.push({
        step: "clone-south-lane",
        x: TRAINER_CLONE_SOUTH_LANE.x,
        y: TRAINER_CLONE_SOUTH_LANE.y,
        axisOrder: ["y", "x"],
        tolerance: 0.5,
      });
      x = TRAINER_CLONE_SOUTH_LANE.x;
      y = TRAINER_CLONE_SOUTH_LANE.y;
    } else if (Math.abs(y - TRAINER_COMMERCE_SOUTH_LANE.y) > 0.55) {
      legs.push({
        step: "clone-south-lane",
        x,
        y: TRAINER_COMMERCE_SOUTH_LANE.y,
        axisOrder: ["y", "x"],
        tolerance: 0.5,
      });
      y = TRAINER_COMMERCE_SOUTH_LANE.y;
    }
  }

  // Exterior south lane west to commerce mouth (avoids SE corner clip), then north to door approach.
  if (x > TRAINER_COMMERCE_SOUTH_LANE.x + 0.45 || Math.abs(y - TRAINER_COMMERCE_SOUTH_LANE.y) > 0.55) {
    legs.push({
      step: "commerce-south-lane",
      x: TRAINER_COMMERCE_SOUTH_LANE.x,
      y: TRAINER_COMMERCE_SOUTH_LANE.y,
      axisOrder: ["y", "x"],
      tolerance: 0.5,
    });
    x = TRAINER_COMMERCE_SOUTH_LANE.x;
    y = TRAINER_COMMERCE_SOUTH_LANE.y;
  }

  if (Math.abs(x - TRAINER_COMMERCE_DOOR_APPROACH.x) > 0.35 || Math.abs(y - TRAINER_COMMERCE_DOOR_APPROACH.y) > 0.35) {
    legs.push({
      step: "door-approach",
      x: TRAINER_COMMERCE_DOOR_APPROACH.x,
      y: TRAINER_COMMERCE_DOOR_APPROACH.y,
      axisOrder: ["x", "y"],
      tolerance: 0.3,
    });
  }
  return legs;
}

async function readAuthorityPosition(frame) {
  return frame.evaluate(() => window.__successor3d?.authorityPlayer ? {
    x: window.__successor3d.authorityPlayer.x,
    y: window.__successor3d.authorityPlayer.y,
  } : null);
}

async function driveTrainerAxis(frame, axis, target, tolerance) {
  const negativeKey = axis === "x" ? ["KeyA", "a"] : ["KeyW", "w"];
  const positiveKey = axis === "x" ? ["KeyD", "d"] : ["KeyS", "s"];
  const start = await frame.evaluate((name) => window.__successor3d?.authorityPlayer?.[name] ?? null, axis);
  if (typeof start !== "number") throw new EntryProofIncomplete("trainerReject", `authority ${axis} position unavailable`);
  if (Math.abs(start - target) <= tolerance) return;
  const direction = start > target ? -1 : 1;
  const [code, key] = direction < 0 ? negativeKey : positiveKey;
  await moveAxisTo(frame, axis, target, code, key, direction);
  await settleAxisAfterIdle(frame, axis, target, negativeKey, positiveKey, tolerance);
}

function trainerPointKeys(dx, dy) {
  const keys = [];
  if (dy > 0.3) keys.push(["KeyS", "s"]);
  else if (dy < -0.3) keys.push(["KeyW", "w"]);
  if (dx > 0.3) keys.push(["KeyD", "d"]);
  else if (dx < -0.3) keys.push(["KeyA", "a"]);
  // Both axes inside deadzone but still outside tolerance: nudge dominant remainder.
  if (keys.length === 0) {
    if (Math.abs(dx) >= Math.abs(dy)) keys.push(dx >= 0 ? ["KeyD", "d"] : ["KeyA", "a"]);
    else keys.push(dy >= 0 ? ["KeyS", "s"] : ["KeyW", "w"]);
  }
  return keys;
}

async function pressTrainerKeys(frame, keys) {
  await frame.evaluate((pairs) => {
    for (const [code, key] of pairs) {
      window.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true }));
    }
  }, keys);
}

async function releaseTrainerKeys(frame, keys) {
  await frame.evaluate((pairs) => {
    for (const [code, key] of pairs) {
      window.dispatchEvent(new KeyboardEvent("keyup", { code, key, bubbles: true }));
    }
  }, keys);
}

/**
 * Bounded dual-axis authority drive for legs that cannot be pure cardinals
 * (mirrors bank-clone-corpse walkToCell hold of both WASD axes).
 * Only used for clear-left → clone-entry. No timeout/tolerance expansion.
 */
async function driveTrainerPoint(frame, targetX, targetY, tolerance, label) {
  const deadline = Date.now() + 45_000;
  let stalled = 0;
  let previous = null;
  while (Date.now() <= deadline) {
    const before = await readAuthorityPosition(frame);
    if (!before) throw new EntryProofIncomplete("trainerReject", `authority position unavailable during ${label}`);
    const dx = targetX - before.x;
    const dy = targetY - before.y;
    if (Math.hypot(dx, dy) <= tolerance) return before;
    const keys = trainerPointKeys(dx, dy);
    const pulseMs = Math.min(600, Math.max(120, Math.round(Math.hypot(dx, dy) * 200)));
    await pressTrainerKeys(frame, keys);
    try {
      await delay(pulseMs);
    } finally {
      await releaseTrainerKeys(frame, keys);
    }
    const after = await readAuthorityPosition(frame);
    if (!after) throw new EntryProofIncomplete("trainerReject", `authority position unavailable after ${label} pulse`);
    const moved = previous
      ? Math.hypot(after.x - previous.x, after.y - previous.y)
      : Math.hypot(after.x - before.x, after.y - before.y);
    stalled = moved < 0.02 ? stalled + 1 : 0;
    previous = after;
    if (stalled >= 3) {
      throw new EntryProofFailure(
        "trainerReject",
        `route leg ${label} stalled at ${after.x.toFixed(3)},${after.y.toFixed(3)} (target ${targetX},${targetY})`,
      );
    }
  }
  const end = await readAuthorityPosition(frame);
  throw new EntryProofFailure(
    "trainerReject",
    `route leg ${label} timed out at ${end ? `${end.x.toFixed(3)},${end.y.toFixed(3)}` : "unknown"} (target ${targetX},${targetY})`,
  );
}

async function followTrainerRouteLeg(frame, emit, leg) {
  if (leg.drive === "point") {
    await driveTrainerPoint(frame, leg.x, leg.y, leg.tolerance, leg.step);
  } else {
    for (const axis of leg.axisOrder) {
      const target = axis === "x" ? leg.x : leg.y;
      await driveTrainerAxis(frame, axis, target, leg.tolerance);
    }
  }
  await waitForMovementIdle(frame);
  const stepName = leg.step === "trainer-north-corridor" ? "inside-entry" : leg.step === "trainer-stand-approach" ? "trainer-arrival" : leg.step;
  const position = await emitTrainerPosition(frame, emit, stepName);
  if (!position) throw new EntryProofIncomplete("trainerReject", `authority position unavailable after ${leg.step}`);
  const dx = Math.abs(position.x - leg.x);
  const dy = Math.abs(position.y - leg.y);
  // Fail closed: a blocked leg must not continue route execution.
  if (dx > leg.tolerance + 0.35 || dy > leg.tolerance + 0.35) {
    throw new EntryProofFailure(
      "trainerReject",
      `route leg ${leg.step} blocked at ${position.x.toFixed(3)},${position.y.toFixed(3)} (target ${leg.x},${leg.y})`,
    );
  }
  return position;
}

async function moveToCampTrainer(frame, emit, page) {
  const position = await readAuthorityPosition(frame);
  if (!position) throw new EntryProofIncomplete("trainerReject", "authority position unavailable");
  if (Math.hypot(position.x - TRAINER_STAND.x, position.y - TRAINER_STAND.y) <= 1.5) return;
  await emitTrainerPosition(frame, emit, "walk-start");
  const legs = planTrainerCloneExitRoute(position);
  for (const leg of legs) {
    await followTrainerRouteLeg(frame, emit, leg);
    if (leg.step === "clone-entry") {
      await ensureCloneFacilityDoorOpen(frame, emit, page);
    }
  }
  await waitForMovementIdle(frame);
  const approach = await emitTrainerPosition(frame, emit, "door-approach");
  const doorDistance = approach ? Math.hypot(approach.x - 506, approach.y - 506.774) : Number.POSITIVE_INFINITY;
  if (!approach || doorDistance > 3) throw new EntryProofFailure("trainerReject", `unsafe commerce door approach at ${approach ? `${approach.x.toFixed(3)},${approach.y.toFixed(3)}` : "unknown"}`);
  await waitUntil(() => frame.evaluate(() => window.__successor3dInteractChip?.optionId === "door:dustgate-commerce-facility"), "commerce door interaction", 10_000);
  await openCommerceDoor(frame, emit, page);
  const interiorLegs = planTrainerInteriorRoute(await readAuthorityPosition(frame));
  for (const leg of interiorLegs) {
    await followTrainerRouteLeg(frame, emit, leg);
  }
  const settled = await readAuthorityPosition(frame);
  if (!settled || Math.hypot(settled.x - TRAINER_STAND.x, settled.y - TRAINER_STAND.y) > 1.75) {
    throw new EntryProofFailure("trainerReject", `player did not reach camp trainer stand at ${settled ? `${settled.x.toFixed(3)},${settled.y.toFixed(3)}` : "unknown"}`);
  }
}

async function ensureCloneFacilityDoorOpen(frame, emit, page) {
  const CLONE_DOOR = "door:dustgate-cloning-facility";
  await waitUntil(
    () => frame.evaluate((id) => window.__successor3dInteractChip?.optionId === id, CLONE_DOOR),
    "clone facility door interaction",
    10_000,
  );
  const chip = await frame.evaluate(() => ({
    optionId: window.__successor3dInteractChip?.optionId ?? null,
    verb: window.__successor3dInteractChip?.verb ?? null,
  }));
  if (chip.optionId !== CLONE_DOOR) {
    throw new EntryProofFailure("trainerReject", `clone facility door not selected (got ${chip.optionId ?? "none"})`);
  }
  // Already open: chip verb is CLOSE. Never blind-toggle an open shell shut.
  if (chip.verb === "CLOSE") {
    emit?.({ type: "trainer.cloneDoor", actor: "p1", alreadyOpen: true, open: true, optionId: CLONE_DOOR });
    return;
  }
  // Fail closed: only a known closed door (OPEN) is safe to toggle.
  if (chip.verb !== "OPEN") {
    throw new EntryProofFailure(
      "trainerReject",
      `clone facility door verb not toggle-safe (got ${chip.verb ?? "none"})`,
    );
  }
  const before = await frame.evaluate(() => ({
    accepted: (window.__successor3d?.authorityReceiptTail ?? []).filter((entry) => entry.kind === "ToggleDoor" && entry.accepted === true).length,
    rejected: (window.__successor3d?.authorityReceiptTail ?? []).filter((entry) => entry.kind === "ToggleDoor" && entry.accepted === false).length,
  }));
  const key = await pressTrustedFrameKey(page, frame, "f", "KeyF");
  emit?.({ type: "trainer.key", actor: "p1", handled: key.handled, optionId: key.optionId, door: "clone" });
  if (!key.handled || key.optionId !== CLONE_DOOR) {
    throw new EntryProofFailure(
      "trainerReject",
      `trusted KeyF did not handle closed clone facility door (handled=${key.handled}, optionId=${key.optionId ?? "none"})`,
    );
  }
  try {
    await waitUntil(async () => {
      const state = await frame.evaluate(() => {
        const receipts = (window.__successor3d?.authorityReceiptTail ?? []).filter((entry) => entry.kind === "ToggleDoor");
        return {
          accepted: receipts.filter((entry) => entry.accepted === true).length,
          rejected: receipts.filter((entry) => entry.accepted === false).length,
          lastReason: receipts.at(-1)?.reasonCode ?? null,
          selected: window.__successor3dInteractChip?.optionId ?? null,
          verb: window.__successor3dInteractChip?.verb ?? null,
        };
      });
      if (state.rejected > before.rejected) {
        throw new EntryProofFailure(
          "trainerReject",
          `authority rejected clone facility door toggle (${state.lastReason ?? "unknown"})`,
        );
      }
      const openVerb = state.verb === "CLOSE";
      return state.accepted > before.accepted
        && state.selected === "door:dustgate-cloning-facility"
        && openVerb;
    }, "accepted clone facility door command", 10_000);
  } catch (error) {
    if (error instanceof EntryProofFailure && error.gate === "trainerReject") throw error;
    const diagnostic = await frame.evaluate(() => {
      const last = window.__successor3d?.authorityReceiptTail?.at(-1);
      return {
        lastKind: last?.kind ?? null,
        lastReason: last?.reasonCode ?? null,
        selected: window.__successor3dInteractChip?.optionId ?? null,
        verb: window.__successor3dInteractChip?.verb ?? null,
      };
    }).catch(() => ({ lastKind: null, lastReason: null, selected: null, verb: null }));
    emit?.({ type: "trainer.cloneDoor", actor: "p1", authorityReceipt: false, open: false, ...diagnostic });
    throw new EntryProofFailure(
      "trainerReject",
      `clone facility door interaction produced no accepted authority receipt; last=${diagnostic.lastKind ?? "none"}:${diagnostic.lastReason ?? "none"}`,
    );
  }
  emit?.({ type: "trainer.cloneDoor", actor: "p1", authorityReceipt: true, open: true, optionId: CLONE_DOOR });
}

async function openCommerceDoor(frame, emit, page) {
  const before = await frame.evaluate(() => ({
    accepted: (window.__successor3d?.authorityReceiptTail ?? []).filter((entry) => entry.kind === "ToggleDoor" && entry.accepted === true).length,
    rejected: (window.__successor3d?.authorityReceiptTail ?? []).filter((entry) => entry.kind === "ToggleDoor" && entry.accepted === false).length,
  }));
  const key = await pressTrustedFrameKey(page, frame, "f", "KeyF");
  emit?.({ type: "trainer.key", actor: "p1", handled: key.handled, optionId: key.optionId });
  if (!key.handled || key.optionId !== "door:dustgate-commerce-facility") throw new EntryProofFailure("trainerReject", `trusted KeyF was not claimed for the commerce door (${key.optionId ?? "none"})`);
  try {
    await waitUntil(async () => {
      const state = await frame.evaluate(() => {
        const receipts = (window.__successor3d?.authorityReceiptTail ?? []).filter((entry) => entry.kind === "ToggleDoor");
        return {
          accepted: receipts.filter((entry) => entry.accepted === true).length,
          rejected: receipts.filter((entry) => entry.accepted === false).length,
          lastReason: receipts.at(-1)?.reasonCode ?? null,
          selected: window.__successor3dInteractChip?.optionId ?? null,
          verb: window.__successor3dInteractChip?.verb ?? null,
        };
      });
      if (state.rejected > before.rejected) throw new EntryProofFailure("trainerReject", `authority rejected commerce door: ${state.lastReason ?? "unknown"}`);
      return state.accepted > before.accepted && state.selected === "door:dustgate-commerce-facility" && state.verb === "CLOSE";
    }, "accepted commerce door command", 10_000);
  } catch (error) {
    if (error instanceof EntryProofFailure && error.gate === "trainerReject") throw error;
    const diagnostic = await frame.evaluate(() => {
      const last = window.__successor3d?.authorityReceiptTail?.at(-1);
      return { lastKind: last?.kind ?? null, lastReason: last?.reasonCode ?? null };
    }).catch(() => ({ lastKind: null, lastReason: null }));
    emit?.({ type: "trainer.door", actor: "p1", authorityReceipt: false, open: false, ...diagnostic });
    throw new EntryProofFailure("trainerReject", `commerce door interaction produced no accepted authority receipt; last ${diagnostic.lastKind ?? "none"}:${diagnostic.lastReason ?? "none"}`);
  }
  emit?.({ type: "trainer.door", actor: "p1", authorityReceipt: true, open: true });
}

async function emitTrainerPosition(frame, emit, step) {
  const position = await frame.evaluate(() => window.__successor3d?.authorityPlayer ? { x: window.__successor3d.authorityPlayer.x, y: window.__successor3d.authorityPlayer.y } : null);
  emit?.({ type: "trainer.movement", actor: "p1", step, x: position?.x ?? null, y: position?.y ?? null });
  return position;
}

async function openCampTrainer(frame, page) {
  const windowRoot = frame.locator('.sc3d-window[data-window="converse"]');
  if (await windowRoot.count() && await windowRoot.isVisible()) return;
  await selectInteractionOption(frame, "trainer:camp-trainer");
  const key = await pressTrustedFrameKey(page, frame, "f", "KeyF");
  if (!key.handled || key.optionId !== "trainer:camp-trainer") throw new EntryProofFailure("trainerReject", `trusted KeyF was not claimed for the camp trainer (${key.optionId ?? "none"})`);
  try { await windowRoot.waitFor({ state: "visible", timeout: 5_000 }); }
  catch { throw new EntryProofFailure("trainerReject", "camp trainer conversation did not open through selected interaction UI"); }
}

async function pressTrustedFrameKey(page, frame, key, code) {
  const observed = frame.evaluate((expectedCode) => new Promise((resolve) => {
    const onKey = (event) => {
      if (event.code !== expectedCode) return;
      window.removeEventListener("keydown", onKey);
      queueMicrotask(() => resolve({ observed: true, handled: event.defaultPrevented, optionId: window.__successor3dInteractChip?.optionId ?? null }));
    };
    window.addEventListener("keydown", onKey);
    setTimeout(() => { window.removeEventListener("keydown", onKey); resolve({ observed: false, handled: false, optionId: null }); }, 1_000);
  }), code);
  await page.locator("#game-frame").focus();
  const focused = await frame.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus({ preventScroll: true });
    return document.activeElement === document.body;
  });
  if (!focused) throw new EntryProofFailure("trainerReject", `trusted ${code} could not focus the game surface`);
  await page.keyboard.press(key);
  const result = await observed;
  if (result.observed !== true) throw new EntryProofFailure("trainerReject", `trusted ${code} did not reach the game frame`);
  return result;
}

async function selectInteractionOption(frame, optionId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const selected = await frame.evaluate(() => window.__successor3dInteractChip ? { optionId: window.__successor3dInteractChip.optionId, more: window.__successor3dInteractChip.more } : null);
    if (selected?.optionId === optionId) return;
    if (!selected || selected.more < 1) break;
    await pressFrameKey(frame, "KeyV", "v");
    await delay(100);
  }
  throw new EntryProofFailure("trainerReject", "camp trainer was not selectable through interaction UI");
}

async function waitForMovementIdle(frame) {
  await frame.evaluate(() => {
    for (const [code, key] of [["KeyW", "w"], ["KeyA", "a"], ["KeyS", "s"], ["KeyD", "d"], ["ShiftLeft", "Shift"]]) {
      window.dispatchEvent(new KeyboardEvent("keyup", { code, key, bubbles: true }));
    }
  });
  let previous = null;
  let stable = 0;
  const deadline = Date.now() + 6_000;
  while (Date.now() <= deadline) {
    const current = await frame.evaluate(() => ({
      x: window.__successor3d?.authorityPlayer?.x ?? null,
      y: window.__successor3d?.authorityPlayer?.y ?? null,
      accepted: Number(window.__successor3d?.acceptedCommands ?? 0),
      rejected: Number(window.__successor3d?.rejectedCommands ?? 0),
    }));
    if (previous && typeof current.x === "number" && typeof current.y === "number" && Math.hypot(current.x - previous.x, current.y - previous.y) < 0.02 && current.accepted === previous.accepted && current.rejected === previous.rejected) stable += 1;
    else stable = 0;
    if (stable >= 3) return;
    previous = current;
    await delay(250);
  }
  throw new EntryProofFailure("trainerReject", "authority movement queue did not become idle before door interaction");
}

async function settleAxisNear(frame, axis, target, negativeKey, positiveKey, tolerance = 0.6) {
  let stalled = 0;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const before = await frame.evaluate((name) => window.__successor3d?.authorityPlayer?.[name] ?? null, axis);
    if (typeof before !== "number") throw new EntryProofIncomplete("trainerReject", `authority ${axis} position unavailable`);
    if (Math.abs(before - target) <= tolerance) return;
    const [code, key] = before > target ? negativeKey : positiveKey;
    await frame.evaluate(({ eventCode, eventKey }) => window.dispatchEvent(new KeyboardEvent("keydown", { code: eventCode, key: eventKey, bubbles: true })), { eventCode: code, eventKey: key });
    try {
      await waitUntil(() => frame.evaluate(({ name, start }) => {
        const value = window.__successor3d?.authorityPlayer?.[name];
        return typeof value === "number" && Math.abs(value - start) >= 0.03;
      }, { name: axis, start: before }), `precise authority movement ${axis} step`, 3_000);
    } catch {
      throw new EntryProofFailure("trainerReject", `precise authority movement ${axis} stalled at ${before.toFixed(3)}`);
    } finally {
      await frame.evaluate(({ eventCode, eventKey }) => window.dispatchEvent(new KeyboardEvent("keyup", { code: eventCode, key: eventKey, bubbles: true })), { eventCode: code, eventKey: key }).catch(() => {});
    }
    await delay(180);
    const after = await frame.evaluate((name) => window.__successor3d?.authorityPlayer?.[name] ?? null, axis);
    stalled = typeof after === "number" && Math.abs(after - before) < 0.02 ? stalled + 1 : 0;
    if (stalled >= 2) throw new EntryProofFailure("trainerReject", `precise authority movement ${axis} stalled at ${typeof after === "number" ? after.toFixed(3) : "unavailable"}`);
  }
  throw new EntryProofFailure("trainerReject", `precise authority movement ${axis} did not settle`);
}

async function settleAxisAfterIdle(frame, axis, target, negativeKey, positiveKey, tolerance) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await settleAxisNear(frame, axis, target, negativeKey, positiveKey, tolerance);
    await waitForMovementIdle(frame);
    const value = await frame.evaluate((name) => window.__successor3d?.authorityPlayer?.[name] ?? null, axis);
    if (typeof value === "number" && Math.abs(value - target) <= tolerance) return;
  }
  const value = await frame.evaluate((name) => window.__successor3d?.authorityPlayer?.[name] ?? null, axis).catch(() => null);
  throw new EntryProofFailure("trainerReject", `authority movement ${axis} remained outside the safe band at ${typeof value === "number" ? value.toFixed(3) : "unavailable"}`);
}

async function stopHandSamplingLoop(frame, emit) {
  const before = await frame.evaluate(() => window.__successor3d?.authorityPlayer ? {
    x: window.__successor3d.authorityPlayer.x,
    y: window.__successor3d.authorityPlayer.y,
    nextSampleTick: Number(window.__successor3d.authorityPlayer.nextSampleTick ?? 0),
  } : null);
  if (!before) throw new EntryProofIncomplete("trainerSuccess", "authority sampling state unavailable");
  if (before.nextSampleTick <= 0) return;
  for (const [code, key] of [["KeyD", "d"], ["KeyA", "a"], ["KeyS", "s"], ["KeyW", "w"]]) {
    await frame.evaluate(({ eventCode, eventKey }) => window.dispatchEvent(new KeyboardEvent("keydown", { code: eventCode, key: eventKey, bubbles: true })), { eventCode: code, eventKey: key });
    let stopped = null;
    try {
      stopped = await waitUntilValue(() => frame.evaluate((origin) => {
        const actor = window.__successor3d?.authorityPlayer;
        if (!actor || Math.hypot(actor.x - origin.x, actor.y - origin.y) < 0.03) return null;
        return { x: actor.x, y: actor.y };
      }, before), "authority movement cancelling hand sampling", 3_000);
    } catch { /* try another collision-free direction */ }
    finally { await frame.evaluate(({ eventCode, eventKey }) => window.dispatchEvent(new KeyboardEvent("keyup", { code: eventCode, key: eventKey, bubbles: true })), { eventCode: code, eventKey: key }).catch(() => {}); }
    if (stopped) {
      await waitForMovementIdle(frame);
      await waitUntil(() => frame.evaluate(() => {
        const actor = window.__successor3d?.authorityPlayer;
        const tick = Number(window.__successor3d?.tick ?? 0);
        const nextSampleTick = Number(actor?.nextSampleTick ?? 0);
        return nextSampleTick <= tick;
      }), "cancelled hand-sampling schedule", 20_000);
      emit?.({ type: "trainer.sampling", actor: "p1", sampleLoopStopped: true, x: stopped.x, y: stopped.y });
      return;
    }
  }
  throw new EntryProofFailure("trainerSuccess", "real authority movement did not stop the hand-sampling loop");
}

async function waitUntilValue(predicate, label, timeoutMs = OBSERVE_MS, gate = "observation") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new EntryProofFailure(gate, `timed out waiting for ${label}`);
}

async function receiptKindCount(frame, kind, accepted) {
  return frame.evaluate(({ expectedKind, expectedAccepted }) => (window.__successor3d?.authorityReceiptTail ?? []).filter((entry) => entry.kind === expectedKind && (expectedAccepted === null || entry.accepted === expectedAccepted)).length, { expectedKind: kind, expectedAccepted: typeof accepted === "boolean" ? accepted : null });
}

async function equipmentProjection(frame, wornKey) {
  return frame.evaluate((key) => ({
    accepted: Number(window.__successor3d?.acceptedCommands ?? 0),
    rejected: Number(window.__successor3d?.rejectedCommands ?? 0),
    lastReason: window.__successor3d?.authorityReceiptTail?.at(-1)?.reasonCode ?? null,
    authority: (window.__successor3d?.authorityPlayer?.worn ?? []).some((piece) => piece.item === key),
    doll: (window.__successor3dInventoryPaperDollEquipmentIds ?? []).includes(key),
    pawn: (window.__successor3d?.localEquipmentIds ?? []).includes(key),
  }), wornKey);
}
async function measureFrame(page, frame, viewport, selector = "iframe.stage-frame") { const box = await page.locator(selector).boundingBox(); const result = await frame.evaluate(() => { const canvas = document.querySelector("canvas"); const rect = canvas?.getBoundingClientRect(); return { canvas: rect && { width: rect.width, height: rect.height }, noScroll: document.documentElement.scrollHeight <= innerHeight + 1 && document.body.scrollHeight <= innerHeight + 1, probeAvailable: Boolean(canvas) }; }); return { probeAvailable: Boolean(box && result?.canvas), viewport, frame: { width: box?.width ?? 0, height: box?.height ?? 0 }, canvas: result?.canvas ?? { width: 0, height: 0 }, noScroll: result?.noScroll === true }; }
async function waitUntil(predicate, label, timeoutMs = OBSERVE_MS, gate = "observation") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new EntryProofFailure(gate, `timed out waiting for ${label}`);
}
async function waitFrame(frame, predicate, label) { return waitUntil(predicate, label); }
async function stageDiagnostic(page, selector) {
  try {
    const handle = await page.locator(selector).elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame || frame.isDetached()) return { frame: "absent" };
    return frame.evaluate(() => {
      const probe = window.__successor3d;
      const shell = document.querySelector("main.successor3d-shell");
      const fatal = document.querySelector(".sc3d-fatal, .sc3d-error, [data-state=error]");
      return {
        frame: "present",
        frameLocation: `${location.origin}${location.pathname}`.slice(0, 160),
        readyState: document.readyState,
        canvas: Boolean(document.querySelector("canvas")),
        probe: Boolean(probe),
        serverConnected: probe?.serverStatus === "connected",
        serverStatus: String(probe?.serverStatus ?? "absent").slice(0, 40),
        tickPositive: Number(probe?.tick ?? 0) > 0,
        authorityPlayer: probe?.authorityPlayer != null,
        authorityActorCount: Array.isArray(probe?.authorityActorKeys) ? probe.authorityActorKeys.length : 0,
        shellState: String(shell?.getAttribute("data-state") ?? "absent").slice(0, 40),
        fatalVisible: Boolean(fatal),
      };
    });
  } catch { return { frame: "diagnostic-unavailable" }; }
}
async function stableStageFrame(page, selector, predicate, label, timeoutMs = OBSERVE_MS) {
  const locator = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      await locator.waitFor({ timeout: 2_000 });
      const handle = await locator.elementHandle();
      const frame = await handle?.contentFrame() ?? null;
      if (frame && !frame.isDetached() && frame.url() !== "about:blank" && await predicate(frame)) return frame;
    } catch (error) {
      if (!/execution context was destroyed|frame was detached|cannot find context|timeout/iu.test(String(error?.message ?? error))) throw error;
    }
    await delay(100);
  }
  throw new EntryProofFailure("observation", `timed out waiting for ${label}`);
}
async function stageFrame(page, selector) {
  const locator = page.locator(selector);
  await locator.waitFor();
  let frame = null;
  await waitUntil(async () => {
    const handle = await locator.elementHandle();
    frame = await handle?.contentFrame() ?? null;
    return frame !== null && !frame.isDetached() && frame.url() !== "about:blank";
  }, `${selector} content frame`);
  return frame;
}
async function childFrame(page, hint, any = false) { let found; await waitUntil(() => { found = page.frames().find((candidate) => candidate !== page.mainFrame() && (any || !hint || candidate.url().includes(hint))); return Boolean(found); }, `child frame${hint ? ` ${hint}` : ""}`); return found; }
function messageProbeScript() { const accepted = new Set(["successor.creator.ready.v1", "successor.creator.create-result.v1", "successor.creator.select.v1", "successor.client.ready.v1", "successor.launch.v1", "successor.launch.failed.v1"]); const log = []; Object.defineProperty(window, "__rcMessageLog", { value: log, configurable: true }); window.addEventListener("message", (event) => { if (event.data && typeof event.data === "object" && accepted.has(event.data.type)) log.push({ type: event.data.type, at: Date.now() }); }); }

/** Deterministic fake transport used by focused contract tests. */
export function createInstrumentedTransport(trace = []) {
  const players = ACTORS.map((alias) => ({
    alias,
    async register() { trace.push(`${alias}:register`); },
    async creator() { trace.push(`${alias}:creator`); return { probeAvailable: true, created: true, handshake: true, characterId: `${alias}-character` }; },
    async logoutLogin() { trace.push(`${alias}:logout-login`); return { probeAvailable: true, loggedOut: true, loggedIn: true, rosterPresent: true, selected: true, enterEnabled: true }; },
    async rosterEnter() { trace.push(`${alias}:roster`); return { probeAvailable: true, pointerBeforeTicket: true, clientReadyBeforeLaunch: true, launchSent: true, worldReady: true, runtimeActorKey: alias, visibleActorKeys: [...ACTORS] }; },
    async measureStage(stage, viewport) { trace.push(`${alias}:measure:${stage}:${viewport.width}`); return { probeAvailable: true, viewport, frame: { width: viewport.width, height: viewport.height }, canvas: { width: viewport.width, height: viewport.height }, noScroll: true }; },
    async measureMobileStage(stage, viewport) { trace.push(`${alias}:mobile:${stage}`); return this.measureStage(stage, viewport); },
    async liveness() { trace.push(`${alias}:liveness`); return { probeAvailable: true, visible: true, raf: 2 }; },
    async observeSharedWorld() { trace.push(`${alias}:shared`); return { probeAvailable: true, mutualProjection: true }; },
    async hostedMacroCrud() {
      if (alias !== "p1") throw new EntryProofIncomplete("hostedMacros", "hosted macro CRUD requires the P1 proof actor");
      trace.push(`${alias}:hosted-macros`);
      return { probeAvailable: true, saved: true, deleted: true, parentPost: true, parentDelete: true, versionAdvanced: true, listCountAfterSave: 1, listCountAfterDelete: 0, versionAfterSave: 2, versionAfterDelete: 3 };
    },
    async equipmentRoundTrip() { trace.push(`${alias}:equipment`); return { probeAvailable: true, authorityChanged: true, authorityRestored: true, dollChanged: true, dollRestored: true, pawnChanged: true, pawnRestored: true }; },
    async sendSpatialChat() { trace.push(`${alias}:chat-send`); return { probeAvailable: true }; },
    async observeSpatialChat() { trace.push(`${alias}:chat-observe`); return { probeAvailable: true, correctAnchor: true }; },
    async disconnectGame() { trace.push(`${alias}:disconnect`); },
    async observeLinkDead(_key, expected) { trace.push(`${alias}:link:${expected}`); return { probeAvailable: true, observed: true }; },
    async reconnectGame() { trace.push(`${alias}:reconnect`); return { probeAvailable: true, sameActor: true }; },
    async trainerXpRoundTrip() { trace.push(`${alias}:trainer`); return { probeAvailable: true, insufficientXpBlocked: true, earnedAuthorityXp: true, acceptedAfterXp: true }; },
    async tuiWorldReady() { trace.push(`${alias}:tui-world-ready`); return { status: "pass", authorityConnected: true, tickPositive: true, identityMatch: true, sourceMatchesClient: true, processExited: true, cleanupComplete: true }; },
    async screenshot() { return null; },
  }));
  return { players: () => players, open: async () => trace.push("open"), close: async () => {
    for (const alias of ACTORS) trace.push(`${alias}:cleanup`);
    trace.push("close");
  } };
}
