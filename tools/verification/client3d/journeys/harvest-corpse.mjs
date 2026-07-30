// Journey: harvest Gaia creature corpse (authority receipt + inventory yield + surface feedback).
// Overlays a scratch Gaia population spawnZone (Bellback adult), fells the
// resulting creature using lawful combat commands (/attack basic_shot),
// approaches the resulting corpse, cycles KeyV via selectExactInteraction to
// explicitly select the corpse interaction option, invokes KeyF, and proves:
//  - accepted HarvestCorpse authority receipt;
//  - target remains the intended same-area corpse;
//  - authoritative inventory/yield increases;
//  - Surface contract: exactly one visible HARVESTED feedback record/floating text;
//  - rejected/duplicate receipts are not fabricated;
//  - screenshot captured while feedback is visible;
//  - clean exit.
import { ITEM } from "./_helpers.mjs";

const PROBE_ID = "h3d-harvest-probe";
const POP_PREFIX = "h3d-harvest-bellback";

function isHarvestCreature(id) {
  return typeof id === "string" && id.startsWith(POP_PREFIX);
}

async function selectExactInteraction(ctx, s, kind, targetId, { label = "interaction" } = {}) {
  const match = (option) => option?.kind === kind && option?.targetId === targetId;
  await s.waitProbe(
    (probe) => (probe.interactions ?? []).some(match),
    { label: `${label} present in interaction roster`, timeoutMs: 10000 },
  );
  let last = await s.probe();
  const roster = last.interactions ?? [];
  const maxCycles = Math.min(12, Math.max(4, roster.length * 2 + 2));
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    last = await s.probe();
    if (match(last.selectedInteraction)) {
      s.assert(
        match(last.selectedInteraction),
        `${label} selectedInteraction drifted after select: ${JSON.stringify(last.selectedInteraction)} roster=${JSON.stringify(last.interactions)}`,
      );
      return last;
    }
    if (!(last.interactions ?? []).some(match)) {
      await s.waitProbe(
        (probe) => (probe.interactions ?? []).some(match),
        { label: `${label} restored in interaction roster`, timeoutMs: 4000 },
      ).catch(() => null);
      continue;
    }
    await s.press("KeyV");
    await ctx.delay(120);
  }
  last = await s.probe();
  s.assert(
    match(last.selectedInteraction),
    `${label} never became selectedInteraction after ${maxCycles} KeyV cycles: selected=${JSON.stringify(last.selectedInteraction)} roster=${JSON.stringify(last.interactions)}`,
  );
  return last;
}

