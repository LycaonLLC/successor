import { describe, expect, it } from "vitest";
import {
  adjustPendingSpend,
  batchSuccessMilli,
  clampDraftUses,
  composeBrowserGroups,
  composeDraftRows,
  composeFinish,
  composeRecipeLedger,
  composeSlotScreen,
  composeStatHover,
  formatMilliPercent,
  nextSlotIndex,
  railPct,
  statMeterPct,
  totalPending,
  TUNE_POOL_MAX,
  type PendingSpend,
} from "./composers";
import {
  fixtureAssembled,
  fixtureBatteryDetail,
  fixtureDrafts,
  fixtureRecipes,
  fixtureSamplerDetail,
  fixtureSlotScreen,
  fixtureSlotScreenLoaded,
  fixtureStats,
} from "./fixtures";

describe("formatting", () => {
  it("renders milli percentages in the survey voice", () => {
    expect(formatMilliPercent(742)).toBe("74.2%");
    expect(formatMilliPercent(0)).toBe("0.0%");
    expect(formatMilliPercent(1500)).toBe("100.0%");
  });

  it("clamps stat meters to a visible 1..100", () => {
    expect(statMeterPct(0)).toBe(1);
    expect(statMeterPct(500)).toBe(50);
    expect(statMeterPct(9999)).toBe(100);
  });
});

describe("browser groups", () => {
  it("renders the authority stream order verbatim, grouped by category + skill box", () => {
    const groups = composeBrowserGroups(fixtureRecipes(), "all", "", true);
    // NEVER re-sorted: rows flatten back to exactly the stream order.
    expect(groups.flatMap((group) => group.rows.map((row) => row.recipeId))).toEqual([
      "extractor_battery",
      "field_multitool",
      "metal_extractor",
      "scattergun_pattern",
      "slugthrower",
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      "component:craftsman-novice",
      "tool:craftsman-novice",
      "weapon:craftsman-novice",
      "weapon:craftsman-assembly-i",
    ]);
    const [component, tool, weaponNovice, weaponAssembly] = groups;
    expect(component!.professionLabel).toBe("CRAFTSMAN");
    expect(component!.progressionLabel).toBe("NOVICE");
    expect(component!.categoryLabel).toBe("COMPONENTS");
    expect(tool!.unlockedCount).toBe(2);
    expect(weaponNovice!.unlockedCount).toBe(1);
    // The locked assembly-i box is the profession's next training target.
    expect(weaponAssembly!.progressionLabel).toBe("ASSEMBLY I");
    expect(weaponAssembly!.unlockedCount).toBe(0);
    expect(weaponAssembly!.nextUp).toBe(true);
    expect(weaponNovice!.nextUp).toBe(false);
  });

  it("category filter drops other categories without reordering survivors", () => {
    const weapons = composeBrowserGroups(fixtureRecipes(), "weapon", "", true);
    expect(weapons.flatMap((group) => group.rows.map((row) => row.recipeId)))
      .toEqual(["scattergun_pattern", "slugthrower"]);
    expect(weapons.map((group) => group.key))
      .toEqual(["weapon:craftsman-novice", "weapon:craftsman-assembly-i"]);
  });

  it("search only removes rows — survivors keep stream order and group labels", () => {
    const groups = composeBrowserGroups(fixtureRecipes(), "all", "tool", true);
    // "tool" matches Field Multitool + Personal Mineral Sampler? Sampler has
    // no "tool" in its name — only the multitool survives, in its group.
    expect(groups.flatMap((group) => group.rows.map((row) => row.recipeId))).toEqual(["field_multitool"]);
    expect(groups[0]!.key).toBe("tool:craftsman-novice");
    const broad = composeBrowserGroups(fixtureRecipes(), "all", "e", true);
    const streamOrder = composeBrowserGroups(fixtureRecipes(), "all", "", true)
      .flatMap((group) => group.rows.map((row) => row.recipeId))
      .filter((id) => broad.some((group) => group.rows.some((row) => row.recipeId === id)));
    expect(broad.flatMap((group) => group.rows.map((row) => row.recipeId))).toEqual(streamOrder);
  });

  it("names the lock reason in player language and the learned remaining count", () => {
    const rows = composeBrowserGroups(fixtureRecipes(), "weapon", "", true).flatMap((group) => group.rows);
    const learned = rows.find((row) => row.recipeId === "scattergun_pattern")!;
    expect(learned.sourceLabel).toBe("LEARNED");
    expect(learned.remainingLine).toBe("3 uses left");
    expect(learned.lockedNote).toBeNull();
    const locked = rows.find((row) => row.recipeId === "slugthrower")!;
    expect(locked.lockedNote).toBe("Not trained yet — Craftsman · Assembly I");
  });

  it("snapshots the grouped browser composition for the fixture set", () => {
    expect(composeBrowserGroups(fixtureRecipes(), "all", "", true)).toMatchSnapshot();
  });

  it("shows only authority-eligible recipes by default", () => {
    const rows = composeBrowserGroups(fixtureRecipes(), "all")
      .flatMap((group) => group.rows);
    expect(rows.every((row) => row.unlocked)).toBe(true);
    expect(rows.map((row) => row.recipeId)).not.toContain("slugthrower");
  });
});

