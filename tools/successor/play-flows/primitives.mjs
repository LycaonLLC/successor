export class FlowStepError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "FlowStepError";
    this.details = details;
  }
}

const HARVEST_CORPSE_INTERACTION_RADIUS_CELLS = 1.75;
const TRAINER_FINE_CORRECTION_MAX_PULSES = 3;

export function createFlowContext(options = {}) {
  const sleep = options.sleep ?? delay;
  const tickRateHz = positiveNumber(options.tickRateHz, 30);
  const context = {
    flowName: options.flowName ?? "adhoc",
    gameUrl: options.gameUrl,
    driver: options.driver,
    actor: options.actor ?? options.actorId ?? null,
    actorId: options.actorId ?? actorIdFrom(options.actor),
    oracle: options.oracle,
    sleep,
    advanceTicks: options.advanceTicks ?? ((ticks) => sleep((Math.max(0, Number(ticks) || 0) * 1_000) / tickRateHz)),
    fetchJson: options.fetchJson,
    recordFrame: options.recordFrame ?? (() => undefined),
    onStep: options.onStep ?? (() => undefined),
    defaultTimeoutMs: options.defaultTimeoutMs ?? 12_000,
    tickRateHz,
    stepSeq: 0,
    steps: [],
    frames: [],
    vars: {},
    lastOracle: null,
    lastReceipt: null,
    _recordedEnvelopes: new WeakSet(),
    forActor: null,
  };
  context.forActor = (alias) => {
    if (typeof options.forActor !== "function") {
      if (sameActor(context.actor, alias)) return context;
      throw new FlowStepError(`flow context cannot bind actor ${String(alias)}`, { actor: context.actor });
    }
    const bound = options.forActor(alias);
    if (!bound || typeof bound !== "object") throw new FlowStepError(`unknown action actor ${String(alias)}`);
    return createFlowContext({
      ...options,
      ...bound,
      actor: bound.actor ?? alias,
      actorId: bound.actorId ?? actorIdFrom(bound.actor),
      flowName: context.flowName,
      onStep: bound.onStep ?? context.onStep,
      recordFrame: bound.recordFrame ?? context.recordFrame,
      forActor: bound.forActor ?? options.forActor,
    });
  };
  return context;
}