export default {
  id: "harvest-corpse",
  title: "Harvest creature corpse (authority receipt + inventory yield + surface feedback)",
  headed: true,
  timeoutMs: 150000,
  characters: [
    {
      role: "primary",
      id: PROBE_ID,
      name: "HarvestProbe",
      x: 512,
      y: 512,
      initialProfessionId: "brawler",
      skillBoxIds: [
        "brawler-melee-i",
        "brawler-melee-ii",
        "brawler-melee-iii",
        "brawler-melee-iv",
        "brawler-attack-speed-i",
        "brawler-attack-speed-ii",
        "brawler-attack-speed-iii",
        "brawler-attack-speed-iv",
      ],
      verificationLoadout: {
        mode: "client3d-pre-entry.v1",
        items: [
          { itemId: ITEM.vibrosword, variantId: 0, quantity: 1, equipped: true },
        ],
      },
    },
  ],
  serverSliceOverlay: {
    spawnZones: [
      {
        id: "h3d-harvest-bellback-zone",
        actorIdPrefix: "h3d-harvest-bellback-01",
        templateId: "open-desert-bellback",
        areaId: "open-desert-overworld",
        candidateCells: [
          { x: 514, y: 512 },
          { x: 515, y: 512 },
          { x: 514, y: 513 },
          { x: 515, y: 513 },
        ],
        initialCount: 1,
        maxAlive: 1,
        spawnEverySeconds: 900,
        batchMin: 1,
        batchMax: 1,
        seed: 5_145_120,
        activation: {
          radiusCells: 48,
          leashRadiusCells: 48,
          deactivationRadiusCells: 72,
          releaseTicks: 240,
          lingerTicks: 300,
          checkEveryTicks: 10,
        },
      },
    ],
  },
  async arm(ctx) {
    await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.vibrosword, variant_id: 0, quantity: 1, equip: true } });
    await ctx.debugCommand({
      DebugGrantSkillBoxes: {
        skill_box_ids: [
          "brawler-melee-i",
          "brawler-melee-ii",
          "brawler-melee-iii",
          "brawler-melee-iv",
          "brawler-attack-speed-i",
          "brawler-attack-speed-ii",
          "brawler-attack-speed-iii",
          "brawler-attack-speed-iv",
        ],
      },
    });
    ctx.note("armed vibrosword + brawler tree; overlaid scratch population zone for Gaia Bellback");
  },
  async run(ctx) {
    const s = ctx.primary;
    const { approachHostile, fightToKill, approachCorpse } = await import("./_helpers.mjs");

    // 1. Wait for connection and authority player ready
    await s.waitProbe(
      (p) => p?.serverStatus === "connected" && !!p.authorityPlayer,
      { label: "session connected", timeoutMs: 45000 },
    );

    // 2. Wait for Gaia creature actor to appear on authority oracle
    await s.waitProbeCall(
      () => s.oracle(),
      (o) => {
        const player = o?.actors?.[s.actorId];
        if (!player) return false;
        return Object.entries(o.actors ?? {}).some(
          ([id, a]) => isHarvestCreature(id) && a?.lifeState === "alive" && a?.areaId === player.areaId,
        );
      },
      { label: "Gaia creature present on authority map", timeoutMs: 30000 },
    );

    const oracleBeforeTarget = await s.oracle();
    const creatureId = Object.keys(oracleBeforeTarget.actors ?? {}).find(
      (id) => isHarvestCreature(id) && oracleBeforeTarget.actors[id]?.lifeState === "alive",
    );
    s.assert(creatureId, "failed to resolve Gaia creature actor ID from oracle");
    ctx.note(`found real Gaia creature: ${creatureId}`);

    // 3. Target creature and approach
    await s.slash(`/target ${creatureId}`);
    await s.waitProbe(
      (p) => String(p.selectedActorId) === String(creatureId),
      { label: "creature targeted", timeoutMs: 5000 },
    ).catch(() => {});

    await approachHostile(ctx, s, 1.4, { timeoutMs: 15000 });

    // 4. Fight creature to kill/down using lawful combat commands
    const killResult = await fightToKill(ctx, s, creatureId, { meleeRange: 1.8, timeoutMs: 40000 });
    s.assert(killResult.killed, `failed to fell Gaia creature ${creatureId} with lawful combat commands`);

    const oraclePostKill = await s.oracle();
    const downedCorpse = oraclePostKill?.actors?.[creatureId];
    s.assert(
      downedCorpse && downedCorpse.lifeState === "downed",
      `creature ${creatureId} must be in downed lifeState: got ${downedCorpse?.lifeState}`,
    );
    ctx.note(`felled Gaia creature ${creatureId}; lifeState=downed`);

    // 5. Approach corpse and select exact corpse interaction option via KeyV
    await approachCorpse(ctx, s, creatureId, { withinCells: 1.2, timeoutMs: 12000 });

    const selectedProbe = await selectExactInteraction(ctx, s, "corpse", creatureId, {
      label: "Gaia creature corpse interaction",
    });

    s.assert(
      selectedProbe.selectedInteraction?.kind === "corpse" && selectedProbe.selectedInteraction?.targetId === creatureId,
      `selectedInteraction is not corpse ${creatureId}: got ${JSON.stringify(selectedProbe.selectedInteraction ?? null)}`,
    );

    // Record baseline counts & oracle before harvest command
    const probeBefore = selectedProbe;
    const oracleBefore = await s.oracle();

    const baselineAccepted = probeBefore.acceptedCommands ?? 0;
    const baselineRejected = probeBefore.rejectedCommands ?? 0;
    const maxCommandId = (probeBefore.authorityReceiptTail ?? [])
      .reduce((max, entry) => Math.max(max, Number(entry.commandId) || 0), 0);

    const inventoryBefore = oracleBefore?.inventory ?? [];
    const resourcesBefore = inventoryBefore
      .filter((r) => String(r.container).startsWith(s.actorId))
      .reduce((sum, r) => sum + Math.max(0, Number(r.available ?? r.quantity ?? 0)), 0);

    // 6. Invoke normal F / corpse interaction (F key press)
    await s.press("KeyF");

    // 7. Prove accepted HarvestCorpse authority receipt AND observe live HARVESTED feedback label immediately
    const probeAfter = await s.waitProbe(
      (p) => (p.authorityReceiptTail ?? []).some(
        (entry) => entry.kind === "HarvestCorpse"
          && Number(entry.commandId) > maxCommandId
          && entry.accepted === true,
      ) && (p.floatingTexts ?? []).some((f) => f.label === "HARVESTED"),
      { label: "accepted HarvestCorpse receipt + HARVESTED status label visible", timeoutMs: 15000 },
    );

    const harvestReceipts = (probeAfter.authorityReceiptTail ?? [])
      .filter((entry) => entry.kind === "HarvestCorpse" && Number(entry.commandId) > maxCommandId);
    const acceptedReceipt = harvestReceipts.find((entry) => entry.accepted === true);

    s.assert(acceptedReceipt, "missing accepted HarvestCorpse authority receipt");

    // Surface contract: MUST observe exactly one visible HARVESTED feedback record
    const harvestedRecords = (probeAfter.floatingTexts ?? []).filter((f) => f.label === "HARVESTED");
    s.assert(
      harvestedRecords.length === 1,
      `expected exactly 1 visible HARVESTED status record, got ${harvestedRecords.length} (floatingTexts=${JSON.stringify(probeAfter.floatingTexts)})`,
    );
    ctx.note(`accepted HarvestCorpse receipt commandId=${acceptedReceipt.commandId} + HARVESTED status count=${harvestedRecords.length}`);

    // 8. Capture screenshot IMMEDIATELY while asserted HARVESTED record is live
    await ctx.moneyShot("00-corpse-harvested");

    // 9. Prove target remains the intended same-area corpse
    const oracleAfter = await s.oracle();
    const targetCorpse = oracleAfter?.actors?.[creatureId];
    s.assert(targetCorpse, `target corpse ${creatureId} missing from authority oracle`);
    s.assert(
      targetCorpse.areaId === "open-desert-overworld",
      `target corpse areaId drifted: expected open-desert-overworld, got ${targetCorpse.areaId}`,
    );
    s.assert(
      targetCorpse.lifeState === "downed",
      `target corpse lifeState drifted: expected downed, got ${targetCorpse.lifeState}`,
    );
    ctx.note(`target corpse ${creatureId} verified in area ${targetCorpse.areaId} with lifeState=downed`);

    // 10. Prove authoritative inventory/yield increases
    const inventoryAfter = oracleAfter?.inventory ?? [];
    const resourcesAfter = inventoryAfter
      .filter((r) => String(r.container).startsWith(s.actorId))
      .reduce((sum, r) => sum + Math.max(0, Number(r.available ?? r.quantity ?? 0)), 0);

    s.assert(
      resourcesAfter > resourcesBefore || inventoryAfter.length > inventoryBefore.length,
      `authoritative inventory yield did not increase: resources before=${resourcesBefore}, after=${resourcesAfter}; rows before=${inventoryBefore.length}, after=${inventoryAfter.length}`,
    );
    ctx.note(`authoritative inventory yield increased: resource count ${resourcesBefore} -> ${resourcesAfter}, rows ${inventoryBefore.length} -> ${inventoryAfter.length}`);

    // 11. Prove rejected/duplicate receipts are not fabricated for the lawful action
    s.assert(
      probeAfter.rejectedCommands === baselineRejected,
      `lawful HarvestCorpse incremented rejectedCommands: ${baselineRejected} -> ${probeAfter.rejectedCommands}`,
    );
    s.assert(
      probeAfter.acceptedCommands === baselineAccepted + 1,
      `acceptedCommands expected ${baselineAccepted + 1}, got ${probeAfter.acceptedCommands}`,
    );
    s.assert(
      harvestReceipts.length === 1 && harvestReceipts[0].accepted === true,
      `expected exactly 1 accepted HarvestCorpse receipt, got: ${JSON.stringify(harvestReceipts)}`,
    );
    ctx.note("receipt integrity proven: acceptedCommands delta=+1, rejectedCommands delta=0, no duplicate receipts");

    ctx.note("harvest-corpse journey completed successfully cleanly");
  },
};
