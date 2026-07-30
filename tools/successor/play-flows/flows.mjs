import {
  craftRecipe,
  engageTarget,
  equipWeapon,
  faceHeading,
  inventoryTotal,
  issueAuthorityLine,
  lootNearest,
  moveTo,
  query,
  runMacroText,
  sampleLoop,
  surveyAndSample,
  storeToExchange,
  surveyBest,
  trainSkill,
  whereData,
} from "./primitives.mjs";

export const flowRegistry = {
  patrol: {
    description: "Move through a waypoint list using SetMoveIntent pulses.",
    async run(ctx, options = {}) {
      const waypoints = parseWaypoints(options.waypoints ?? options.waypoint ?? "");
      if (waypoints.length === 0) throw new Error("patrol requires --waypoints x,y;x,y");
      const visited = [];
      for (let loop = 0; loop < (options.loop ?? 1); loop += 1) {
        for (const point of waypoints) {
          visited.push(await moveTo(ctx, point, options.moveOptions ?? {}));
        }
      }
      return { status: "pass", visited: visited.length, waypoints };
    },
  },

  "harvest-loop": {
    description: "Survey, move to the best iron cell, kneel, then sample until N units are acquired.",
    async run(ctx, options = {}) {
      const family = options.family ?? "iron";
      const units = Math.max(1, Math.trunc(options.units ?? options.n ?? 10));
      const before = await inventoryTotal(ctx, family);
      let survey = await surveyBest(ctx, family, { requireAccepted: false });
      if (survey.survey.receipt?.accepted === false && survey.survey.receipt.reasonCode === "missing_survey_tool") {
        await trainSkill(ctx, options.harvestSkillBox ?? "craftsman-novice", { moveOptions: options.moveOptions ?? {} });
        survey = await surveyBest(ctx, family);
      }
      if (survey.survey.receipt?.accepted === false) {
        throw new Error(`survey rejected: ${survey.survey.receipt.reasonCode ?? "unknown"}`);
      }
      if (survey.best) await moveTo(ctx, survey.best, { toleranceCells: options.harvestToleranceCells ?? 1.1, ...(options.moveOptions ?? {}) });
      await issueAuthorityLine(ctx, "/kneel", { primitive: "harvestLoop.kneel", commandKind: "SetPosture", receiptTimeoutMs: 10_000 });
      await waitForPosture(ctx, "kneeling", options.postureTimeoutMs ?? 8_000);
      const sample = await sampleLoop(ctx, family, units, { inventoryFilter: family, timeoutMs: options.sampleTimeoutMs ?? 90_000 });
      const after = await inventoryTotal(ctx, family);
      return {
        status: "pass",
        family,
        unitsRequested: units,
        surveyBest: survey.best,
        before: before.totalAvailable,
        after: after.totalAvailable,
        gained: after.totalAvailable - before.totalAvailable,
        sample,
      };
    },
  },

  "melee-spar": {
    description: "Engage the nearest hostile and report the combat exchange receipts/events.",
    async run(ctx, options = {}) {
      if (options.weapon) await equipWeapon(ctx, options.weapon, { weaponItemId: options.weaponItemId });
      const engaged = await engageTarget(ctx, options.target ?? "nearest hostile", { actionId: options.actionId ?? "basic_shot" });
      const targetId = engaged.target?.id ?? engaged.attack.event?.data?.result?.data?.targetActorId;
      const fired = await waitForOptionalEvent(ctx, (candidate) => candidate.type === "event" && candidate.event === "ability_queue" && candidate.data?.event?.lifecycle === "fired", options.fireTimeoutMs ?? 25_000);
      const combat = await waitForOptionalEvent(ctx, (candidate) => candidate.type === "event" && candidate.event === "combat" && (!targetId || candidate.data?.event?.targetActorId === targetId), options.combatTimeoutMs ?? 25_000);
      const outcome = targetId ? await waitForActorOutcome(ctx, targetId, options.outcomeTimeoutMs ?? 70_000) : { status: "unknown", reason: "no_target_id" };
      const status = outcome.status === "timeout" || outcome.status === "unknown" ? "warn" : "pass";
      return {
        status,
        targetId,
        receipt: engaged.attack.receipt,
        fired,
        combat,
        outcome,
      };
    },
  },

  "loot-sweep": {
    description: "Loot nearest corpse/cache rows using player-visible nearby results and explicit item ids.",
    async run(ctx, options = {}) {
      const count = Math.max(1, Math.trunc(options.count ?? options.loop ?? 1));
      const looted = [];
      for (let index = 0; index < count; index += 1) {
        const result = await lootNearest(ctx, options);
        looted.push(result);
        if (result.status !== "pass") break;
      }
      return { status: aggregateStepStatus(looted), looted: looted.filter((step) => step.status === "pass").length, steps: looted };
    },
  },

  errand: {
    description: "Run a district-exchange deposit errand for the best matching inventory stack.",
    async run(ctx, options = {}) {
      const stored = await storeToExchange(ctx, { filter: options.filter ?? options.family ?? "iron", quantity: options.quantity, moveOptions: options.moveOptions ?? {} });
      return { status: stored.status, stored };
    },
  },

  "survey-and-sample": {
    description: "Survey a resource family, walk to its richest cell, and sample through the shared action context.",
    async run(ctx, options = {}) {
      return surveyAndSample(ctx, options.family ?? "iron", options);
    },
  },

  "craft-recipe": {
    description: "Run a receipt-checked begin/assign/assemble/experiment/finalize craft session.",
    async run(ctx, options = {}) {
      if (!options.recipeId) throw new Error("craft-recipe requires recipeId");
      return craftRecipe(ctx, options.recipeId, options.slots ?? [], options);
    },
  },

  "macro-text": {
    description: "Run a semicolon/newline-delimited macro body through the same driver primitives.",
    async run(ctx, options = {}) {
      if (!options.text) throw new Error("macro-text requires --text-body");
      const result = await runMacroText(ctx, options.text);
      return { status: result.status, result };
    },
  },
};