export async function query(ctx, line, options = {}) {
  const normalized = normalizeSlash(line);
  const step = startStep(ctx, "query", { line: normalized });
  const startIndex = ctx.driver.envelopes.length;
  sendDriverFrame(ctx, { op: "query", verb: normalized });
  const envelope = await waitForEnvelope(
    ctx,
    (candidate) => candidate.type === "query" && (candidate.line === normalized || `/${candidate.verb}` === normalized || candidate.verb === normalized.replace(/^\//u, "")),
    `query ${normalized}`,
    options.timeoutMs,
    startIndex,
  );
  return finishStep(ctx, step, "pass", { query: envelope, text: envelope.text, data: envelope.data });
}

export async function issueLocalLine(ctx, line, options = {}) {
  const normalized = normalizeSlash(line);
  const step = startStep(ctx, options.primitive ?? "local", { line: normalized });
  const startIndex = ctx.driver.envelopes.length;
  sendDriverFrame(ctx, { op: "verb", line: normalized });
  const envelope = await waitForEnvelope(
    ctx,
    (candidate) => (candidate.type === "event" && candidate.line === normalized) || (candidate.type === "status" && candidate.data?.line === normalized),
    `local ${normalized}`,
    options.timeoutMs,
    startIndex,
  );
  const ok = envelope.type === "event" && envelope.data?.result?.data?.ok !== false;
  if (options.requireOk !== false && !ok) {
    const failed = finishStep(ctx, step, "fail", { event: envelope, text: envelope.data?.result?.text ?? envelope.message });
    throw new FlowStepError(`local verb failed: ${normalized}`, failed);
  }
  return finishStep(ctx, step, ok ? "pass" : "warn", { event: envelope, text: envelope.data?.result?.text ?? envelope.message });
}

export async function issueAuthorityLine(ctx, line, options = {}) {
  const normalized = normalizeSlash(line);
  const step = startStep(ctx, options.primitive ?? "authority", { line: normalized, expect: options.commandKind });
  const startIndex = ctx.driver.envelopes.length;
  sendDriverFrame(ctx, { op: "verb", line: normalized });
  const queued = await waitForEnvelope(
    ctx,
    (candidate) => (candidate.type === "event" && candidate.event === "authority_queued" && candidate.line === normalized)
      || (candidate.type === "status" && (candidate.status === "verb_rejected" || candidate.status === "unknown_verb") && candidate.data?.line === normalized),
    `queue ${normalized}`,
    options.timeoutMs,
    startIndex,
  );

  if (queued.type !== "event") {
    const failed = finishStep(ctx, step, "fail", { event: queued, text: queued.message, data: queued.data });
    if (options.requireAccepted === false) return failed;
    throw new FlowStepError(`authority verb rejected before queue: ${normalized}`, failed);
  }

  const commandId = queued.data?.commandId;
  const commandKind = queued.data?.commandKind;
  if (options.commandKind && commandKind !== options.commandKind) {
    const failed = finishStep(ctx, step, "fail", { event: queued, commandId, commandKind, reason: "wrong_command_kind" });
    throw new FlowStepError(`expected ${options.commandKind}, got ${commandKind}`, failed);
  }
  if (typeof commandId !== "number") {
    const failed = finishStep(ctx, step, "fail", { event: queued, reason: "missing_command_id" });
    throw new FlowStepError(`queued event missing command id: ${normalized}`, failed);
  }

  const receipt = await waitForEnvelope(
    ctx,
    (candidate) => candidate.type === "receipt" && candidate.commandId === commandId && candidate.commandKind === commandKind,
    `receipt ${commandKind}#${commandId}`,
    options.receiptTimeoutMs ?? options.timeoutMs,
    startIndex,
  );
  const accepted = receipt.accepted === true;
  ctx.lastReceipt = receipt;
  const status = accepted ? "pass" : (options.requireAccepted === false ? "warn" : "fail");
  const finished = finishStep(ctx, step, status, { event: queued, receipt, commandId, commandKind, accepted });
  if (!accepted && options.requireAccepted !== false) {
    throw new FlowStepError(`receipt rejected for ${normalized}: ${receipt.reasonCode ?? "rejected"}`, finished);
  }
  return finished;
}

export async function faceHeading(ctx, heading, options = {}) {
  const facing = authorityFacing(heading);
  return issueAuthorityLine(ctx, `/set-move-intent 0 0 ${facing}`, {
    primitive: "faceHeading",
    commandKind: "SetMoveIntent",
    ...options,
  });
}

export async function moveTo(ctx, cell, options = {}) {
  const target = normalizeCell(cell);
  const tolerance = finiteNumber(options.toleranceCells, 0.75);
  const maxPulses = Math.max(1, Math.trunc(options.maxPulses ?? 180));
  const pulseMs = Math.max(80, Math.trunc(options.pulseMs ?? 420));
  const sprint = options.sprint !== false;
  const minDisplacementCells = finiteNumber(options.minDisplacementCells, 0.015);
  const maxStalePulses = Math.max(1, Math.trunc(options.maxStalePulses ?? 3));
  const step = startStep(ctx, "moveTo", { target, tolerance, maxPulses, pulseMs, sprint });
  const positions = [];
  let observed = await whereData(ctx);
  let current = observed;
  positions.push({ observed, effective: current, source: "where" });
  let lastHeading = headingForDelta(target.x - current.x, target.y - current.y);
  let stalePulses = 0;
  const stalledAxes = new Set();

  for (let pulse = 0; pulse < maxPulses; pulse += 1) {
    const dxRaw = target.x - current.x;
    const dyRaw = target.y - current.y;
    const distance = Math.hypot(dxRaw, dyRaw);
    const arrivalDistance = Math.max(Math.abs(dxRaw), Math.abs(dyRaw));
    if (arrivalDistance <= tolerance) {
      const stop = await stopMoveIntent(ctx, lastHeading);
      return finishStep(ctx, step, "pass", { positions, stop, distanceCells: round(distance), arrivalDistanceCells: round(arrivalDistance), pulses: pulse, stalePulses });
    }

    const horizontalAvailable = Math.abs(dxRaw) > tolerance && !stalledAxes.has("x");
    const verticalAvailable = Math.abs(dyRaw) > tolerance && !stalledAxes.has("y");
    const prioritizeVertical = verticalAvailable && (!horizontalAvailable || options.prioritizeVertical === true || Math.abs(dyRaw) > Math.abs(dxRaw));
    const dx = !prioritizeVertical && horizontalAvailable ? Math.sign(dxRaw) : 0;
    const dy = prioritizeVertical && verticalAvailable ? Math.sign(dyRaw) : 0;
    const activeAxis = dx !== 0 ? "x" : "y";
    lastHeading = dx !== 0 || dy !== 0 ? headingForDelta(dx, dy) : headingForDelta(dxRaw, dyRaw);
    const beforeObserved = observed;
    const beforeEffective = current;
    const intentLine = `/set-move-intent ${dx} ${dy} ${authorityFacing(lastHeading)}${sprint ? " true" : ""}`;
    const receipt = await issueAuthorityLine(ctx, intentLine, {
      primitive: "moveTo.intent",
      commandKind: "SetMoveIntent",
      receiptTimeoutMs: options.receiptTimeoutMs ?? 8_000,
    });
    await ctx.sleep(pulseMs);
    observed = await whereData(ctx);
    const observedMoved = distanceBetween(beforeObserved, observed);
    const activeAxisProgress = activeAxis === "x"
      ? Math.abs(target.x - beforeEffective.x) - Math.abs(target.x - observed.x)
      : Math.abs(target.y - beforeEffective.y) - Math.abs(target.y - observed.y);
    current = observed;
    if (activeAxisProgress >= minDisplacementCells) {
      stalePulses = 0;
      stalledAxes.clear();
      positions.push({ observed, effective: current, source: "where", movedCells: round(observedMoved), activeAxisProgressCells: round(activeAxisProgress) });
    } else {
      stalePulses += 1;
      positions.push({ observed, effective: current, source: "where", receipt, movedCells: round(observedMoved), activeAxisProgressCells: round(activeAxisProgress), stalePulses, activeAxis });
      if (stalePulses >= maxStalePulses) {
        stalledAxes.add(activeAxis);
        const alternateAxis = activeAxis === "x" ? "y" : "x";
        const alternateOutstanding = alternateAxis === "x" ? Math.abs(dxRaw) > tolerance : Math.abs(dyRaw) > tolerance;
        if (alternateOutstanding && !stalledAxes.has(alternateAxis)) {
          stalePulses = 0;
          continue;
        }
        const stop = await stopMoveIntent(ctx, lastHeading);
        const failed = finishStep(ctx, step, "fail", { positions, stop, reason: "movement_stalled", target, stalePulses, stalledAxes: [...stalledAxes], lastOracle: ctx.lastOracle, lastReceipt: ctx.lastReceipt });
        throw new FlowStepError(`moveTo stalled before ${target.x},${target.y}`, failed);
      }
    }
  }

  const stop = await stopMoveIntent(ctx, lastHeading);
  const distance = Math.hypot(target.x - current.x, target.y - current.y);
  const failed = finishStep(ctx, step, "fail", { positions, stop, distanceCells: round(distance), reason: "max_pulses", lastOracle: ctx.lastOracle, lastReceipt: ctx.lastReceipt });
  throw new FlowStepError(`moveTo max pulses before ${target.x},${target.y}`, failed);
}

export async function equipWeapon(ctx, weaponId, options = {}) {
  const args = [weaponId ?? "null"];
  if (options.weaponItemId !== undefined) args.push(String(options.weaponItemId));
  return issueAuthorityLine(ctx, `/equip-weapon ${args.join(" ")}`, {
    primitive: "equipWeapon",
    commandKind: "SetEquippedWeapon",
    ...options,
  });
}

export async function engageTarget(ctx, selector = "nearest hostile", options = {}) {
  const targetStep = await issueLocalLine(ctx, `/target ${selector}`, { primitive: "engageTarget.target", requireOk: options.requireTarget !== false });
  const target = targetStep.event?.data?.result?.data?.target ?? null;
  const attackLine = target?.id ? `/attack ${options.actionId ?? "basic_shot"} ${target.id}` : `/attack ${options.actionId ?? "basic_shot"}`;
  const attack = await issueAuthorityLine(ctx, attackLine, {
    primitive: "engageTarget.attack",
    commandKind: "QueueCombatAction",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  return { targetStep, target, attack };
}

export async function surveyBest(ctx, family = "iron", options = {}) {
  const startIndex = ctx.driver.envelopes.length;
  const survey = await issueAuthorityLine(ctx, `/survey ${family}`, {
    primitive: "surveyBest.survey",
    commandKind: "SurveyResource",
    requireAccepted: options.requireAccepted !== false,
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  if (survey.receipt?.accepted !== true) return { survey, best: null, result: null };
  const resultEnvelope = await waitForEnvelope(
    ctx,
    (candidate) => candidate.type === "event" && candidate.event === "survey_result" && surveyResultMatchesFamily(surveyPayload(candidate), family),
    `survey result for ${family}`,
    options.surveyResultTimeoutMs ?? 10_000,
    startIndex,
  );
  recordDriverEnvelope(ctx, resultEnvelope);
  const result = surveyPayload(resultEnvelope);
  const best = bestSurveyCell(result);
  const step = startStep(ctx, "surveyBest", { family });
  finishStep(ctx, step, "pass", { surveyResult: result, best });
  return { survey, result, best };
}

export async function sampleLoop(ctx, family = "iron", units = 10, options = {}) {
  const before = await inventoryTotal(ctx, options.inventoryFilter ?? family);
  const target = before.totalAvailable + Math.max(1, Math.trunc(units));
  const sample = await issueAuthorityLine(ctx, `/sample ${family}`, {
    primitive: "sampleLoop.sample",
    commandKind: "SampleResource",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const step = startStep(ctx, "sampleLoop", { family, units, before, target });
  const timeoutMs = positiveNumber(options.timeoutMs, 75_000);
  const pollMs = positiveNumber(options.pollMs, 1_000);
  const maxPolls = positiveInteger(options.maxPolls, Math.ceil(timeoutMs / pollMs) + 1);
  const deadline = Date.now() + timeoutMs;
  let latest = before;
  for (let poll = 0; poll < maxPolls && Date.now() <= deadline; poll += 1) {
    latest = await inventoryTotal(ctx, options.inventoryFilter ?? family);
    if (latest.totalAvailable >= target) {
      return finishStep(ctx, step, "pass", { before, after: latest, gained: latest.totalAvailable - before.totalAvailable, sample, polls: poll + 1 });
    }
    await ctx.sleep(pollMs);
  }
  const failed = finishStep(ctx, step, "fail", { before, after: latest, gained: latest.totalAvailable - before.totalAvailable, sample, reason: "budget_exhausted", lastOracle: ctx.lastOracle, lastReceipt: ctx.lastReceipt });
  await stopSamplingBestEffort(ctx, family, options);
  throw new FlowStepError(`sampleLoop timed out before ${units} units`, failed);
}

export async function lootNearest(ctx, options = {}) {
  const nearby = await query(ctx, "/nearby all");
  const origin = nearby.data?.origin ?? await whereData(ctx);
  const corpse = nearestActor(nearby.data?.actors ?? [], origin, (actor) => actor.lifeState !== "alive" || /corpse/iu.test(actor.label ?? actor.id ?? ""));
  const step = startStep(ctx, "lootNearest", { corpse: corpse?.id ?? null });
  if (!corpse) return finishStep(ctx, step, "warn", { reason: "no_lootable_corpse" });
  if (options.itemId === undefined) return finishStep(ctx, step, "warn", { corpse, reason: "loot_item_required" });
  const line = `/loot corpse:${corpse.id} ${options.itemId} ${options.variantId ?? 0} ${Math.max(1, Math.trunc(options.quantity ?? 1))}`;
  const loot = await issueAuthorityLine(ctx, line, {
    primitive: "lootNearest.loot",
    commandKind: "TakeLootItem",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  return finishStep(ctx, step, loot.receipt?.accepted ? "pass" : "warn", { corpse, loot });
}

export async function storeToExchange(ctx, options = {}) {
  const filter = options.filter ?? options.family ?? "iron";
  const inv = await query(ctx, `/inv ${filter}`);
  const row = chooseInventoryRow(inv.data?.rows ?? [], options);
  const step = startStep(ctx, "storeToExchange", { filter, row });
  if (!row) return finishStep(ctx, step, "warn", { reason: "no_inventory_row" });
  if (options.move !== false) {
    const exchange = await nearestExchangeCell(ctx);
    if (!exchange) return finishStep(ctx, step, "warn", { reason: "no_exchange_prop", row });
    await moveTo(ctx, exchange.interactionCell, { toleranceCells: 1, ...(options.moveOptions ?? {}) });
  }
  const quantity = Math.max(1, Math.min(Math.trunc(options.quantity ?? row.available ?? 1), Math.trunc(row.available ?? 1)));
  const stored = await issueAuthorityLine(ctx, `/store-to-exchange ${row.itemId} ${row.variantId} ${quantity}`, {
    primitive: "storeToExchange.store",
    commandKind: "StoreToExchange",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  return finishStep(ctx, step, "pass", { row, quantity, stored });
}
export async function bankStoreItem(ctx, options = {}) {
  const quantity = requiredPositiveInteger(options.quantity ?? 1, "quantity");
  const sourceStackId = options.sourceStackId !== undefined
    ? requiredText(options.sourceStackId, "sourceStackId")
    : await resolveInventoryStackId(ctx, options);
  const step = startStep(ctx, "bankStoreItem", { sourceStackId, quantity });
  const approach = options.move === false ? null : await moveToNearestTerminal(ctx, "bank_terminal", options);
  const command = await issueAuthorityLine(ctx, `/bank-store-item source_stack_id=${sourceStackId} quantity=${quantity}`, {
    primitive: "bankStoreItem.command",
    commandKind: "BankStoreItem",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
  });
  return finishStep(ctx, step, "pass", { sourceStackId, quantity, approach, command });
}

export async function bankRetrieveItem(ctx, options = {}) {
  const quantity = requiredPositiveInteger(options.quantity ?? 1, "quantity");
  const bankStackId = requiredText(options.bankStackId ?? options.stackId, "bankStackId");
  const step = startStep(ctx, "bankRetrieveItem", { bankStackId, quantity });
  const approach = options.move === false ? null : await moveToNearestTerminal(ctx, "bank_terminal", options);
  const command = await issueAuthorityLine(ctx, `/bank-retrieve-item bank_stack_id=${bankStackId} quantity=${quantity}`, {
    primitive: "bankRetrieveItem.command",
    commandKind: "BankRetrieveItem",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
  });
  return finishStep(ctx, step, "pass", { bankStackId, quantity, approach, command });
}

export async function bankDepositCredits(ctx, amount, options = {}) {
  const credits = requiredPositiveInteger(amount, "amount");
  const step = startStep(ctx, "bankDepositCredits", { amount: credits });
  const approach = options.move === false ? null : await moveToNearestTerminal(ctx, "bank_terminal", options);
  const command = await issueAuthorityLine(ctx, `/bank-deposit-credits amount=${credits}`, {
    primitive: "bankDepositCredits.command",
    commandKind: "BankDepositCredits",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
  });
  return finishStep(ctx, step, "pass", { amount: credits, approach, command });
}

export async function bankWithdrawCredits(ctx, amount, options = {}) {
  const credits = requiredPositiveInteger(amount, "amount");
  const step = startStep(ctx, "bankWithdrawCredits", { amount: credits });
  const approach = options.move === false ? null : await moveToNearestTerminal(ctx, "bank_terminal", options);
  const command = await issueAuthorityLine(ctx, `/bank-withdraw-credits amount=${credits}`, {
    primitive: "bankWithdrawCredits.command",
    commandKind: "BankWithdrawCredits",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
  });
  return finishStep(ctx, step, "pass", { amount: credits, approach, command });
}

export async function cloneSaveSkillBackup(ctx, options = {}) {
  const step = startStep(ctx, "cloneSaveSkillBackup", {});
  const approach = options.move === false ? null : await moveToNearestTerminal(ctx, "clone_terminal", options);
  const command = await issueAuthorityLine(ctx, "/clone-save-skill-backup", {
    primitive: "cloneSaveSkillBackup.command",
    commandKind: "CloneSaveSkillBackup",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
  });
  return finishStep(ctx, step, "pass", { approach, command });
}

function isExplicitlyCloneEligible(target) {
  return Boolean(target) && (
    (target.lifeState === "downed" && Number(target.bodyVanishTick) > 0)
    || (target.lifeState === "respawning" && Number(target.respawnAtTick) > 0)
  );
}

export async function attackUntilCloneEligible(ctx, targetId, options = {}) {
  const id = requiredText(targetId, "targetId");
  const step = startStep(ctx, "attackUntilCloneEligible", { targetId: id });
  const combat = await attackUntilDowned(ctx, id, { ...options, acceptCloneEligible: true });
  let oracle = await readOracle(ctx);
  let target = oracle?.actors?.[id] ?? null;
  const attacks = [];
  const maxLethalAttempts = positiveInteger(options.lethalAttempts, 8);
  for (let attempt = 0; attempt < maxLethalAttempts && target?.lifeState === "downed" && !isExplicitlyCloneEligible(target); attempt += 1) {
    attacks.push(await issueAuthorityLine(ctx, `/attack ${options.actionId ?? "basic_shot"} ${id}`, {
      primitive: "attackUntilCloneEligible.lethalAttack",
      commandKind: "QueueCombatAction",
      requireAccepted: false,
      receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
    }));
    await ctx.advanceTicks(options.pollTicks ?? 15);
    oracle = await readOracle(ctx);
    target = oracle?.actors?.[id] ?? null;
  }
  if (!isExplicitlyCloneEligible(target)) {
    const failed = finishStep(ctx, step, "fail", {
      combat,
      attacks,
      target,
      reason: "clone_ineligible",
      required: {
        alternatives: [
          { lifeState: "downed", bodyVanishTickPositive: true },
          { lifeState: "respawning", respawnAtTickPositive: true },
        ],
      },
      lastOracle: oracle,
    });
    throw new FlowStepError(`target ${id} is not clone-eligible`, failed);
  }
  return finishStep(ctx, step, "pass", {
    combat,
    attacks,
    target,
    bodyVanishTick: Number(target.bodyVanishTick),
    respawnAtTick: Number(target.respawnAtTick),
    oracle,
  });
}

export async function recoverPlayerCorpse(ctx, options = {}) {
  const corpseId = requiredText(options.corpseId, "corpseId");
  const step = startStep(ctx, "recoverPlayerCorpse", { corpseId });
  const before = await readOracle(ctx);
  const approach = options.move === false ? null : await resolveAndMoveToCorpse(ctx, corpseId, options);
  const credits = options.takeCredits === false ? null : await issueAuthorityLine(ctx, `/corpse-take-credits corpse_id=${corpseId}`, {
    primitive: "recoverPlayerCorpse.takeCredits",
    commandKind: "CorpseTakeCredits",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
  });
  const items = [];
  for (const item of options.items ?? []) {
    const itemId = requiredPositiveInteger(item.itemId, "item.itemId");
    const variantId = nonNegativeInteger(item.variantId ?? 0, "item.variantId");
    const quantity = requiredPositiveInteger(item.quantity, "item.quantity");
    items.push(await issueAuthorityLine(ctx, `/loot corpse:${corpseId} ${itemId} ${variantId} ${quantity}`, {
      primitive: "recoverPlayerCorpse.takeItem",
      commandKind: "TakeLootItem",
      receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
    }));
  }
  await settleTicks(ctx, options.settleTicks ?? 1);
  const after = await readOracle(ctx);
  const expected = options.expectedInventory ?? [];
  if (expected.length > 0 && !expectedInventoryRows(after, expected)) {
    const failed = finishStep(ctx, step, "fail", { corpseId, approach, credits, items, before, after, reason: "inventory_recovery_mismatch" });
    throw new FlowStepError(`corpse ${corpseId} recovered inventory did not match exact expectation`, failed);
  }
  return finishStep(ctx, step, "pass", { corpseId, approach, credits, items, before, after });
}

export async function trainSkill(ctx, boxId, options = {}) {
  const trainer = options.trainerId ? { id: options.trainerId, x: null, y: null } : await nearestTrainer(ctx);
  const step = startStep(ctx, "trainSkill", { boxId, trainer: trainer?.id ?? null });
  if (!trainer?.id) throw flowFailure(ctx, `no trainer available for skill ${String(boxId)}`, step, { reason: "no_trainer" });
  const approach = trainer.x !== null && trainer.y !== null && options.move !== false
    ? await approachTrainer(ctx, trainer, options)
    : null;
  const trained = await issueEconomyAuthorityLine(ctx, `/train-skill ${boxId} ${trainer.id}`, {
    primitive: "trainSkill.purchase",
    commandKind: "PurchaseSkillBox",
    requireAccepted: options.requireAccepted !== false,
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
    maxCooldownRetries: options.maxCooldownRetries,
  });
  return finishStep(ctx, step, trained.receipt?.accepted ? "pass" : "warn", { trainer, approach, trained });
}

export async function setCareerGoal(ctx, goalId, options = {}) {
  const trainer = await resolveTrainer(ctx, options);
  const step = startStep(ctx, "setCareerGoal", { goalId, trainerId: trainer.id });
  const command = await issueEconomyAuthorityLine(
    ctx,
    `/set-career-goal goal_id=${requiredText(goalId, "goalId")} trainer_actor_id=${trainer.id}`,
    {
      primitive: "setCareerGoal.command",
      commandKind: "SetCareerGoal",
      receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
      maxCooldownRetries: options.maxCooldownRetries,
    },
  );
  await settleTicks(ctx, options.settleTicks ?? 1);
  return finishStep(ctx, step, "pass", { trainer, command });
}

export async function attackUntilDowned(ctx, targetId, options = {}) {
  const id = requiredText(targetId, "targetId");
  const actionId = requiredText(options.actionId ?? "basic_shot", "actionId");
  const step = startStep(ctx, "attackUntilDowned", { targetId: id, actionId });
  const before = await readOracle(ctx);
  const initialTarget = before?.actors?.[id] ?? null;
  if (!initialTarget) throw flowFailure(ctx, `attack target ${id} is absent from oracle`, step, { lastOracle: before });
  if (initialTarget.lifeState === "downed" || (options.acceptCloneEligible === true && isExplicitlyCloneEligible(initialTarget))) {
    return finishStep(ctx, step, "pass", {
      target: initialTarget,
      attack: null,
      alreadyDowned: initialTarget.lifeState === "downed",
      alreadyCloneEligible: isExplicitlyCloneEligible(initialTarget),
      oracle: before,
    });
  }

  const pollTicks = positiveInteger(options.pollTicks, 15);
  const maxTicks = positiveInteger(options.maxTicks, 2_700);
  const maxPolls = positiveInteger(options.maxPolls, Math.ceil(maxTicks / pollTicks) + 1);
  const requeueTicks = positiveInteger(options.requeueTicks, 30);
  const attacks = [];
  const rejectedAttempts = [];
  const movements = [];
  const approachRangeCells = positiveNumber(options.approachRangeCells, 1.25);
  let latest = before;
  let advancedTicks = 0;
  let nextRequeueTick = 0;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    const target = latest?.actors?.[id] ?? null;
    if (target?.lifeState === "downed" || (options.acceptCloneEligible === true && isExplicitlyCloneEligible(target))) {
      return finishStep(ctx, step, "pass", {
        target,
        attack: attacks.at(-1) ?? null,
        attacks,
        rejectedAttempts,
        movements,
        oracle: latest,
        polls: poll + 1,
        advancedTicks,
        cloneEligible: isExplicitlyCloneEligible(target),
      });
    }
    if (!target) {
      throw flowFailure(ctx, `attack target ${id} is absent from oracle`, step, { attacks, rejectedAttempts, movements, lastOracle: latest });
    }
    if (advancedTicks >= nextRequeueTick) {
      const actorId = controlledActorId(ctx);
      const attacker = actorId ? latest?.actors?.[actorId] ?? null : null;
      if (attacker && target && distanceBetween(attacker, target) > approachRangeCells) {
        const approach = cardinalAttackApproachCell(attacker, target, approachRangeCells);
        const movement = await moveTo(ctx, approach, {
          ...(options.attackMoveOptions ?? {}),
          toleranceCells: options.attackApproachToleranceCells ?? 0.4,
          prioritizeVertical: true,
        });
        movements.push({ target: { areaId: target.areaId, x: target.x, y: target.y }, approach, movement });
      }
      const attempt = await issueAuthorityLine(ctx, `/attack ${actionId} ${id}`, {
        primitive: "attackUntilDowned.attack",
        commandKind: "QueueCombatAction",
        requireAccepted: false,
        receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
      });
      if (attempt.receipt?.accepted === true) {
        attacks.push(attempt);
      } else if (attempt.receipt?.reasonCode === "out_of_range" || attempt.receipt?.reasonCode === "target_unavailable") {
        rejectedAttempts.push(attempt);
      } else {
        throw flowFailure(ctx, `attack ${actionId} against ${id} rejected`, step, { attempt, attacks, rejectedAttempts, movements, lastOracle: latest });
      }
      nextRequeueTick = advancedTicks + requeueTicks;
    }
    if (advancedTicks + pollTicks > maxTicks) break;
    await ctx.advanceTicks(pollTicks);
    advancedTicks += pollTicks;
    latest = await readOracle(ctx);
  }
  throw flowFailure(ctx, `attack target ${id} did not become downed`, step, {
    target: latest?.actors?.[id] ?? null,
    attack: attacks.at(-1) ?? null,
    attacks,
    rejectedAttempts,
    movements,
    advancedTicks,
    maxTicks,
    maxPolls,
    requeueTicks,
    lastOracle: latest,
  });
}

export async function harvestCorpse(ctx, targetId, options = {}) {
  const id = requiredText(targetId, "targetId");
  const material = options.material ? ` material=${requiredText(options.material, "material")}` : "";
  const step = startStep(ctx, "harvestCorpse", { targetId: id, material: options.material ?? null });
  const ready = await waitForActorOwnedHarvestableCorpse(ctx, id, options);
  const before = options.itemId === undefined ? null : ready.oracle;
  const beforeAvailable = options.itemId === undefined ? null : oracleInventoryAvailable(ctx, before, { itemId: options.itemId, variantId: options.variantId });
  const origin = await positionData(ctx);
  const approach = adjacentInteractionCell(origin, ready.value);
  const movement = await moveTo(ctx, approach, {
    ...(options.moveOptions ?? {}),
    toleranceCells: options.harvestApproachToleranceCells ?? 0.75,
  });
  const harvestOracle = await readOracle(ctx);
  const actorId = controlledActorId(ctx);
  const target = actorOwnedHarvestableCorpse(harvestOracle, id, actorId);
  const harvester = actorId ? harvestOracle?.actors?.[actorId] : null;
  const distanceCells = harvester && target ? distanceBetween(harvester, target) : Number.NaN;
  if (!target || !harvester || harvester.areaId !== target.areaId || distanceCells > HARVEST_CORPSE_INTERACTION_RADIUS_CELLS) {
    throw flowFailure(ctx, `target ${id} is not an in-range actor-owned harvestable corpse`, step, {
      ready,
      movement,
      target,
      harvester,
      distanceCells,
      interactionRadiusCells: HARVEST_CORPSE_INTERACTION_RADIUS_CELLS,
      lastOracle: harvestOracle,
    });
  }
  const command = await issueAuthorityLine(ctx, `/harvest-corpse target_actor_id=${target.id}${material}`, {
    primitive: "harvestCorpse.command",
    commandKind: "HarvestCorpse",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
  });
  let confirmation = null;
  if (options.itemId !== undefined) {
    confirmation = await pollOracle(
      ctx,
      (oracle) => oracleInventoryAvailable(ctx, oracle, { itemId: options.itemId, variantId: options.variantId }) > beforeAvailable,
      `harvested item ${options.itemId}`,
      { timeoutMs: options.timeoutMs ?? 12_000, maxTicks: options.maxTicks ?? 180, pollTicks: options.pollTicks ?? 3 },
    );
  } else {
    await settleTicks(ctx, options.settleTicks ?? 1);
  }
  return finishStep(ctx, step, "pass", {
    target,
    ready: { polls: ready.polls, advancedTicks: ready.advancedTicks },
    approach,
    movement,
    command,
    beforeAvailable,
    confirmation,
  });
}

export async function surveyAndSample(ctx, family = "iron", options = {}) {
  const resourceFamily = requiredText(family, "family");
  const step = startStep(ctx, "surveyAndSample", { family: resourceFamily, itemId: options.itemId ?? null, minUnits: options.minUnits ?? null });
  const origin = await positionData(ctx);
  const surveyed = await surveyBest(ctx, resourceFamily, options);
  if (!surveyed.best) throw flowFailure(ctx, `survey ${resourceFamily} produced no richest cell`, step, { survey: surveyed });
  const movement = await moveTo(ctx, surveyed.best, { toleranceCells: options.toleranceCells ?? 0.9, ...(options.moveOptions ?? {}) });

  let sample;
  let gathering;
  if (options.itemId === undefined) {
    sample = await sampleLoop(ctx, resourceFamily, options.units ?? 1, options);
    gathering = { before: sample.before, after: sample.after, gained: sample.gained, polls: sample.polls };
  } else {
    const beforeOracle = await readOracle(ctx);
    const beforeAvailable = oracleInventoryAvailable(ctx, beforeOracle, { itemId: options.itemId, variantId: options.variantId });
    const target = Math.max(
      1,
      Math.trunc(options.minUnits ?? (beforeAvailable + Math.max(1, Math.trunc(options.units ?? 1)))),
    );
    const sampleMaxTicks = options.maxTicks ?? Math.max(6_300, (target - beforeAvailable) * 600);
    sample = await issueAuthorityLine(ctx, `/sample ${resourceFamily}`, {
      primitive: "surveyAndSample.sample",
      commandKind: "SampleResource",
      receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
    });
    let reached;
    try {
      reached = await pollOracle(
        ctx,
        (oracle) => {
          const available = oracleInventoryAvailable(ctx, oracle, { itemId: options.itemId, variantId: options.variantId });
          return available >= target ? available : null;
        },
        `${resourceFamily} inventory to reach ${target}`,
        {
          timeoutMs: options.timeoutMs ?? 210_000,
          maxTicks: sampleMaxTicks,
          pollTicks: options.pollTicks ?? 30,
          maxPolls: options.maxPolls ?? Math.ceil(sampleMaxTicks / (options.pollTicks ?? 30)) + 1,
        },
      );
    } catch (error) {
      await stopSamplingBestEffort(ctx, resourceFamily, options);
      throw error;
    }
    gathering = { before: beforeAvailable, after: reached.value, gained: reached.value - beforeAvailable, target, polls: reached.polls, advancedTicks: reached.advancedTicks, oracle: reached.oracle };
  }

  const stopped = await issueAuthorityLine(ctx, `/sample ${resourceFamily} true`, {
    primitive: "surveyAndSample.stop",
    commandKind: "SampleResource",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  let stood = null;
  let standing = null;
  if (options.standAfter !== false) {
    stood = await issueAuthorityLine(ctx, "/stand", {
      primitive: "surveyAndSample.stand",
      commandKind: "SetPosture",
      receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
    });
    const controlledId = controlledActorId(ctx);
    if (controlledId) {
      standing = await pollOracle(
        ctx,
        (oracle) => oracle?.actors?.[controlledId]?.posture === "standing" ? oracle.actors[controlledId] : null,
        `actor ${controlledId} to stand after sampling`,
        { timeoutMs: options.postureTimeoutMs ?? 10_000, maxTicks: options.postureMaxTicks ?? 300, pollTicks: options.posturePollTicks ?? 3 },
      );
    } else {
      await settleTicks(ctx, options.standSettleTicks ?? 30);
    }
  }
  let returned = null;
  if (options.returnToStart === true) returned = await moveTo(ctx, origin, { toleranceCells: options.returnToleranceCells ?? 0.9, ...(options.moveOptions ?? {}) });
  return finishStep(ctx, step, "pass", { origin, surveyed, movement, sample, gathering, stopped, stood, standing, returned });
}

export async function craftRecipe(ctx, recipeId, slots = [], options = {}) {
  const id = requiredText(recipeId, "recipeId");
  const slotSpecs = Array.isArray(slots) ? slots : [];
  validateCraftExperimentInputs(options);
  const step = startStep(ctx, "craftRecipe", { recipeId: id, slots: slotSpecs.length });
  const commands = [];
  const sessions = [];

  let eventStart = ctx.driver.envelopes.length;
  const begin = await issueAuthorityLine(ctx, `/craft-begin recipe_id=${id}`, {
    primitive: "craftRecipe.begin",
    commandKind: "CraftBegin",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  commands.push(begin);
  const opened = await waitForCraftSession(ctx, eventStart, (payload) => payload?.phase === "slots" && payload.recipeId === id, `craft ${id} slot screen`, options);
  sessions.push(opened);
  await settleTicks(ctx, options.settleTicks ?? 1);

  for (const rawSlot of slotSpecs) {
    const slot = await resolveCraftSlot(ctx, rawSlot);
    eventStart = ctx.driver.envelopes.length;
    const assigned = await issueAuthorityLine(
      ctx,
      `/craft-assign-slot slot_index=${slot.slotIndex} container=${slot.container} stack_id=${slot.stackId} variant_id=${slot.variantId}`,
      { primitive: "craftRecipe.assign", commandKind: "CraftAssignSlot", receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000 },
    );
    commands.push(assigned);
    const session = await waitForCraftSession(
      ctx,
      eventStart,
      (payload) => craftSlotAssignment(payload, slot.slotIndex)?.stackId === String(slot.stackId),
      `craft ${id} slot ${slot.slotIndex} assignment`,
      options,
    );
    sessions.push(session);
    await settleTicks(ctx, options.settleTicks ?? 1);
  }

  eventStart = ctx.driver.envelopes.length;
  const assembledCommand = await issueAuthorityLine(ctx, "/craft-assemble", {
    primitive: "craftRecipe.assemble",
    commandKind: "CraftAssemble",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  commands.push(assembledCommand);
  const assembledEvent = await waitForCraftSession(ctx, eventStart, (payload) => payload?.phase === "assembled" && payload.recipeId === id, `craft ${id} assembly`, options);
  sessions.push(assembledEvent);
  const assembledPayload = craftPayload(assembledEvent);
  await settleTicks(ctx, options.settleTicks ?? 1);

  const experiments = normalizeExperiments(options, assembledPayload);
  for (const experiment of experiments) {
    const lineId = nonNegativeInteger(experiment.lineId ?? experiment.line_id, "experiment.lineId");
    const points = requiredPositiveInteger(experiment.points, "experiment.points");
    const lines = assembledPayload?.assembled?.lines ?? [];
    if (lines.length > 0 && !lines.some((line) => Number(line.lineId) === lineId)) {
      throw flowFailure(ctx, `craft ${id} has no experimentation line_id ${lineId}`, step, { availableLineIds: lines.map((line) => line.lineId) });
    }
    eventStart = ctx.driver.envelopes.length;
    const experimented = await issueAuthorityLine(ctx, `/craft-experiment line_id=${lineId} points=${points}`, {
      primitive: "craftRecipe.experiment",
      commandKind: "CraftExperiment",
      receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
    });
    commands.push(experimented);
    const session = await waitForCraftSession(ctx, eventStart, (payload) => payload?.phase === "assembled" && craftLine(payload, lineId), `craft ${id} experiment line_id ${lineId}`, options);
    sessions.push(session);
    await settleTicks(ctx, options.settleTicks ?? 1);
  }

  const beforeOutput = options.outputItemId === undefined ? null : await readOracle(ctx);
  const beforeAvailable = options.outputItemId === undefined ? null : oracleInventoryAvailable(ctx, beforeOutput, { itemId: options.outputItemId, variantId: options.outputVariantId });
  eventStart = ctx.driver.envelopes.length;
  const finalized = await issueAuthorityLine(ctx, "/craft-finalize-prototype", {
    primitive: "craftRecipe.finalize",
    commandKind: "CraftFinalizePrototype",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  commands.push(finalized);
  const closed = await waitForCraftSession(ctx, eventStart, (payload) => payload?.phase === "browse" && !payload.recipeId, `craft ${id} finalize`, options);
  sessions.push(closed);

  let output = null;
  if (options.outputItemId !== undefined) {
    output = await pollOracle(
      ctx,
      (oracle) => {
        const available = oracleInventoryAvailable(ctx, oracle, { itemId: options.outputItemId, variantId: options.outputVariantId });
        return available > beforeAvailable ? available : null;
      },
      `crafted output item ${options.outputItemId}`,
      { timeoutMs: options.outputTimeoutMs ?? 12_000, maxTicks: options.outputMaxTicks ?? 180, pollTicks: options.outputPollTicks ?? 2 },
    );
  } else {
    await settleTicks(ctx, options.settleTicks ?? 1);
  }
  return finishStep(ctx, step, "pass", { recipeId: id, commands, sessions, experiments, finalized, output });
}

export async function expectCraftRejected(ctx, recipeId, expectedReason, options = {}) {
  const id = requiredText(recipeId, "recipeId");
  const step = startStep(ctx, "expectCraftRejected", { recipeId: id, expectedReason: expectedReason ?? null });
  const command = await issueAuthorityLine(ctx, `/craft-begin recipe_id=${id}`, {
    primitive: "expectCraftRejected.begin",
    commandKind: "CraftBegin",
    requireAccepted: false,
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const receipt = command.receipt;
  if (!receipt || receipt.accepted !== false) {
    throw flowFailure(ctx, `craft ${id} was accepted; rejection was required`, step, { command, lastReceipt: receipt ?? null });
  }
  if (expectedReason && receipt.reasonCode !== expectedReason) {
    throw flowFailure(ctx, `craft ${id} rejected with ${receipt.reasonCode ?? "unknown"}, expected ${expectedReason}`, step, { command, lastReceipt: receipt });
  }
  return finishStep(ctx, step, "pass", { outcome: "expected_rejection", command, receipt, reasonCode: receipt.reasonCode ?? null });
}

export async function craftAssignSlot(ctx, slotIndex, item, options = {}) {
  const index = nonNegativeInteger(slotIndex, "slotIndex");
  const selected = await resolveInventoryRow(ctx, item ?? {}, `craft slot ${index}`);
  const step = startStep(ctx, "craftAssignSlot", { slotIndex: index, item: selected });
  const eventStart = ctx.driver.envelopes.length;
  const command = await issueAuthorityLine(ctx, `/craft-assign-slot slot_index=${index} container=${selected.container} stack_id=${selected.stackId} variant_id=${selected.variantId}`, {
    primitive: "craftAssignSlot.command",
    commandKind: "CraftAssignSlot",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const session = await waitForCraftSession(
    ctx,
    eventStart,
    (payload) => craftSlotAssignment(payload, index)?.stackId === String(selected.stackId),
    `craft slot ${index} assignment`,
    options,
  );
  await settleTicks(ctx, options.settleTicks ?? 1);
  const oracle = await confirmOracleReceiptTick(ctx, command.receipt, options);
  return finishStep(ctx, step, "pass", { command, item: selected, session, oracle });
}

export async function craftClearSlot(ctx, slotIndex, options = {}) {
  const index = nonNegativeInteger(slotIndex, "slotIndex");
  const step = startStep(ctx, "craftClearSlot", { slotIndex: index });
  const eventStart = ctx.driver.envelopes.length;
  const command = await issueAuthorityLine(ctx, `/craft-clear-slot slot_index=${index}`, {
    primitive: "craftClearSlot.command",
    commandKind: "CraftClearSlot",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const session = await waitForCraftSession(ctx, eventStart, (payload) => {
    const slot = payload?.slotScreen?.slots?.find((candidate) => Number(candidate.slotIndex) === index);
    return slot && (slot.assigned === null || slot.assigned === undefined);
  }, `craft slot ${index} clear`, options);
  await settleTicks(ctx, options.settleTicks ?? 1);
  const oracle = await confirmOracleReceiptTick(ctx, command.receipt, options);
  return finishStep(ctx, step, "pass", { command, session, oracle });
}

export async function craftDraftSchematic(ctx, maxUses, options = {}) {
  const uses = requiredPositiveInteger(maxUses, "maxUses");
  const step = startStep(ctx, "craftDraftSchematic", { maxUses: uses });
  const before = await readOracle(ctx);
  const beforeIds = new Set((before?.draftedSchematics ?? []).map((row) => row.schematicId ?? row.id));
  const command = await issueAuthorityLine(ctx, `/craft-draft-schematic max_uses=${uses}`, {
    primitive: "craftDraftSchematic.command",
    commandKind: "CraftDraftSchematic",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const confirmation = await pollOracle(
    ctx,
    (oracle) => (oracle?.draftedSchematics ?? []).find((row) => !beforeIds.has(row.schematicId ?? row.id)) ?? null,
    "drafted schematic oracle row",
    { timeoutMs: options.timeoutMs ?? 12_000, maxTicks: options.maxTicks ?? 180, pollTicks: options.pollTicks ?? 2 },
  );
  return finishStep(ctx, step, "pass", { command, schematic: confirmation.value, oracle: confirmation.oracle });
}

export async function claimParcel(ctx, parcel, options = {}) {
  const spec = parcel ?? {};
  const planetId = requiredText(spec.planetId ?? spec.planet_id, "planetId");
  const areaId = requiredText(spec.areaId ?? spec.area_id, "areaId");
  const x = finiteInteger(spec.x, "x");
  const y = finiteInteger(spec.y, "y");
  const tier = requiredText(spec.tier ?? "homestead", "tier");
  const step = startStep(ctx, "claimParcel", { planetId, areaId, x, y, tier });
  const before = await readOracle(ctx);
  const beforeIds = new Set((before?.placedParcels ?? []).map((row) => row.parcelId));
  const command = await issueAuthorityLine(ctx, `/claim-parcel planet_id=${planetId} area_id=${areaId} x=${x} y=${y} tier=${tier}`, {
    primitive: "claimParcel.command",
    commandKind: "ClaimParcel",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const confirmation = await pollOracle(
    ctx,
    (oracle) => (oracle?.placedParcels ?? []).find((row) => !beforeIds.has(row.parcelId) && row.areaId === areaId && row.tier === tier) ?? null,
    `parcel claim in ${areaId}`,
    { timeoutMs: options.timeoutMs ?? 12_000, maxTicks: options.maxTicks ?? 180, pollTicks: options.pollTicks ?? 2 },
  );
  return finishStep(ctx, step, "pass", { command, parcel: confirmation.value, oracle: confirmation.oracle });
}

export async function tillTile(ctx, parcelId, cell, options = {}) {
  const tile = normalizeFarmCell(parcelId, cell);
  const step = startStep(ctx, "tillTile", tile);
  const command = await issueAuthorityLine(ctx, farmLine("till-tile", tile), {
    primitive: "tillTile.command",
    commandKind: "TillTile",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const confirmation = await pollOracle(ctx, (oracle) => farmTile(oracle, tile, (row) => row.tilled === true), `tilled tile ${tile.cellX},${tile.cellY}`, farmPollOptions(options));
  return finishStep(ctx, step, "pass", { command, tile: confirmation.value, oracle: confirmation.oracle });
}

export async function plantSeed(ctx, parcelId, cell, seed, options = {}) {
  const tile = normalizeFarmCell(parcelId, cell);
  const exactSeed = await resolveInventoryRow(ctx, seed ?? {}, "seed");
  const step = startStep(ctx, "plantSeed", { ...tile, seed: exactSeed });
  const line = `${farmLine("plant-seed", tile)} container=${exactSeed.container} stack_id=${exactSeed.stackId} variant_id=${exactSeed.variantId}`;
  const command = await issueAuthorityLine(ctx, line, {
    primitive: "plantSeed.command",
    commandKind: "PlantSeed",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const confirmation = await pollOracle(
    ctx,
    (oracle) => farmTile(oracle, tile, (row) => row.crop
      && Number(row.crop.seedItemId) === Number(exactSeed.itemId)
      && Number(row.crop.seedVariantId) === Number(exactSeed.variantId)
      && (seed?.species === undefined || row.crop.species === seed.species)),
    `planted tile ${tile.cellX},${tile.cellY}`,
    farmPollOptions(options),
  );
  return finishStep(ctx, step, "pass", { command, seed: exactSeed, tile: confirmation.value, oracle: confirmation.oracle });
}

export async function waterTile(ctx, parcelId, cell, options = {}) {
  const tile = normalizeFarmCell(parcelId, cell);
  const step = startStep(ctx, "waterTile", tile);
  const command = await issueAuthorityLine(ctx, farmLine("water-tile", tile), {
    primitive: "waterTile.command",
    commandKind: "WaterTile",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const confirmation = await pollOracle(
    ctx,
    (oracle) => farmTile(oracle, tile, (row) => Number(row.moisturePct ?? 0) >= Number(options.minMoisturePct ?? 1)),
    `watered tile ${tile.cellX},${tile.cellY}`,
    farmPollOptions(options),
  );
  return finishStep(ctx, step, "pass", { command, tile: confirmation.value, oracle: confirmation.oracle });
}

export async function placeFarmStructure(ctx, parcelId, structureItemId, cell, options = {}) {
  const tile = normalizeFarmCell(parcelId, cell);
  const itemId = requiredPositiveInteger(structureItemId, "structureItemId");
  const step = startStep(ctx, "placeFarmStructure", { ...tile, structureItemId: itemId });
  const before = await readOracle(ctx);
  const beforeAvailable = oracleInventoryAvailable(ctx, before, { itemId });
  const command = await issueAuthorityLine(ctx, `/place-farm-structure parcel_id=${tile.parcelId} structure_item_id=${itemId} cell_x=${tile.cellX} cell_y=${tile.cellY}`, {
    primitive: "placeFarmStructure.command",
    commandKind: "PlaceFarmStructure",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const confirmation = await pollOracle(
    ctx,
    (oracle) => {
      const afterAvailable = oracleInventoryAvailable(ctx, oracle, { itemId });
      return afterAvailable < beforeAvailable ? { afterAvailable } : null;
    },
    `farm structure item ${itemId} to be consumed`,
    farmPollOptions(options),
  );
  return finishStep(ctx, step, "pass", { command, beforeAvailable, afterAvailable: confirmation.value.afterAvailable, oracle: confirmation.oracle });
}

export async function removeFarmStructure(ctx, parcelId, structureId, options = {}) {
  const parcel = requiredText(parcelId, "parcelId");
  const structure = requiredText(structureId, "structureId");
  const itemId = requiredPositiveInteger(options.itemId, "itemId");
  const step = startStep(ctx, "removeFarmStructure", { parcelId: parcel, structureId: structure, itemId });
  const before = await readOracle(ctx);
  const beforeAvailable = oracleInventoryAvailable(ctx, before, { itemId });
  const command = await issueAuthorityLine(ctx, `/remove-farm-structure parcel_id=${parcel} structure_id=${structure}`, {
    primitive: "removeFarmStructure.command",
    commandKind: "RemoveFarmStructure",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const confirmation = await pollOracle(
    ctx,
    (oracle) => {
      const afterAvailable = oracleInventoryAvailable(ctx, oracle, { itemId });
      return afterAvailable > beforeAvailable ? { afterAvailable } : null;
    },
    `returned farm structure item ${itemId}`,
    farmPollOptions(options),
  );
  const absence = await issueAuthorityLine(ctx, `/remove-farm-structure parcel_id=${parcel} structure_id=${structure}`, {
    primitive: "removeFarmStructure.absence",
    commandKind: "RemoveFarmStructure",
    requireAccepted: false,
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  if (absence.receipt?.accepted !== false || absence.receipt.reasonCode !== "no_farm_structure") {
    throw flowFailure(ctx, `farm structure ${structure} was not proven absent`, step, { command, absence, oracle: confirmation.oracle });
  }
  return finishStep(ctx, step, "pass", {
    command,
    absence,
    beforeAvailable,
    afterAvailable: confirmation.value.afterAvailable,
    removalConfirmed: true,
    oracle: confirmation.oracle,
  });
}

export async function spliceAssignSlot(ctx, slotIndex, item, options = {}) {
  const index = nonNegativeInteger(slotIndex, "slotIndex");
  const selected = await resolveInventoryRow(ctx, item ?? {}, `splice slot ${index}`);
  const step = startStep(ctx, "spliceAssignSlot", { slotIndex: index, item: selected });
  const eventStart = ctx.driver.envelopes.length;
  const command = await issueAuthorityLine(ctx, `/splice-assign-slot slot_index=${index} container=${selected.container} stack_id=${selected.stackId} variant_id=${selected.variantId}`, {
    primitive: "spliceAssignSlot.command",
    commandKind: "SpliceAssignSlot",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const session = await waitForSpliceSession(ctx, eventStart, (payload) => {
    const slot = payload?.slots?.find((candidate) => Number(candidate.slotIndex) === index);
    return slot?.filled === true;
  }, `splice slot ${index} assignment`, options);
  await settleTicks(ctx, options.settleTicks ?? 1);
  const oracle = await confirmOracleReceiptTick(ctx, command.receipt, options);
  return finishStep(ctx, step, "pass", { command, item: selected, session, oracle });
}

export async function spliceClearSlot(ctx, slotIndex, options = {}) {
  const index = nonNegativeInteger(slotIndex, "slotIndex");
  const step = startStep(ctx, "spliceClearSlot", { slotIndex: index });
  const eventStart = ctx.driver.envelopes.length;
  const command = await issueAuthorityLine(ctx, `/splice-clear-slot slot_index=${index}`, {
    primitive: "spliceClearSlot.command",
    commandKind: "SpliceClearSlot",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const session = await waitForSpliceSession(ctx, eventStart, (payload) => {
    const slot = payload?.slots?.find((candidate) => Number(candidate.slotIndex) === index);
    return slot && slot.filled === false;
  }, `splice slot ${index} clear`, options);
  await settleTicks(ctx, options.settleTicks ?? 1);
  const oracle = await confirmOracleReceiptTick(ctx, command.receipt, options);
  return finishStep(ctx, step, "pass", { command, session, oracle });
}

export async function spliceCancel(ctx, options = {}) {
  const step = startStep(ctx, "spliceCancel");
  const eventStart = ctx.driver.envelopes.length;
  const command = await issueAuthorityLine(ctx, "/splice-cancel", {
    primitive: "spliceCancel.command",
    commandKind: "SpliceCancel",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const session = await waitForSpliceSession(ctx, eventStart, (payload) => payload === null || payload?.phase === "browse", "splice session cancel", options);
  await settleTicks(ctx, options.settleTicks ?? 1);
  const oracle = await confirmOracleReceiptTick(ctx, command.receipt, options);
  return finishStep(ctx, step, "pass", { command, session, oracle });
}

export async function spliceBegin(ctx, species, options = {}) {
  const id = requiredText(species, "species");
  const step = startStep(ctx, "spliceBegin", { species: id });
  const eventStart = ctx.driver.envelopes.length;
  const command = await issueAuthorityLine(ctx, `/splice-begin species=${id}`, {
    primitive: "spliceBegin.command",
    commandKind: "SpliceBegin",
    receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
  });
  const session = await waitForSpliceSession(ctx, eventStart, (payload) => payload?.phase === "slots", `splice ${id} slot session`, options);
  await settleTicks(ctx, options.settleTicks ?? 1);
  const oracle = await confirmOracleReceiptTick(ctx, command.receipt, options);
  return finishStep(ctx, step, "pass", { command, session, oracle });
}

export async function waitForExtractorCollectable(ctx, extractorId, options = {}) {
  const id = requiredText(extractorId, "extractorId");
  const minUnits = requiredPositiveInteger(options.minUnits ?? 1, "minUnits");
  const step = startStep(ctx, "waitForExtractorCollectable", { extractorId: id, minUnits });
  const confirmation = await pollOracle(
    ctx,
    (oracle) => {
      const extractor = (oracle?.placedExtractors ?? []).find((candidate) => candidate.extractorId === id) ?? null;
      return extractor && Number.isInteger(extractor.collectableUnits) && extractor.collectableUnits >= minUnits ? extractor : null;
    },
    `extractor ${id} to reach ${minUnits} collectable units`,
    farmPollOptions(options),
  );
  return finishStep(ctx, step, "pass", {
    extractor: confirmation.value,
    collectableUnits: confirmation.value.collectableUnits,
    oracle: confirmation.oracle,
    polls: confirmation.polls,
    advancedTicks: confirmation.advancedTicks,
  });
}

export async function readOracle(ctx) {
  let oracle;
  if (typeof ctx.oracle === "function") {
    oracle = await ctx.oracle();
  } else {
    if (!ctx.gameUrl) throw new FlowStepError("oracle reader requires ctx.oracle or ctx.gameUrl");
    const url = `${String(ctx.gameUrl).replace(/\/+$/u, "")}/game/debug/oracle?freshAiDebug=1`;
    if (typeof ctx.fetchJson === "function") oracle = await ctx.fetchJson(url);
    else {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new FlowStepError(`oracle HTTP ${response.status}`, { url });
      oracle = await response.json();
    }
  }
  ctx.lastOracle = oracle;
  return oracle;
}

export async function queryOracle(ctx, options = {}) {
  const step = startStep(ctx, "queryOracle", { path: options.path ?? null });
  const oracle = await readOracle(ctx);
  const value = options.path ? valueAtPath(oracle, options.path) : oracle;
  return finishStep(ctx, step, "pass", { oracle, value });
}

export async function assertOracle(ctx, expectation, options = {}) {
  const step = startStep(ctx, "assertOracle", { expectation });
  const oracle = await readOracle(ctx);
  const assertions = assertExpectations(oracle, expectation, options.label ?? "oracle");
  return finishStep(ctx, step, "pass", { oracle, assertions });
}

export async function assertQuery(ctx, line, expectation, options = {}) {
  const step = startStep(ctx, "assertQuery", { line, expectation });
  const result = await query(ctx, line, options);
  const assertions = assertExpectations(result, expectation, options.label ?? `query ${line}`);
  return finishStep(ctx, step, "pass", { query: result, assertions });
}

export async function runMacroText(ctx, body, options = {}) {
  const lines = String(body ?? "").split(/[;\n]/u).map((line) => line.trim()).filter(Boolean);
  const step = startStep(ctx, "runMacroText", { lineCount: lines.length });
  const results = [];
  for (const line of lines) {
    if (line.startsWith("/pause ")) {
      const durationMs = parseDurationMs(line.slice(7));
      await ctx.sleep(durationMs);
      results.push({ pauseMs: durationMs });
    } else if (line.startsWith("/?") || ["/where", "/vitals", "/inv", "/nearby", "/queue", "/budget"].some((prefix) => line.startsWith(prefix))) {
      results.push(await query(ctx, line));
    } else {
      results.push(await issueAuthorityLine(ctx, line, { requireAccepted: options.requireAccepted !== false }));
    }
  }
  const status = results.some((result) => result.status === "fail" || result.status === "failure")
    ? "fail"
    : results.some((result) => result.status === "degraded")
      ? "degraded"
      : results.some((result) => result.status === "warn") ? "warn" : "pass";
  return finishStep(ctx, step, status, { results });
}

export function bestSurveyCell(payload) {
  const values = payload?.concentrationMilli ?? payload?.concentration_milli;
  if (!Array.isArray(values) || values.length === 0) throw new Error("survey payload missing concentrationMilli");
  const cols = Math.max(1, Math.trunc(payload.cols ?? 1));
  const range = Math.trunc(payload.rangeCells ?? payload.range_cells ?? 0);
  const step = Math.max(1, Math.trunc(payload.stepCells ?? payload.step_cells ?? 1));
  const centerX = Math.trunc(payload.centerX ?? payload.center_x ?? 0);
  const centerY = Math.trunc(payload.centerY ?? payload.center_y ?? 0);
  let bestIndex = 0;
  let best = -1;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (value > best) {
      best = value;
      bestIndex = index;
    }
  }
  const row = Math.floor(bestIndex / cols);
  const col = bestIndex % cols;
  return {
    areaId: payload.areaId ?? payload.area_id,
    x: centerX + col * step - range,
    y: centerY + row * step - range,
    concentrationMilli: best,
    concentrationPct: Math.round(best / 10),
    index: bestIndex,
    col,
    row,
  };
}

export function nearestActor(actors, origin, predicate = () => true) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const actor of actors ?? []) {
    if (!predicate(actor)) continue;
    const distance = distanceBetween(origin, actor);
    if (distance < bestDistance) {
      best = { ...actor, distanceCells: distance };
      bestDistance = distance;
    }
  }
  return best;
}

export function headingForDelta(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "back" : "front";
}

export function authorityFacing(heading) {
  const key = String(heading ?? "front").toLowerCase();
  if (key === "right") return "Right";
  if (key === "back") return "Back";
  if (key === "left") return "Left";
  return "Front";
}

export function formatHumanStep(step) {
  const status = step.status.toUpperCase();
  const label = `${status} ${step.primitive}`;
  if (step.receipt) {
    return `${label} #${step.id} · ${step.input?.line ?? ""} · ${step.receipt.accepted ? "accepted" : `rejected ${step.receipt.reasonCode ?? ""}`}`.trim();
  }
  if (step.query) return `${label} #${step.id} · ${step.query.text}`;
  if (step.metrics?.gained !== undefined || step.gained !== undefined) return `${label} #${step.id} · gained ${step.metrics?.gained ?? step.gained}`;
  if (step.text) return `${label} #${step.id} · ${step.text}`;
  if (step.reason) return `${label} #${step.id} · ${step.reason}`;
  return `${label} #${step.id}`;
}

export async function whereData(ctx) {
  const result = await query(ctx, "/where");
  return result.data;
}

export async function positionData(ctx) {
  return whereData(ctx);
}

export async function inventoryTotal(ctx, filter = "") {
  const result = await query(ctx, filter ? `/inv ${filter}` : "/inv");
  return result.data;
}


export async function waitForEnvelope(ctx, predicate, label, timeoutMs = ctx.defaultTimeoutMs, startIndex = 0, options = {}) {
  const boundedTimeoutMs = positiveNumber(timeoutMs, ctx.defaultTimeoutMs);
  const pollMs = positiveNumber(options.pollMs, 25);
  const maxPolls = positiveInteger(options.maxPolls, Math.ceil(boundedTimeoutMs / pollMs) + 1);
  const deadline = Date.now() + boundedTimeoutMs;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const match = ctx.driver.envelopes.slice(startIndex).find(predicate);
    if (match) {
      recordDriverEnvelope(ctx, match);
      return match;
    }
    if (Date.now() >= deadline) break;
    await ctx.sleep(pollMs);
  }
  throw new FlowStepError(`timed out waiting for ${label}`, {
    label,
    maxPolls,
    lastOracle: ctx.lastOracle,
    lastReceipt: ctx.lastReceipt,
    recentEnvelopes: ctx.driver.envelopes.slice(-12),
  });
}

async function resolveTrainer(ctx, options) {
  if (options.trainerId) return { id: requiredText(options.trainerId, "trainerId"), x: null, y: null };
  const trainer = await nearestTrainer(ctx);
  if (!trainer?.id) throw new FlowStepError("no profession trainer is visible", { lastOracle: ctx.lastOracle, lastReceipt: ctx.lastReceipt });
  const approach = options.move !== false && trainer.x !== null && trainer.y !== null
    ? await approachTrainer(ctx, trainer, options)
    : null;
  return { ...trainer, approach };
}

async function approachTrainer(ctx, trainer, options) {
  const interactionRadiusCells = positiveNumber(options.trainerInteractionRadiusCells, 1.75);
  const approachToleranceCells = positiveNumber(options.trainerApproachToleranceCells, 0.5);
  const waypoints = Array.isArray(options.approachWaypoints) ? options.approachWaypoints : [];
  for (const wp of waypoints) {
    await moveTo(ctx, normalizeCell(wp), { ...(options.moveOptions ?? {}), toleranceCells: positiveNumber(wp.toleranceCells, approachToleranceCells), sprint: wp.sprint ?? false, pulseMs: wp.pulseMs ?? 160 });
  }
  const before = await positionData(ctx);
  const target = adjacentInteractionCell(before, trainer);
  const movement = await moveTo(ctx, target, { ...(options.moveOptions ?? {}), toleranceCells: approachToleranceCells });
  let observed = await positionData(ctx);
  let distanceCells = distanceBetween(observed, trainer);
  let sameArea = !trainer.areaId || !observed.areaId || trainer.areaId === observed.areaId;
  let correction = null;
  if (!sameArea || distanceCells > interactionRadiusCells) {
    const fineMoveOptions = options.trainerFineCorrectionMoveOptions ?? {};
    const configuredFineMaxPulses = positiveInteger(
      options.trainerFineCorrectionMaxPulses ?? fineMoveOptions.maxPulses,
      TRAINER_FINE_CORRECTION_MAX_PULSES,
    );
    const fineMaxPulses = Math.min(TRAINER_FINE_CORRECTION_MAX_PULSES, configuredFineMaxPulses);
    const defaultFineToleranceCells = Math.min(0.25, approachToleranceCells * 0.5);
    const fineToleranceCells = Math.min(
      positiveNumber(options.trainerFineCorrectionToleranceCells ?? fineMoveOptions.toleranceCells, defaultFineToleranceCells),
      Math.max(0.001, approachToleranceCells * 0.5),
    );
    correction = await moveTo(ctx, target, {
      ...(options.moveOptions ?? {}),
      ...fineMoveOptions,
      maxPulses: fineMaxPulses,
      toleranceCells: fineToleranceCells,
      sprint: false,
    });
    observed = await positionData(ctx);
    distanceCells = distanceBetween(observed, trainer);
    sameArea = !trainer.areaId || !observed.areaId || trainer.areaId === observed.areaId;
  }
  if (!sameArea || distanceCells > interactionRadiusCells) {
    throw new FlowStepError(`trainer ${trainer.id} remains outside interaction range`, {
      trainer,
      target,
      observed,
      distanceCells,
      interactionRadiusCells,
      movement,
      correction,
    });
  }
  return { target, observed, distanceCells, interactionRadiusCells, movement, correction };
}

async function settleTicks(ctx, ticks) {
  const count = Math.max(0, Math.trunc(Number(ticks) || 0));
  if (count > 0) await ctx.advanceTicks(count);
}

async function pollOracle(ctx, predicate, label, options = {}) {
  const timeoutMs = positiveNumber(options.timeoutMs, 12_000);
  const pollTicks = positiveInteger(options.pollTicks, 2);
  const maxTicks = positiveInteger(options.maxTicks, Math.max(pollTicks, Math.ceil((timeoutMs / 1_000) * ctx.tickRateHz)));
  const maxPolls = positiveInteger(options.maxPolls, Math.ceil(maxTicks / pollTicks) + 1);
  const deadline = Date.now() + timeoutMs;
  let advancedTicks = 0;
  let oracle = null;
  for (let poll = 0; poll < maxPolls && Date.now() <= deadline; poll += 1) {
    oracle = await readOracle(ctx);
    const value = predicate(oracle);
    if (value !== null && value !== undefined && value !== false) {
      return { oracle, value, polls: poll + 1, advancedTicks };
    }
    if (advancedTicks + pollTicks > maxTicks) break;
    await ctx.advanceTicks(pollTicks);
    advancedTicks += pollTicks;
  }
  throw new FlowStepError(`timed out waiting for ${label}`, {
    label,
    maxPolls,
    maxTicks,
    advancedTicks,
    lastOracle: oracle ?? ctx.lastOracle,
    lastReceipt: ctx.lastReceipt,
  });
}

async function waitForCraftSession(ctx, startIndex, predicate, label, options) {
  return waitForEnvelope(
    ctx,
    (candidate) => candidate.type === "event" && candidate.event === "craft_session" && predicate(craftPayload(candidate)),
    label,
    options.craftEventTimeoutMs ?? options.timeoutMs ?? 10_000,
    startIndex,
    { maxPolls: options.eventMaxPolls, pollMs: options.eventPollMs },
  );
}

async function waitForSpliceSession(ctx, startIndex, predicate, label, options) {
  return waitForEnvelope(
    ctx,
    (candidate) => candidate.type === "event" && candidate.event === "splice_session" && predicate(candidate?.data?.payload ?? null),
    label,
    options.spliceEventTimeoutMs ?? options.timeoutMs ?? 10_000,
    startIndex,
    { maxPolls: options.eventMaxPolls, pollMs: options.eventPollMs },
  );
}

function craftPayload(envelope) {
  return envelope?.data?.payload ?? null;
}

function craftSlotAssignment(payload, slotIndex) {
  return payload?.slotScreen?.slots?.find((slot) => Number(slot.slotIndex) === Number(slotIndex))?.assigned ?? null;
}

function craftLine(payload, lineId) {
  return payload?.assembled?.lines?.find((line) => Number(line.lineId) === Number(lineId)) ?? null;
}

function normalizeExperiments(options, assembledPayload) {
  if (Array.isArray(options.experiments)) return options.experiments;
  if (!options.experiment) return [];
  if (typeof options.experiment === "object") return [options.experiment];
  const firstLineId = assembledPayload?.assembled?.lines?.[0]?.lineId;
  if (firstLineId === undefined) throw new FlowStepError("craft requested experimentation but the assembled session has no stat lines", { lastOracle: null });
  return [{ lineId: firstLineId, points: options.experimentPoints ?? 1 }];
}

function validateCraftExperimentInputs(options) {
  if (options.experiments !== undefined && !Array.isArray(options.experiments)) {
    throw new FlowStepError("experiments must be an array", { experiments: options.experiments });
  }
  const experiments = options.experiments ?? (typeof options.experiment === "object" && options.experiment !== null ? [options.experiment] : []);
  for (const experiment of experiments) {
    if (!experiment || typeof experiment !== "object" || Array.isArray(experiment)) {
      throw new FlowStepError("experiment must be an object", { experiment });
    }
    nonNegativeInteger(experiment.lineId ?? experiment.line_id, "experiment.lineId");
    requiredPositiveInteger(experiment.points, "experiment.points");
  }
  if (options.experiment && typeof options.experiment !== "object" && options.experimentPoints !== undefined) {
    requiredPositiveInteger(options.experimentPoints, "experimentPoints");
  }
}

async function resolveCraftSlot(ctx, rawSlot) {
  const spec = rawSlot ?? {};
  const slotIndex = nonNegativeInteger(spec.slotIndex ?? spec.slot_index, "slotIndex");
  const row = await resolveInventoryRow(ctx, spec, `craft slot ${slotIndex}`);
  return { slotIndex, container: row.container, stackId: row.stackId, variantId: row.variantId, itemId: row.itemId, available: row.available };
}

async function resolveInventoryRow(ctx, spec, label) {
  const actorId = controlledActorId(ctx);
  if (spec.container !== undefined && (spec.stackId ?? spec.stack_id) !== undefined && (spec.variantId ?? spec.variant_id) !== undefined) {
    const container = requiredText(spec.container, `${label}.container`);
    if (!actorOwnsContainer(actorId, container)) throw new FlowStepError(`${label} container is not actor-owned`, { actorId, container });
    return {
      container,
      stackId: requiredText(spec.stackId ?? spec.stack_id, `${label}.stackId`),
      variantId: nonNegativeInteger(spec.variantId ?? spec.variant_id, `${label}.variantId`),
      itemId: spec.itemId ?? spec.item_id,
      available: spec.available,
    };
  }
  const oracle = await readOracle(ctx);
  const itemId = finiteInteger(spec.itemId ?? spec.item_id, `${label}.itemId`);
  const minAvailable = positiveInteger(spec.minAvailable, 1);
  const rows = (oracle?.inventory ?? [])
    .filter((row) => actorOwnsContainer(actorId, row.container))
    .filter((row) => Number(row.itemId) === itemId)
    .filter((row) => spec.variantId === undefined && spec.variant_id === undefined || Number(row.variantId) === Number(spec.variantId ?? spec.variant_id))
    .filter((row) => Number(row.available ?? row.quantity ?? 0) >= minAvailable)
    .sort((left, right) => Number(right.available ?? right.quantity ?? 0) - Number(left.available ?? left.quantity ?? 0));
  const row = rows[0];
  if (!row) throw new FlowStepError(`no inventory row satisfies ${label}`, { selector: spec, lastOracle: oracle, lastReceipt: ctx.lastReceipt });
  return row;
}

function actorOwnsContainer(actorId, container) {
  return !actorId || typeof container === "string" && container.startsWith(`${actorId}:`);
}

function oracleInventoryAvailable(ctx, oracle, selector) {
  const actorId = controlledActorId(ctx);
  return (oracle?.inventory ?? [])
    .filter((row) => actorOwnsContainer(actorId, row.container))
    .filter((row) => selector.itemId === undefined || Number(row.itemId) === Number(selector.itemId))
    .filter((row) => selector.variantId === undefined || Number(row.variantId) === Number(selector.variantId))
    .reduce((sum, row) => sum + Number(row.available ?? row.quantity ?? 0), 0);
}

async function confirmOracleReceiptTick(ctx, receipt, options) {
  const receiptTick = Number(receipt?.tick);
  const confirmation = await pollOracle(
    ctx,
    (oracle) => !Number.isFinite(receiptTick) || Number(oracle?.tick) >= receiptTick,
    `oracle tick to acknowledge receipt ${receipt?.commandId ?? "unknown"}`,
    { timeoutMs: options.timeoutMs ?? 10_000, maxTicks: options.maxTicks ?? 60, pollTicks: options.pollTicks ?? 1 },
  );
  return confirmation.oracle;
}

function normalizeFarmCell(parcelId, cell) {
  const spec = cell ?? {};
  return {
    parcelId: requiredText(parcelId, "parcelId"),
    cellX: finiteInteger(spec.x ?? spec.cellX ?? spec.cell_x, "cell.x"),
    cellY: finiteInteger(spec.y ?? spec.cellY ?? spec.cell_y, "cell.y"),
  };
}

function farmLine(verb, tile) {
  return `/${verb} parcel_id=${tile.parcelId} cell_x=${tile.cellX} cell_y=${tile.cellY}`;
}

function farmTile(oracle, tile, predicate) {
  const plot = (oracle?.farmPlots ?? []).find((candidate) => candidate.parcelId === tile.parcelId);
  const row = plot?.tiles?.find((candidate) => Number(candidate.cellX) === tile.cellX && Number(candidate.cellY) === tile.cellY) ?? null;
  return row && predicate(row) ? row : null;
}

function farmPollOptions(options) {
  return {
    timeoutMs: options.timeoutMs ?? 12_000,
    maxTicks: options.maxTicks ?? 180,
    pollTicks: options.pollTicks ?? 2,
    maxPolls: options.maxPolls ?? 90,
  };
}

function flowFailure(ctx, message, step, extra = {}) {
  const details = finishStep(ctx, step, "fail", {
    ...extra,
    lastOracle: extra.lastOracle ?? ctx.lastOracle,
    lastReceipt: extra.lastReceipt ?? ctx.lastReceipt,
  });
  return new FlowStepError(message, details);
}

function assertExpectations(source, expectation, label) {
  const rows = Array.isArray(expectation)
    ? expectation
    : expectation && Object.hasOwn(expectation, "path")
      ? [expectation]
      : Object.entries(expectation ?? {}).map(([path, value]) => ({ path, value }));
  if (rows.length === 0) throw new FlowStepError(`${label} assertion requires at least one expectation`);
  const results = [];
  for (const row of rows) {
    const actual = valueAtPath(source, row.path ?? "");
    const expected = row.value;
    const op = row.op ?? "eq";
    let ok;
    if (op === "eq") ok = deepEqual(actual, expected);
    else if (op === "ne") ok = !deepEqual(actual, expected);
    else if (op === "gt") ok = Number(actual) > Number(expected);
    else if (op === "gte") ok = Number(actual) >= Number(expected);
    else if (op === "lt") ok = Number(actual) < Number(expected);
    else if (op === "lte") ok = Number(actual) <= Number(expected);
    else if (op === "includes") ok = typeof actual?.includes === "function" && actual.includes(expected);
    else if (op === "matches") ok = new RegExp(String(expected), row.flags ?? "u").test(String(actual ?? ""));
    else if (op === "exists") ok = expected === false ? actual === undefined || actual === null : actual !== undefined && actual !== null;
    else throw new FlowStepError(`${label} assertion uses unknown operator ${op}`, { expectation: row });
    if (!ok) throw new FlowStepError(`${label} assertion failed at ${row.path ?? "<root>"}: ${op}`, { actual, expected, expectation: row });
    results.push({ path: row.path ?? "", op, expected, actual });
  }
  return results;
}

function valueAtPath(source, path) {
  const keys = String(path ?? "")
    .replace(/\[([^\]]+)\]/gu, ".$1")
    .split(".")
    .filter(Boolean);
  let value = source;
  for (const key of keys) value = value?.[key];
  return value;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function actorLabel(ctx) {
  return ctx.actor && typeof ctx.actor === "object" ? ctx.actor.alias ?? ctx.actor.id ?? ctx.actorId ?? null : ctx.actor ?? ctx.actorId ?? null;
}
function controlledActorId(ctx) {
  const driverActorId = ctx.driver?.options?.actorId;
  if (driverActorId) return String(driverActorId);
  if (ctx.actor && typeof ctx.actor === "object") return ctx.actor.id ?? ctx.actor.actorId ?? null;
  if (ctx.actorId && ctx.actorId !== ctx.actor) return String(ctx.actorId);
  return null;
}


function actorIdFrom(actor) {
  return actor && typeof actor === "object" ? actor.id ?? actor.actorId : typeof actor === "string" ? actor : undefined;
}

function sameActor(actor, alias) {
  if (actor === alias) return true;
  if (!actor || typeof actor !== "object") return false;
  return actor.alias === alias || actor.id === alias || actor.actorId === alias;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text || /\s/u.test(text)) throw new FlowStepError(`${label} must be a non-empty token`, { value });
  return text;
}

function finiteInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new FlowStepError(`${label} must be an integer`, { value });
  return value;
}

function nonNegativeInteger(value, label) {
  const number = finiteInteger(value, label);
  if (number < 0) throw new FlowStepError(`${label} must be non-negative`, { value });
  return number;
}

function requiredPositiveInteger(value, label) {
  const number = finiteInteger(value, label);
  if (number <= 0) throw new FlowStepError(`${label} must be a positive integer`, { value });
  return number;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : Math.max(1, Math.trunc(Number(fallback) || 1));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Number(fallback);
}

function sendDriverFrame(ctx, frame) {
  if (!ctx?.driver || typeof ctx.driver.send !== "function" || !Array.isArray(ctx.driver.envelopes)) {
    throw new FlowStepError("flow context requires a driver with send(frame) and envelopes[]", { actor: ctx?.actor ?? null });
  }
  recordExpandedFrame(ctx, { actor: actorLabel(ctx), send: frame });
  ctx.driver.send(frame);
}

function recordDriverEnvelope(ctx, envelope) {
  if (!envelope || typeof envelope !== "object") return;
  if (ctx._recordedEnvelopes?.has(envelope)) return;
  ctx._recordedEnvelopes?.add(envelope);
  if (envelope.type === "receipt") ctx.lastReceipt = envelope;
  recordExpandedFrame(ctx, { actor: actorLabel(ctx), recv: envelope });
}

function recordExpandedFrame(ctx, frame) {
  ctx.frames.push(frame);
  ctx.recordFrame(frame);
}
function startStep(ctx, primitive, input = {}) {
  return {
    schema: "successor.play-flow.step.v1",
    id: ++ctx.stepSeq,
    flow: ctx.flowName,
    primitive,
    status: "running",
    input,
    startedAt: new Date().toISOString(),
    startedMs: performance.now(),
  };
}

function finishStep(ctx, step, status, extra = {}) {
  const finished = {
    ...step,
    ...extra,
    status,
    completedAt: new Date().toISOString(),
    durationMs: round(performance.now() - step.startedMs),
  };
  delete finished.startedMs;
  ctx.steps.push(finished);
  ctx.onStep(finished);
  return finished;
}

async function stopMoveIntent(ctx, heading) {
  return issueAuthorityLine(ctx, `/set-move-intent 0 0 ${authorityFacing(heading)}`, {
    primitive: "moveTo.stop",
    commandKind: "SetMoveIntent",
    receiptTimeoutMs: 8_000,
  });
}

function surveyPayload(envelope) {
  return envelope?.data?.payload ?? null;
}

function surveyResultMatchesFamily(payload, requestedFamily) {
  if (!payload || typeof requestedFamily !== "string") return false;
  const requested = requestedFamily.trim().toLowerCase();
  if (!requested) return false;
  const resultFamily = typeof payload.family === "string" ? payload.family.trim().toLowerCase() : "";
  if (resultFamily === requested) return true;
  const resourceId = typeof payload.spawnId === "string"
    ? payload.spawnId.trim().toLowerCase().split(":").at(-1)
    : "";
  return resourceId === requested;
}

async function stopSamplingBestEffort(ctx, family, options) {
  try {
    return await issueAuthorityLine(ctx, `/sample ${family} true`, {
      primitive: "sample.stopCleanup",
      commandKind: "SampleResource",
      requireAccepted: false,
      receiptTimeoutMs: options.receiptTimeoutMs ?? 10_000,
    });
  } catch {
    return null;
  }
}

async function issueEconomyAuthorityLine(ctx, line, options) {
  const attempts = [];
  const maxCooldownRetries = nonNegativeInteger(options.maxCooldownRetries ?? Math.ceil((options.cooldownTimeoutMs ?? 12_000) * ctx.tickRateHz / 1_000), "maxCooldownRetries");
  for (let retry = 0; retry <= maxCooldownRetries; retry += 1) {
    const result = await issueAuthorityLine(ctx, line, { ...options, requireAccepted: false });
    attempts.push(result);
    if (result.receipt?.accepted === true) return { ...result, cooldownAttempts: attempts };
    const reasonCode = result.receipt?.reasonCode;
    if (reasonCode !== "economy_cooldown" && reasonCode !== "ingress_budget_exhausted") {
      if (options.requireAccepted === false) return { ...result, cooldownAttempts: attempts };
      throw new FlowStepError(`receipt rejected for ${line}: ${reasonCode ?? "rejected"}`, { result, cooldownAttempts: attempts });
    }
    if (retry === maxCooldownRetries) break;
    const oracle = await readOracle(ctx);
    const actor = oracle?.actors?.[controlledActorId(ctx)];
    const readyTick = Number(actor?.nextEconomyActionTick);
    const receiptTick = Number(result.receipt?.tick);
    if (reasonCode === "economy_cooldown" && Number.isInteger(readyTick) && Number.isInteger(receiptTick) && readyTick > receiptTick) {
      await ctx.advanceTicks(readyTick - receiptTick);
    } else {
      const ingressRefillTicks = positiveInteger(options.ingressRefillTicks, Math.ceil(ctx.tickRateHz / 5));
      await ctx.advanceTicks(ingressRefillTicks * 2 ** Math.min(retry, 4));
    }
  }
  const last = attempts.at(-1);
  throw new FlowStepError(`economy cooldown did not clear for ${line}`, { result: last, cooldownAttempts: attempts });
}

function chooseInventoryRow(rows, options = {}) {
  const candidates = rows
    .filter((row) => row && row.container !== "district-exchange" && Number(row.available) > 0)
    .filter((row) => options.itemId === undefined || Number(row.itemId) === Number(options.itemId))
    .filter((row) => options.variantId === undefined || Number(row.variantId) === Number(options.variantId));
  candidates.sort((left, right) => Number(right.available ?? 0) - Number(left.available ?? 0));
  return candidates[0] ?? null;
}

async function resolveInventoryStackId(ctx, options = {}) {
  const inv = await query(ctx, `/inv ${options.filter ?? ""}`.trim());
  const row = chooseInventoryRow(inv.data?.rows ?? [], options);
  if (!row?.stackId) throw new FlowStepError("bank store requires an available inventory stack", { filter: options.filter ?? null });
  return requiredText(row.stackId, "sourceStackId");
}

async function moveToNearestTerminal(ctx, kind, options = {}) {
  const nearby = await query(ctx, "/nearby prop");
  const props = nearby.data?.props ?? [];
  const prop = props.find((candidate) => candidate.kind === kind || (kind === "bank_terminal" && /bank/iu.test(candidate.id ?? candidate.label ?? "")) || (kind === "clone_terminal" && /clone/iu.test(candidate.id ?? candidate.label ?? "")));
  if (!prop) throw new FlowStepError(`no ${kind} nearby prop`, { props });
  const origin = nearby.data?.origin ?? await positionData(ctx);
  return moveTo(ctx, adjacentInteractionCell(origin, prop), {
    toleranceCells: options.terminalApproachToleranceCells ?? 0.2,
    ...(options.moveOptions ?? {}),
  });
}

async function resolveAndMoveToCorpse(ctx, corpseId, options = {}) {
  const cell = options.corpseCell ?? options.targetCell;
  if (!cell || Number.isNaN(Number(cell.x)) || Number.isNaN(Number(cell.y))) {
    throw new FlowStepError(`corpse ${corpseId} movement requires corpseCell`, { corpseId });
  }
  const origin = await positionData(ctx);
  return moveTo(ctx, adjacentInteractionCell(origin, { ...cell, areaId: cell.areaId ?? origin.areaId }), {
    toleranceCells: options.corpseApproachToleranceCells ?? 0.2,
    ...(options.moveOptions ?? {}),
  });
}

function expectedInventoryRows(oracle, expected) {
  return expected.every((row) => {
    const matches = (oracle?.inventory ?? [])
      .filter((candidate) => row.container === undefined || candidate.container === row.container)
      .filter((candidate) => Number(candidate.itemId) === Number(row.itemId))
      .filter((candidate) => Number(candidate.variantId ?? 0) === Number(row.variantId ?? 0));
    const available = matches.reduce((sum, candidate) => sum + Number(candidate.available ?? candidate.quantity ?? 0), 0);
    return available === Number(row.quantity);
  });
}

async function nearestExchangeCell(ctx) {
  const nearby = await query(ctx, "/nearby prop");
  const props = nearby.data?.props ?? [];
  const exchange = props.find((prop) => exchangeLike(prop));
  if (!exchange) return null;
  const where = await positionData(ctx);
  return {
    prop: exchange,
    interactionCell: adjacentInteractionCell(where, exchange),
  };
}

async function nearestTrainer(ctx) {
  const nearby = await query(ctx, "/nearby all");
  return nearestActor(nearby.data?.actors ?? [], nearby.data?.origin ?? { x: 0, y: 0 }, (actor) => actor.role === "profession_trainer" || /trainer/iu.test(actor.label ?? actor.id ?? ""));
}

async function waitForActorOwnedHarvestableCorpse(ctx, targetId, options = {}) {
  const actorId = controlledActorId(ctx);
  if (!actorId) throw new FlowStepError("harvest corpse requires controlled actor identity", { targetId });
  return pollOracle(
    ctx,
    (oracle) => actorOwnedHarvestableCorpse(oracle, targetId, actorId),
    `actor-owned harvestable corpse ${targetId}`,
    {
      timeoutMs: options.harvestReadyTimeoutMs ?? options.timeoutMs ?? 12_000,
      maxTicks: options.harvestReadyMaxTicks ?? options.maxTicks ?? 180,
      pollTicks: options.harvestReadyPollTicks ?? options.pollTicks ?? 2,
    },
  );
}

function actorOwnedHarvestableCorpse(oracle, targetId, actorId) {
  const target = oracle?.actors?.[targetId];
  if (!target || target.id !== targetId) return null;
  if (target.lifeState !== "downed" || target.lootable !== true) return null;
  if (!Number.isFinite(Number(target.bodyVanishTick)) || Number(target.bodyVanishTick) <= 0) return null;
  if (target.lootRightsActorId !== actorId) return null;
  return target;
}

function nearestLootableCorpse(oracle, where, options = {}) {
  const actors = Object.values(oracle?.actors ?? {});
  const inventory = oracle?.inventory ?? oracle?.snapshot?.inventory ?? [];
  const corpses = actors.filter((actor) => actor && actor.lifeState !== "alive");
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const actor of corpses) {
    const rows = inventory.filter((row) => row.container === `corpse:${actor.id}` && Number(row.available) > 0);
    if (rows.length === 0) continue;
    const distance = distanceBetween(where, actor);
    if (options.maxDistanceCells !== undefined && distance > options.maxDistanceCells) continue;
    if (distance < bestDistance) {
      rows.sort((left, right) => Number(right.available ?? 0) - Number(left.available ?? 0));
      best = { actor, row: rows[0] };
      bestDistance = distance;
    }
  }
  return best;
}

function adjacentInteractionCell(origin, target) {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1.1) return { x: origin.x, y: origin.y, areaId: origin.areaId };
  const scale = Math.max(0, length - 1.1) / length;
  return {
    areaId: target.areaId ?? origin.areaId,
    x: target.x - dx * (1 - scale),
    y: target.y - dy * (1 - scale),
  };
}

function cardinalAttackApproachCell(attacker, target, rangeCells) {
  const verticalDirection = attacker.y >= target.y ? 1 : -1;
  return {
    areaId: target.areaId ?? attacker.areaId,
    x: target.x,
    y: target.y + verticalDirection * rangeCells,
  };
}

function exchangeLike(prop) {
  const text = `${prop.id ?? ""} ${prop.kind ?? ""} ${prop.label ?? ""} ${prop.entity ?? ""}`.toLowerCase();
  return text.includes("district-exchange") || text.includes("district_exchange") || text.includes("exchange");
}

function normalizeSlash(line) {
  const value = String(line ?? "").trim();
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeCell(cell) {
  return {
    areaId: cell.areaId,
    x: Number(cell.x),
    y: Number(cell.y),
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function distanceBetween(a, b) {
  return Math.hypot(Number(a.x ?? 0) - Number(b.x ?? 0), Number(a.y ?? 0) - Number(b.y ?? 0));
}

function parseDurationMs(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value.endsWith("ms")) return Number(value.slice(0, -2));
  if (value.endsWith("s")) return Number(value.slice(0, -1)) * 1000;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