describe("recipe ledger", () => {
  const battery = () => fixtureRecipes().find((recipe) => recipe.recipeId === "extractor_battery")!;
  const multitool = () => fixtureRecipes().find((recipe) => recipe.recipeId === "field_multitool")!;
  const slugthrower = () => fixtureRecipes().find((recipe) => recipe.recipeId === "slugthrower")!;

  it("arms BEGIN with a carried tool and lists requirements + ceilings", () => {
    const ledger = composeRecipeLedger(battery(), fixtureBatteryDetail(), { toolCarried: true });
    expect(ledger.canBegin).toBe(true);
    expect(ledger.beginNote).toBeNull();
    expect(ledger.requirements).toHaveLength(3);
    expect(ledger.requirements[0]!.kindLabel).toBe("Copper conductor");
    expect(ledger.requirements[0]!.statLabel).toBe("CONDUCTIVITY");
    expect(ledger.requirements[0]!.qtyText).toBe("×24");
    expect(ledger.requirements[0]!.materialLine).toBe("Copper (×24)");
    expect(ledger.requirements[1]!.materialLine).toBe("Iron (×12)");
    expect(ledger.requirements[2]!.materialLine).toBe("Fuel (×12)");
    expect(ledger.limits.map((limit) => limit.capText)).toEqual(["≤ 866"]);
  });

  it("tool-gates ordinary recipes but keeps hands-craftable live with the warning", () => {
    const gated = composeRecipeLedger(battery(), fixtureBatteryDetail(), { toolCarried: false });
    expect(gated.canBegin).toBe(false);
    expect(gated.beginNote).toBe("Needs a crafting tool in your pack.");
    const bareHands = composeRecipeLedger(multitool(), null, { toolCarried: false });
    expect(bareHands.canBegin).toBe(true);
    expect(bareHands.beginNote).toContain("bare-handed");
  });

  it("locks untrained recipes with the profession named", () => {
    const ledger = composeRecipeLedger(slugthrower(), null, { toolCarried: true });
    expect(ledger.canBegin).toBe(false);
    expect(ledger.beginNote).toContain("Not trained yet");
  });

  it("refuses a spent learned recipe", () => {
    const spent = { ...battery(), source: "learned" as const, remainingUses: 0 };
    const ledger = composeRecipeLedger(spent, null, { toolCarried: true });
    expect(ledger.canBegin).toBe(false);
    expect(ledger.beginNote).toBe("SPENT");
  });

  it("shows every sampler requirement at once with carried counts and READY/MISSING", () => {
    const sampler = fixtureRecipes().find((recipe) => recipe.recipeId === "metal_extractor")!;
    const carried: Record<number, number> = { 2001: 120, 2007: 12 };
    const ledger = composeRecipeLedger(sampler, fixtureSamplerDetail(), {
      toolCarried: true,
      ownedQtyOf: (slot) => carried[slot.requiredItemId ?? -1] ?? 0,
    });
    // Iron ×80 and Copper ×36 render TOGETHER, before any session begins.
    expect(ledger.requirements).toHaveLength(2);
    const [iron, copper] = ledger.requirements;
    expect(iron!.materialLine).toBe("Iron (×80)");
    expect(iron!.requiredQty).toBe(80);
    expect(iron!.ownedQty).toBe(120);
    expect(iron!.carriedLine).toBe("120 carried");
    expect(iron!.ready).toBe(true);
    expect(iron!.stateLabel).toBe("READY");
    expect(copper!.materialLine).toBe("Copper (×36)");
    expect(copper!.requiredQty).toBe(36);
    expect(copper!.ownedQty).toBe(12);
    expect(copper!.carriedLine).toBe("12 carried");
    expect(copper!.ready).toBe(false);
    expect(copper!.stateLabel).toBe("MISSING");
    // Ownership informs, never gates — the server validates on BEGIN.
    expect(ledger.canBegin).toBe(true);
  });

  it("keeps ownership honest-unknown when no counter is wired", () => {
    const sampler = fixtureRecipes().find((recipe) => recipe.recipeId === "metal_extractor")!;
    const ledger = composeRecipeLedger(sampler, fixtureSamplerDetail(), { toolCarried: true });
    for (const requirement of ledger.requirements) {
      expect(requirement.ownedQty).toBeNull();
      expect(requirement.carriedLine).toBeNull();
      expect(requirement.ready).toBeNull();
      expect(requirement.stateLabel).toBeNull();
    }
  });
});

