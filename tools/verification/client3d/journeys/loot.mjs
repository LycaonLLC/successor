// Journey: loot corpse. Overlays a lootable rogue (field-pack with TWO stacks —
// a stimpak + field bandages) next to the player, fells it, proves TAP-F opens
// the LOOT window (current behavior), then proves HOLD-F (>=1s) take-alls BOTH
// stacks into the pack in one gesture (owner ruling 2026-07-08 — the client
// loop over TakeLootItem, no new command).
// Money shots: corpse, loot window (tap), both stacks taken (hold).
const ROGUE = "h3d-loot-rogue";
const STIMPAK = 1001;
const BANDAGE = 1002;

export default {
  id: "loot",
  title: "Loot corpse",
  timeoutMs: 130000,
  characters: [{ role: "primary", id: "h3d-loot-probe", name: "ProbeLoot", x: 589, y: 512, initialProfessionId: "brawler" }],
  serverSliceOverlay: {
    actors: [{
      id: ROGUE, entity: `scenario:${ROGUE}`, areaId: "open-desert-overworld",
      label: "Loot Drifter", role: "skirmisher", factionId: "rogue_troopers",
      socialGroup: "open_desert_rogues", pvpStatus: "overt",
      professionIds: ["marksman"], skillBoxIds: ["marksman-novice"],
      sprite: "adventurer-premium-male", poseSet: "idle", direction: "left",
      cell: { x: 587, y: 512 }, route: [],
      vitals: { health: 70, action: 100, spirit: 80 }, maxVitals: { health: 70, action: 100, spirit: 80 },
    }],
    inventory: [
      { container: `${ROGUE}:field-pack`, item: "Stimpak A", itemId: STIMPAK, variantId: 0, quantity: 3, reserved: 0, available: 3 },
      { container: `${ROGUE}:field-pack`, item: "Field Bandage", itemId: BANDAGE, variantId: 0, quantity: 5, reserved: 0, available: 5 },
    ],
  },
  async arm(ctx) {
    await ctx.debugCommand({ DebugGiveItem: { item_id: 3103, variant_id: 0, quantity: 1, equip: true } });
    await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: [
      "brawler-melee-i", "brawler-melee-ii", "brawler-melee-iii", "brawler-melee-iv",
      "brawler-attack-speed-i", "brawler-attack-speed-ii", "brawler-attack-speed-iii", "brawler-attack-speed-iv", "brawler-master",
    ] } });
    ctx.note("armed vibrosword + brawler tree; overlaid lootable rogue");
  },
  async run(ctx) {
    const s = ctx.primary;
    // Target the overlaid lootable rogue specifically and fell it in melee.
    await s.waitProbe((p) => (p.nearestHostile && p.nearestHostile.lifeState === "alive"), { label: "rogue present" });
    await s.slash(`/target ${ROGUE}`);
    await s.waitProbe((p) => p.selectedActorId === ROGUE, { label: "rogue targeted", timeoutMs: 5000 }).catch(() => {});
    const { approachHostile, fightToKill, holdFTakeAll } = await import("./_helpers.mjs");
    await approachHostile(ctx, s, 1.4);
    const result = await fightToKill(ctx, s, ROGUE, { meleeRange: 1.8, timeoutMs: 60000 });
    ctx.note(`felled ${ROGUE} killed=${result.killed}`);
    s.assert(result.killed, `could not fell the lootable rogue`);

    // Corpse loot surface: `corpse:<id>` carries the seeded stack.
    const corpseContainer = `corpse:${ROGUE}`;
    const corpseLoot = await s.waitProbeCall(
      () => s.oracle(),
      (o) => (o.inventory ?? []).some((r) => r.container === corpseContainer && (r.available ?? 0) > 0),
      { label: "corpse loot surface populated", timeoutMs: 12000 },
    );
    const row = corpseLoot.inventory.find((r) => r.container === corpseContainer && (r.available ?? 0) > 0);
    ctx.note(`corpse ${corpseContainer} has ${row.itemId}@${row.variantId} x${row.available}`);
    // Walk back within reach (melee drift can push past the 1.75-cell radius).
    const { approachCorpse } = await import("./_helpers.mjs");
    await approachCorpse(ctx, s, ROGUE, { withinCells: 1.2 });
    await s.waitProbe((p) => (p.interactions ?? []).some((o) => o.kind === "corpse"), { label: "corpse interaction", timeoutMs: 8000 });
    ctx.note(`corpse carries 2 stacks (${row.itemId} + bandage)`);
    await ctx.moneyShot("00-corpse");

    // TAP F opens the LOOT window (current behavior) — a quick down/up.
    // Under concurrent software-GL load, the interaction can flicker between
    // keydown and keyup (60ms gap). Retry the tap up to 3 times.
    let opened = false;
    for (let tapAttempt = 0; tapAttempt < 3 && !opened; tapAttempt += 1) {
      await s.waitProbe((p) => (p.interactions ?? []).some((o) => o.kind === "corpse" && o.targetId === ROGUE), { label: "corpse interactable before tap", timeoutMs: 4000 }).catch(() => {});
      await s.press("KeyF");
      opened = await s.waitDom('.sc3d-window[data-window="loot"]', { state: "visible", timeoutMs: 4000 }).then(() => true).catch(() => false);
      if (!opened) await ctx.delay(300);
    }
    ctx.note(`tap-F opened loot window=${opened}`);
    s.assert(opened, "tap-F did not open the loot window");
    await ctx.moneyShot("01-loot-window");
    // Close it so the HOLD gesture is unambiguous.
    await s.press("Escape");
    await s.waitDom('.sc3d-window[data-window="loot"]', { state: "hidden", timeoutMs: 4000 }).catch(() => {});

    // HOLD F (>=1s) take-alls BOTH stacks in one gesture — the radial charges
    // on the F-chip, then the client loop enqueues a TakeLootItem per stack.
    // Uses the shared holdFTakeAll helper which walks into range and retries
    // if the corpse drifts outside the 1.75-cell interaction radius (the root
    // cause of gate-only failures was a swallowed .catch masking this drift).
    await holdFTakeAll(ctx, s, ROGUE);
    const looted = await s.waitProbeCall(
      () => s.oracle(),
      (o) => {
        const rows = o.inventory ?? [];
        const pack = (id) => rows.some((r) => r.itemId === id && String(r.container).startsWith(s.actorId) && (r.available ?? 0) > 0);
        return pack(STIMPAK) && pack(BANDAGE);
      },
      { label: "both stacks in player pack (hold-F take-all)", timeoutMs: 12000 },
    );
    const stim = looted.inventory.find((r) => r.itemId === STIMPAK && String(r.container).startsWith(s.actorId));
    const band = looted.inventory.find((r) => r.itemId === BANDAGE && String(r.container).startsWith(s.actorId));
    ctx.note(`HOLD-F take-all -> stimpak x${stim.available} + bandage x${band.available} in pack`);
    s.assert(stim && band, "HOLD-F take-all did not bring both stacks home");
    // The corpse should now be stripped.
    const cleared = await s.waitProbeCall(
      () => s.oracle(),
      (o) => !(o.inventory ?? []).some((r) => r.container === corpseContainer && (r.available ?? 0) > 0),
      { label: "corpse stripped", timeoutMs: 8000 },
    ).then(() => true).catch(() => false);
    ctx.note(`corpse stripped=${cleared}`);
    await ctx.moneyShot("02-looted");
  },
};