export function getFlow(name) {
  const key = String(name ?? "").trim();
  const flow = flowRegistry[key];
  if (!flow) throw new Error(`unknown flow ${key}; available=${Object.keys(flowRegistry).join(", ")}`);
  return flow;
}

export async function runRegisteredFlow(ctx, name, options = {}) {
  return getFlow(name).run(ctx, options);
}

function parseWaypoints(raw) {
  if (Array.isArray(raw)) return raw.map(normalizePoint);
  return String(raw)
    .split(/[;|]/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [x, y] = part.split(/[, ]+/u).map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad waypoint ${part}`);
      return { x, y };
    });
}

function normalizePoint(point) {
  return { x: Number(point.x), y: Number(point.y), areaId: point.areaId };
}

function aggregateStepStatus(steps) {
  if (steps.some((step) => step.status === "fail" || step.status === "failure")) return "fail";
  if (steps.some((step) => step.status === "degraded")) return "degraded";
  if (steps.some((step) => step.status === "warn")) return "warn";
  return "pass";
}

async function waitForPosture(ctx, posture, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / 250) + 1);
  let latest = null;
  for (let poll = 0; poll < maxPolls && Date.now() <= deadline; poll += 1) {
    latest = await query(ctx, "/vitals");
    if (latest.data?.posture === posture) return latest;
    await ctx.sleep(250);
  }
  throw new Error(`timed out waiting for posture ${posture}; latest=${JSON.stringify(latest?.data ?? null)}; receipt=${JSON.stringify(ctx.lastReceipt)}`);
}

async function waitForOptionalEvent(ctx, predicate, timeoutMs) {
  const startIndex = ctx.driver.envelopes.length;
  const deadline = Date.now() + timeoutMs;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / 50) + 1);
  for (let poll = 0; poll < maxPolls && Date.now() <= deadline; poll += 1) {
    const match = ctx.driver.envelopes.slice(startIndex).find(predicate);
    if (match) return match;
    await ctx.sleep(50);
  }
  return null;
}

async function waitForActorOutcome(ctx, actorId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / 500) + 1);
  let latest = null;
  for (let poll = 0; poll < maxPolls && Date.now() <= deadline; poll += 1) {
    const nearby = await query(ctx, "/nearby all");
    latest = (nearby.data?.actors ?? []).find((actor) => actor.id === actorId) ?? null;
    if (!latest) return { status: "not_visible", actorId };
    if (latest.lifeState && latest.lifeState !== "alive") return { status: latest.lifeState, actor: latest };
    if (/corpse/iu.test(latest.label ?? "")) return { status: "corpse", actor: latest };
    await ctx.sleep(500);
  }
  return { status: "timeout", actor: latest, lastReceipt: ctx.lastReceipt };
}