describe("slot screen", () => {
  it("keeps the server option order and tags the server recommendation only", () => {
    const model = composeSlotScreen(fixtureSlotScreen(), 0);
    expect(model.options.map((option) => option.name)).toEqual([
      "Daxmire Copper",
      "Vessic Copper",
      "Ashfall Copper",
    ]);
    expect(model.options.map((option) => option.recommended)).toEqual([true, false, false]);
    // Ashfall has the best conductivity but only 2 of 4 required — the
    // composer must expose the shortage instead of re-ranking.
    expect(model.options[2]!.shortStack).toBe(true);
    expect(model.optionStatLabel).toBe("CONDUCTIVITY");
    expect(model.cards[0]!.kindLabel).toBe("Copper conductor");
    expect(model.cards[0]!.materialLine).toBe("Copper (×24)");
  });

  it("reflects assignment on cards and gates ASSEMBLE honestly", () => {
    const empty = composeSlotScreen(fixtureSlotScreen(), 0);
    expect(empty.cards.map((card) => card.filled)).toEqual([false, false, false]);
    expect(empty.canAssemble).toBe(false);
    expect(empty.assembleNote).toBe("Fill every slot to assemble.");
    const loaded = composeSlotScreen(fixtureSlotScreenLoaded(), 1);
    expect(loaded.cards.map((card) => card.filled)).toEqual([true, true, true]);
    expect(loaded.cards[0]!.assignedLine).toBe("Daxmire Copper ×24");
    expect(loaded.canAssemble).toBe(true);
    expect(loaded.assembleNote).toBe("Assembly spends the loaded materials.");
    const assignedIron = loaded.options.find((option) => option.name === "Daxmire Iron")!;
    expect(assignedIron.assigned).toBe(true);
  });

  it("advances to the first unfilled slot", () => {
    expect(nextSlotIndex(fixtureSlotScreen(), 0)).toBe(0);
    const half = fixtureSlotScreen();
    half.slots[0]!.assigned = { container: "player:field-pack", stackId: "11", variantId: 220_431 };
    expect(nextSlotIndex(half, 0)).toBe(1);
    expect(nextSlotIndex(fixtureSlotScreenLoaded(), 1)).toBe(1);
  });

  it("marks the craft-relevant stat inside the 12-stat hover", () => {
    const hover = composeStatHover(fixtureStats({ conductivity: 812 }), "conductivity");
    expect(hover).toHaveLength(12);
    const relevant = hover.filter((row) => row.relevant);
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.key).toBe("conductivity");
    expect(relevant[0]!.value).toBe(812);
  });

  it("names the active slot and the missing quantity on short stacks", () => {
    const model = composeSlotScreen(fixtureSlotScreen(), 0);
    expect(model.activeSlotLine).toBe("LOADING · COPPER CONDUCTOR · ×24");
    // Ashfall Copper carries 2 of the 24 required — visible, LOAD-refused,
    // with the exact shortage named.
    expect(model.options[2]!.shortStack).toBe(true);
    expect(model.options[2]!.unavailableNote).toBe("OWN 2 · NEED 24");
    expect(model.options[0]!.unavailableNote).toBeNull();
  });
});

