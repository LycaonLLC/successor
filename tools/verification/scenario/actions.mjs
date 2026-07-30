import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertOracle,
  assertQuery,
  attackUntilDowned,
  claimParcel,
  craftClearSlot,
  craftAssignSlot,
  craftDraftSchematic,
  craftRecipe,
  createFlowContext,
  expectCraftRejected,
  FlowStepError,
  harvestCorpse,
  moveTo,
  query,
  queryOracle,
  placeFarmStructure,
  plantSeed,
  removeFarmStructure,
  setCareerGoal,
  spliceBegin,
  spliceAssignSlot,
  spliceCancel,
  spliceClearSlot,
  surveyAndSample,
  surveyBest,
  tillTile,
  trainSkill,
  waitForExtractorCollectable,
  waterTile,
} from "../../successor/play-flows/index.mjs";

import {
  attackUntilCloneEligible,
  bankDepositCredits,
  bankRetrieveItem,
  bankStoreItem,
  bankWithdrawCredits,
  cloneSaveSkillBackup,
  recoverPlayerCorpse,
} from "../../successor/play-flows/primitives.mjs";

export class ScenarioActionDispatchError extends Error {
  constructor(message, details, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ScenarioActionDispatchError";
    this.details = details;
  }
}

const implementations = {
  assertCanonicalSlugthrowerCatalog: (_ctx, args) => assertCanonicalSlugthrowerCatalog(args),
  assertOracle: (ctx, args) => assertOracle(ctx, requireExpectation(args), args),
  assertQuery: (ctx, args) => assertQuery(ctx, requireArg(args, "line"), requireExpectation(args), args),
  attackUntilDowned: (ctx, args) => attackUntilDowned(ctx, requireArg(args, "targetId"), args),
  claimParcel: (ctx, args) => claimParcel(ctx, args, args),
  craftAssignSlot: (ctx, args) => craftAssignSlot(ctx, requireArg(args, "slotIndex"), args, args),
  craftClearSlot: (ctx, args) => craftClearSlot(ctx, requireArg(args, "slotIndex"), args),
  attackUntilCloneEligible: (ctx, args) => attackUntilCloneEligible(ctx, requireArg(args, "targetId"), args),
  bankDepositCredits: (ctx, args) => bankDepositCredits(ctx, requirePositiveInteger(args.amount, "amount"), args),
  bankRetrieveItem: (ctx, args) => bankRetrieveItem(ctx, args),
  bankStoreItem: (ctx, args) => bankStoreItem(ctx, args),
  bankWithdrawCredits: (ctx, args) => bankWithdrawCredits(ctx, requirePositiveInteger(args.amount, "amount"), args),
  cloneSaveSkillBackup: (ctx, args) => cloneSaveSkillBackup(ctx, args),
  recoverPlayerCorpse: (ctx, args) => recoverPlayerCorpse(ctx, args),
  craftDraftSchematic: (ctx, args) => craftDraftSchematic(ctx, requireArg(args, "maxUses"), args),
  craftRecipeBatch: async (ctx, args) => {
    const recipeId = requireArg(args, "recipeId");
    const count = requirePositiveInteger(args.count, "count");
    const runs = [];
    for (let index = 0; index < count; index += 1) {
      runs.push(await craftRecipe(ctx, recipeId, args.slots ?? [], args));
    }
    return { status: "pass", recipeId, count, runs };
  },
  craftRecipe: (ctx, args) => craftRecipe(ctx, requireArg(args, "recipeId"), args.slots ?? [], args),
  expectCraftRejected: (ctx, args) => expectCraftRejected(ctx, requireArg(args, "recipeId"), args.reasonCode ?? args.expectedReason, args),
  harvestCorpse: (ctx, args) => harvestCorpse(ctx, requireArg(args, "targetId"), args),
  plantSeed: (ctx, args) => plantSeed(ctx, requireArg(args, "parcelId"), farmCellArgs(args), args.seed ?? args, args),
  query: (ctx, args) => query(ctx, requireArg(args, "line"), args),
  queryOracle: (ctx, args) => queryOracle(ctx, args),
  moveTo: (ctx, args) => moveTo(ctx, farmCellArgs(args), args),
  placeFarmStructure: (ctx, args) => placeFarmStructure(ctx, requireArg(args, "parcelId"), requireArg(args, "structureItemId"), farmCellArgs(args), args),
  removeFarmStructure: (ctx, args) => removeFarmStructure(
    ctx,
    requireArg(args, "parcelId"),
    requireArg(args, "structureId"),
    { ...args, itemId: args.itemId ?? args.structureItemId },
  ),
  setCareerGoal: (ctx, args) => setCareerGoal(ctx, requireArg(args, "goalId"), args),
  spliceBegin: (ctx, args) => spliceBegin(ctx, requireArg(args, "species"), args),
  spliceAssignSlot: (ctx, args) => spliceAssignSlot(ctx, requireArg(args, "slotIndex"), args, args),
  spliceCancel: (ctx, args) => spliceCancel(ctx, args),
  spliceClearSlot: (ctx, args) => spliceClearSlot(ctx, requireArg(args, "slotIndex"), args),
  surveyAndSample: (ctx, args) => surveyAndSample(ctx, args.family ?? "iron", args),
  surveyBest: async (ctx, args) => {
    const result = await surveyBest(ctx, args.family ?? "iron", args);
    const movement = result.best && args.move !== false
      ? await moveTo(ctx, result.best, { toleranceCells: args.toleranceCells ?? 0.9, ...(args.moveOptions ?? {}) })
      : null;
    return { ...result, status: result.survey.status, movement };
  },
  tillTile: (ctx, args) => tillTile(ctx, requireArg(args, "parcelId"), farmCellArgs(args), args),
  trainSkill: (ctx, args) => trainSkill(ctx, requireArg(args, "boxId"), args),
  waitForExtractorCollectable: (ctx, args) => waitForExtractorCollectable(ctx, requireArg(args, "extractorId"), args),
  waterTile: (ctx, args) => waterTile(ctx, requireArg(args, "parcelId"), farmCellArgs(args), args),
};