describe("experiment allocator", () => {
  const none: PendingSpend = new Map();

  it("stages points within the pool and never onto capped lines", () => {
    const assembled = fixtureAssembled();
    let pending = adjustPendingSpend(none, assembled, 0, 1);
    pending = adjustPendingSpend(pending, assembled, 0, 1);
    expect(totalPending(pending)).toBe(2);
    // Nonexistent line 1 cannot raise — no-op:
    expect(adjustPendingSpend(pending, assembled, 1, 1)).toBe(pending);
    // Capped line: let's add a capped line to assembled via override
    const withCapped = fixtureAssembled({
      lines: [
        { lineId: 0, label: "runtime", valueMilli: 668, capMilli: 866, canRaise: true },
        { lineId: 2, label: "stability", valueMilli: 500, capMilli: 500, canRaise: false },
      ],
    });
    // Line 2 cannot raise:
    expect(adjustPendingSpend(pending, withCapped, 2, 1)).toBe(pending);
    // Pool is 4: we already spent 2 on line 0. Let's spend 2 more.
    pending = adjustPendingSpend(pending, assembled, 0, 2);
    expect(totalPending(pending)).toBe(4);
    // Trying to spend 5th point should be a no-op:
    expect(adjustPendingSpend(pending, assembled, 0, 1)).toBe(pending);
  });

  it("unstages cleanly and drops zeroed lines", () => {
    const assembled = fixtureAssembled();
    let pending = adjustPendingSpend(none, assembled, 0, 2);
    pending = adjustPendingSpend(pending, assembled, 0, -1);
    expect(pending.get(0)).toBe(1);
    pending = adjustPendingSpend(pending, assembled, 0, -1);
    expect(pending.has(0)).toBe(false);
    expect(adjustPendingSpend(pending, assembled, 0, -1)).toBe(pending);
  });

  it("composes the finish model with staged marks, pool pips data and honest notes", () => {
    const assembled = fixtureAssembled({
      lines: [
        {
          lineId: 0,
          label: "runtime",
          valueMilli: 668,
          capMilli: 866,
          canRaise: true,
          onePointSuccessMilli: 705,
          batchRiskPerExtraPointMilli: 50,
        },
        { lineId: 3, label: "stability", valueMilli: 500, capMilli: 500, canRaise: false },
      ],
    });
    const pending = adjustPendingSpend(none, assembled, 0, 2);
    const model = composeFinish(assembled, pending);
    expect(model.qualityText).toBe("74.2%");
    expect(model.pointsLeft).toBe(4);
    expect(model.pointsAfterPending).toBe(2);
    expect(model.poolMax).toBe(TUNE_POOL_MAX);
    expect(model.poolText).toBe("2 / 7");
    expect(model.canExperiment).toBe(true);
    const runtime = model.lines.find((line) => line.lineId === 0)!;
    expect(runtime.valueText).toBe("668");
    expect(runtime.capText).toBe("866");
    expect(runtime.noteLine).toBe("+2 marked");
    const capped = model.lines.find((line) => line.lineId === 3)!;
    expect(capped.canRaise).toBe(false);
    expect(capped.noteLine).toBe("At its ceiling");
    // Capped lines never advertise odds — nothing can be attempted.
    expect(capped.holdChanceText).toBeNull();
    expect(composeFinish(assembled, new Map()).canExperiment).toBe(false);
  });

  it("derives the exact authority success chance for 1 vs multi-point attempts", () => {
    // clamp(one − risk×(points−1), 100, 950) — the authority contract.
    expect(batchSuccessMilli(705, 50, 1)).toBe(705);
    expect(batchSuccessMilli(705, 50, 2)).toBe(655);
    expect(batchSuccessMilli(705, 50, 4)).toBe(555);
    // Floor and ceiling clamps hold at both ends.
    expect(batchSuccessMilli(120, 50, 5)).toBe(100);
    expect(batchSuccessMilli(990, 50, 1)).toBe(950);

    const assembled = fixtureAssembled();
    // Nothing staged → the one-point baseline is shown.
    const idle = composeFinish(assembled, new Map()).lines[0]!;
    expect(idle.holdChanceText).toBe("70.5%");
    expect(idle.slipChanceText).toBe("29.5%");
    // Three staged points → 705 − 50×2 = 605.
    let pending: PendingSpend = new Map([[0, 3]]);
    const staged = composeFinish(assembled, pending).lines[0]!;
    expect(staged.holdChanceText).toBe("60.5%");
    expect(staged.slipChanceText).toBe("39.5%");
    // Wire without the risk fields shows nothing rather than inventing.
    const bare = fixtureAssembled({
      lines: [{ lineId: 0, label: "runtime", valueMilli: 668, capMilli: 866, canRaise: true }],
    });
    pending = new Map([[0, 1]]);
    expect(composeFinish(bare, pending).lines[0]!.holdChanceText).toBeNull();
  });

  it("keeps rail geometry exact authority milli with the neutral toward-cap badge", () => {
    // Rails are survey instruments: 0 milli sits at exactly 0%, 1000 at
    // 100% — no statMeterPct visibility floor, fractions kept.
    expect(railPct(0)).toBe(0);
    expect(railPct(1000)).toBe(100);
    expect(railPct(866)).toBeCloseTo(86.6);
    expect(railPct(-5)).toBe(0);
    expect(railPct(2000)).toBe(100);
    const assembled = fixtureAssembled({
      lines: [
        { lineId: 0, label: "power", valueMilli: 0, capMilli: 1000, canRaise: true },
        { lineId: 1, label: "runtime", valueMilli: 668, capMilli: 866, canRaise: true },
      ],
    });
    const model = composeFinish(assembled, new Map());
    expect(model.lines[0]!.valuePct).toBe(0);
    expect(model.lines[0]!.capPct).toBe(100);
    expect(model.lines[1]!.valuePct).toBeCloseTo(66.8);
    expect(model.lines[1]!.capPct).toBeCloseTo(86.6);
    // Line milli is normalized goodness — the only truthful direction is
    // toward the pin, on every line.
    for (const line of model.lines) {
      expect(line.dirLabel).toBe("TOWARD CAP · BETTER");
    }
  });

  it("snapshots the finish composition", () => {
    expect(composeFinish(fixtureAssembled(), new Map())).toMatchSnapshot();
  });
});

describe("draft uses clamp", () => {
  it("holds the owner cap 1..1000", () => {
    expect(clampDraftUses(0)).toBe(1);
    expect(clampDraftUses(-5)).toBe(1);
    expect(clampDraftUses(10.9)).toBe(10);
    expect(clampDraftUses(1000)).toBe(1000);
    expect(clampDraftUses(4000)).toBe(1000);
    expect(clampDraftUses(Number.NaN)).toBe(1);
  });
});

describe("datapad drafts", () => {
  it("summarizes uses, locks and frozen stats; spent drafts sink", () => {
    const rows = composeDraftRows(fixtureDrafts());
    expect(rows[0]!.name).toBe("Extractor Battery");
    expect(rows[0]!.usesText).toBe("7/10 USES");
    expect(rows[0]!.spent).toBe(false);
    expect(rows[0]!.lockLine).toBe("Daxmire Copper ×24 · Daxmire Iron ×12 · Fuel ×12");
    expect(rows[0]!.statLine).toBe("RUNTIME 724");
    expect(rows[1]!.spent).toBe(true);
    expect(rows[1]!.name).toBe("Personal Mineral Sampler");
  });
});