export const scenarioActionRegistry = Object.freeze(Object.fromEntries(
  Object.entries(implementations).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
));

export const scenarioActionNames = Object.freeze(Object.keys(scenarioActionRegistry));

export function getScenarioAction(name) {
  const key = String(name ?? "").trim();
  const implementation = scenarioActionRegistry[key];
  if (!implementation) throw new Error(`unknown scenario action ${key}; available=${scenarioActionNames.join(",")}`);
  return implementation;
}

/**
 * Expand one scenario action through the shared play-flow primitives.
 *
 * `context` is identical in accelerated and realtime lanes:
 * `{driver, gameUrl, actor, oracle, sleep, advanceTicks, recordFrame, forActor}`.
 * `recordFrame` receives every expanded driver send and matched response in order.
 */
export async function dispatchScenarioAction(rawSpec, context) {
  const spec = normalizeActionSpec(rawSpec);
  const implementation = getScenarioAction(spec.name);
  const bound = bindActorContext(context, spec.actor);
  const expandedFrames = [];
  const forwardFrame = typeof bound.recordFrame === "function"
    ? bound.recordFrame.bind(bound)
    : typeof context.recordFrame === "function"
      ? context.recordFrame.bind(context)
      : () => undefined;
  const actionContext = createFlowContext({
    ...bound,
    actor: bound.actor ?? spec.actor ?? context.actor ?? null,
    flowName: `scenario:${spec.name}`,
    recordFrame(frame) {
      expandedFrames.push(frame);
      forwardFrame(frame);
    },
    forActor: bound.forActor ?? context.forActor,
  });

  try {
    const result = await implementation(actionContext, spec.args);
    const status = actionResultStatus(result);
    if (status === "fail" || status === "failure") {
      const error = new FlowStepError(`scenario action ${spec.name} returned ${status}`, { result });
      const details = actionEnvelope({
        name: spec.name,
        actor: actionActor(actionContext),
        status: "fail",
        expandedFrames,
        result,
        actionContext,
        error,
      });
      throw new ScenarioActionDispatchError(
        `scenario action ${spec.name} failed for ${details.actor ?? "unbound"}: ${error.message}`,
        details,
        error,
      );
    }
    return actionEnvelope({
      name: spec.name,
      actor: actionActor(actionContext),
      status,
      expandedFrames,
      result,
      actionContext,
    });
  } catch (error) {
    if (error instanceof ScenarioActionDispatchError) throw error;
    const details = actionEnvelope({
      name: spec.name,
      actor: actionActor(actionContext),
      status: "fail",
      expandedFrames,
      result: null,
      actionContext,
      error,
    });
    throw new ScenarioActionDispatchError(
      `scenario action ${spec.name} failed for ${details.actor ?? "unbound"}: ${errorMessage(error)}`,
      details,
      error,
    );
  }
}

function actionEnvelope({ name, actor, status, expandedFrames, result, actionContext, error }) {
  const receipts = expandedFrames
    .map((frame) => frame.recv)
    .filter((envelope) => envelope?.type === "receipt");
  return {
    schema: "successor.scenario-action.v1",
    name,
    actor,
    status,
    expandedFrames,
    receipts,
    result,
    ...(status === "fail" ? {
      error: errorMessage(error),
      lastOracle: actionContext.lastOracle,
      lastReceipt: actionContext.lastReceipt,
    } : {}),
  };
}

function normalizeActionSpec(rawSpec) {
  if (typeof rawSpec === "string") return { name: rawSpec, actor: null, args: {} };
  if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) throw new Error("scenario action must be a name or object");
  const name = String(rawSpec.name ?? "").trim();
  if (!name) throw new Error("scenario action name is required");
  const args = rawSpec.args ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`scenario action ${name} args must be an object`);
  return { name, actor: rawSpec.actor ?? null, args };
}

function bindActorContext(context, actor) {
  if (!context || typeof context !== "object") throw new Error("scenario action context is required");
  if (actor === null || actor === undefined || actor === "") return context;
  if (typeof context.forActor !== "function") {
    if (sameActor(context.actor, actor)) return context;
    throw new Error(`scenario action context cannot bind actor ${String(actor)}`);
  }
  const bound = context.forActor(actor);
  if (!bound || typeof bound !== "object") throw new Error(`unknown scenario actor ${String(actor)}`);
  return bound;
}

function farmCellArgs(args) {
  return args.cell ?? { x: args.x ?? args.cellX ?? args.cell_x, y: args.y ?? args.cellY ?? args.cell_y };
}

function requireExpectation(args) {
  const expectation = args.expectation ?? args.expect;
  if (expectation === undefined) throw new Error("action assertion requires args.expectation");
  return expectation;
}

function requireArg(args, name) {
  const snake = name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  const value = args[name] ?? args[snake];
  if (value === undefined || value === null || value === "") throw new Error(`scenario action requires args.${name}`);
  return value;
}
function requirePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`scenario action ${name} must be a positive integer`);
  return parsed;
}


function actionActor(context) {
  if (context.actor && typeof context.actor === "object") return context.actor.alias ?? context.actor.id ?? null;
  return context.actor ?? null;
}

function sameActor(actor, alias) {
  if (actor === alias) return true;
  return actor && typeof actor === "object" && (actor.alias === alias || actor.id === alias || actor.actorId === alias);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function actionResultStatus(result) {
  return typeof result?.status === "string" ? result.status : "pass";
}

export async function assertCanonicalSlugthrowerCatalog(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const [authority, crafting, profiles, mapping] = await Promise.all([
    readCatalogSource(repoRoot, "crates/successor-sim/src/authority.rs"),
    readCatalogSource(repoRoot, "crates/successor-sim/src/authority/crafting.rs"),
    readCatalogSource(repoRoot, "server/src/game/weapons.ts"),
    readCatalogSource(repoRoot, "server/src/game/shard.ts"),
  ]);
  const itemIdMatches = countMatches(authority, /const CRAFTED_SLUGTHROWER_ITEM_ID:\s*u32\s*=\s*3_101\s*;/gu);
  const recipeMatches = countMatches(crafting, /CraftRecipeDefinition\s*\{\s*id:\s*"slugthrower",[\s\S]{0,600}?output_item_id:\s*CRAFTED_SLUGTHROWER_ITEM_ID,/gu);
  const profileMatches = countMatches(profiles, /^\s*slugthrower:\s*\{\s*id:\s*"slugthrower",/gmu);
  const mappingMatches = countMatches(mapping, /case\s+3101:\s*return\s+"slugthrower";/gu);
  const counts = { itemIdMatches, recipeMatches, profileMatches, mappingMatches };
  if (itemIdMatches !== 1 || recipeMatches !== 1 || profileMatches !== 1 || mappingMatches !== 1) {
    throw new Error(`canonical slugthrower catalog invariant failed: ${JSON.stringify(counts)}`);
  }
  return {
    status: "pass",
    recipe: { id: "slugthrower", outputItemId: 3101, count: recipeMatches },
    weaponProfile: { code: "slugthrower", id: "slugthrower", count: profileMatches },
    weaponItemMapping: { itemId: 3101, code: "slugthrower", count: mappingMatches },
  };
}

async function readCatalogSource(repoRoot, relativePath) {
  return readFile(resolve(repoRoot, relativePath), "utf8");
}

function countMatches(source, expression) {
  return [...source.matchAll(expression)].length;
}
