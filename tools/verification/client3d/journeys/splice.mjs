// Journey: SPLICE (bioengineer gene bench). Drives the REAL client-3d GENE
// BENCH window (client-3d/src/ui/splice) end to end over the current authority
// wire; TUI journey 145 covers the corresponding terminal flow:
//   LAB   — sample two wild landraces, scan both (full reveal at Sequencing IV)
//   BENCH — begin, seat both parents + reagents, read the LOCI allele pairs,
//           pick a non-elite allele (SpliceChooseAllele)
//   SPLICE— assemble, experiment a point into YIELD, MINT a named cultivar
// Asserts against the window's own phase surfaces + the ORACLE: a NEW child
// seed variant (distinct from both parents) lands in the pack, and scanning it
// reads back the minted cultivar name (genome/seed assert).

import { openInventoryContextAction } from "./_helpers.mjs";

const ASHGRAIN = 6_001;
const CULTIVAR = "SeedlabKestrel";
// Bio tools carry quality in the variant; reagents carry potency (splice.rs).
const BENCH_Q = 950;
const BIO_TOOL_ITEMS = [6_201, 6_203, 6_202];
const REAGENTS = [
  { slot: 2, itemId: 6_204, potency: 940 }, // culture medium
  { slot: 3, itemId: 6_205, potency: 950 }, // mutagen
  { slot: 4, itemId: 6_206, potency: 950 }, // stabilizer
];

export default {
  id: "splice",
  title: "Splice (gene bench session)",
  timeoutMs: 150000,
  characters: [{ role: "primary", id: "h3d-splice-probe", name: "ProbeSplice", x: 512, y: 512, initialProfessionId: "craftsman" }],

  async arm(ctx) {
    // Debug grant inserts ids without the PurchaseSkillBox kit hook, so the
    // tools + reagents are given directly; the parents must be SAMPLED (their
    // genomes have to intern into the CropGenomeRegistry — a given seed with an
    // arbitrary variant would not resolve).
    await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: [
      "bioengineer-novice",
      "bioengineer-sequencing-i", "bioengineer-sequencing-ii", "bioengineer-sequencing-iii", "bioengineer-sequencing-iv",
      "bioengineer-splicing-i", "bioengineer-splicing-ii", "bioengineer-splicing-iii", "bioengineer-splicing-iv",
    ] } });
    await ctx.debugCommand({ DebugGiveItem: { item_id: 6_201, variant_id: 500, quantity: 1 } }); // Gene Sampler
    await ctx.debugCommand({ DebugGiveItem: { item_id: 6_203, variant_id: 500, quantity: 1 } }); // Genome Scanner
    await ctx.debugCommand({ DebugGiveItem: { item_id: 6_202, variant_id: BENCH_Q, quantity: 1 } }); // Splice Bench
    for (const r of REAGENTS) {
      await ctx.debugCommand({ DebugGiveItem: { item_id: r.itemId, variant_id: r.potency, quantity: 4 } });
    }
    ctx.note("armed bioengineer (novice + sequencing/splicing IV) + gene tools + reagents");
  },

  async run(ctx) {
    const s = ctx.primary;
    const seedStacks = (o) => (o.inventory ?? []).filter(
      (r) => r.itemId === ASHGRAIN && String(r.container).startsWith(s.actorId) && (r.available ?? 0) > 0,
    );

    // ── LAB: open the bench window ────────────────────────────────────────
    await openInventoryContextAction(s, 6_202, "splice-bench", {
      // The bench grant precedes three reagent grants. Waiting for the whole
      // armed set keeps their delayed client projection from reflowing the
      // bench tile while the real right-click is in flight under SwiftShader.
      readyItemIds: [...BIO_TOOL_ITEMS, ...REAGENTS.map((r) => r.itemId)],
      actionTimeoutMs: 15000,
    });
    await s.waitDom('.sc3d-window[data-window="splice"]', { state: "visible", timeoutMs: 8000 });
    await s.waitDom('[data-ref="labSurface"]:not([hidden])', { state: "attached", timeoutMs: 8000 });
    await ctx.moneyShot("00-lab");

    // ── ACQUIRE: sample two wild parents (the sampler has a ~5s cadence) ───
    await s.click('[data-ref="sampleBtn"]');
    await s.waitProbeCall(() => s.oracle(), (o) => seedStacks(o).length >= 1, { label: "first wild seed banked", timeoutMs: 12000 });
    let sampled = 1;
    for (let attempt = 0; attempt < 6 && sampled < 2; attempt += 1) {
      await ctx.delay(5500); // ride out BIO_SAMPLE_ACTION_MS
      await s.click('[data-ref="sampleBtn"]');
      const ok = await s.waitProbeCall(() => s.oracle(), (o) => seedStacks(o).length >= 2, { label: "second wild seed banked", timeoutMs: 7000 }).catch(() => null);
      if (ok) sampled = seedStacks(ok).length;
    }
    const parents = seedStacks(await s.oracle()).slice(0, 2);
    ctx.note(`sampled parents: ${parents.map((p) => `${p.itemId}@${p.variantId}`).join(", ")}`);
    s.assert(parents.length >= 2 && parents[0].variantId !== parents[1].variantId, "two DISTINCT wild parents were not sampled");
    const [pA, pB] = parents;
    await ctx.moneyShot("01-sampled");

    // ── ANALYZE: scan both parents (full reveal exposes the allele pairs) ──
    for (const p of [pA, pB]) {
      await s.click(`.scp-splice-seedrow[data-variant-id="${p.variantId}"] [data-scan]`);
      await ctx.delay(700);
    }
    await s.click(`.scp-splice-seedrow[data-variant-id="${pA.variantId}"]`); // select -> card shows its reveal
    await ctx.delay(400);
    const alleleCells = await s.page.locator(".scp-splice-card .scp-splice-alleles").count();
    ctx.note(`genome card allele cells revealed: ${alleleCells}`);
    s.assert(alleleCells > 0, "genome card revealed no allele pairs after a full-tier scan");
    await ctx.moneyShot("02-scanned");

    // ── SPLICE: open the bench for ashgrain ───────────────────────────────
    await s.click('[data-ref="beginBtn"]');
    await s.waitDom('[data-ref="benchSurface"]:not([hidden])', { state: "attached", timeoutMs: 10000 });

    // Seat parent A (slot 0) + parent B (slot 1) — DISTINCT genomes.
    await s.click('.scp-splice-slotcard[data-slot-index="0"]');
    await s.dblclick(`.scp-splice-opt[data-variant-id="${pA.variantId}"]`);
    await ctx.delay(500);
    await s.click('.scp-splice-slotcard[data-slot-index="1"]');
    await s.dblclick(`.scp-splice-opt[data-variant-id="${pB.variantId}"]`);
    await ctx.delay(500);
    // Seat the reagents (raise the caps above base; best-effort).
    for (const r of REAGENTS) {
      await s.click(`.scp-splice-slotcard[data-slot-index="${r.slot}"]`);
      const opt = s.page.locator(".scp-splice-opt").first();
      if (await opt.count() > 0) await opt.dblclick({ timeout: 6000 }).catch(() => {});
      await ctx.delay(350);
    }
    // The LOCI table now renders both parents' allele pairs — the money shot.
    await s.waitDom(".scp-splice-locus .scp-splice-allele[data-pick]", { state: "visible", timeoutMs: 8000 });
    const pairCells = await s.page.locator(".scp-splice-locus .scp-splice-allele[data-pick]").count();
    ctx.note(`loci allele-pick chips rendered: ${pairCells}`);
    s.assert(pairCells > 0, "LOCI table rendered no allele-pair pickers with both parents scanned");
    await ctx.moneyShot("03-bench-loci");

    // ── CHOOSE ALLELE: override parent-A's YIELD pick (SpliceChooseAllele) ─
    const notChosen = s.page.locator('.scp-splice-locus[data-locus="0"] .scp-splice-locus-side[data-side="a"] .scp-splice-allele[data-pick]:not([data-chosen])').first();
    if (await notChosen.count() > 0) {
      await notChosen.click({ timeout: 6000 }).catch(() => {});
      await ctx.delay(500);
      const chosen = await s.page.locator('.scp-splice-locus[data-locus="0"] .scp-splice-locus-side[data-side="a"] .scp-splice-allele[data-chosen]').count();
      ctx.note(`YIELD parent-A chosen chips after pick: ${chosen}`);
      s.assert(chosen >= 1, "allele pick did not register a chosen chip");
    }
    await ctx.moneyShot("04-allele-picked");

    // ── ASSEMBLE (point of no return) ─────────────────────────────────────
    await s.waitDom('[data-ref="assemble"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.click('[data-ref="assemble"]');
    await s.waitDom('[data-ref="finishSurface"]:not([hidden])', { state: "attached", timeoutMs: 12000 });
    await ctx.delay(400);
    await ctx.moneyShot("05-assembled");

    // ── EXPERIMENT: pour a point into YIELD, apply ────────────────────────
    const plus = s.page.locator('.scp-splice-line[data-locus="0"] button[data-spend="+"]:not([disabled])').first();
    if (await plus.count() > 0) {
      await plus.click({ timeout: 6000 }).catch(() => {});
      await ctx.delay(150);
      const expBtn = s.page.locator('[data-ref="experiment"]:not([disabled])');
      if (await expBtn.count() > 0) { await expBtn.click({ timeout: 6000 }).catch(() => {}); ctx.note("experimented one point into YIELD"); await ctx.delay(700); }
    }

    // ── MINT the named cultivar ───────────────────────────────────────────
    await s.page.fill('[data-ref="mintName"]', CULTIVAR);
    const before = seedStacks(await s.oracle()).map((r) => r.variantId);
    await s.click('[data-ref="mint"]');
    const minted = await s.waitProbeCall(
      () => s.oracle(),
      (o) => seedStacks(o).some((r) => !before.includes(r.variantId)),
      { label: "child cultivar seed minted", timeoutMs: 12000 },
    );
    const child = seedStacks(minted).find((r) => !before.includes(r.variantId));
    ctx.note(`minted child ${ASHGRAIN}@${child.variantId} x${child.available}`);
    // SEED assert: a new, distinct child variant is in the pack.
    s.assert(!!child, "no child seed variant appeared after mint");
    s.assert(child.variantId !== pA.variantId && child.variantId !== pB.variantId, "child variant collided with a parent handle");

    // GENOME assert: scan the child — the reveal names the minted cultivar.
    await s.waitDom('[data-ref="labSurface"]:not([hidden])', { state: "attached", timeoutMs: 8000 });
    const childSel = `.scp-splice-seedrow[data-variant-id="${child.variantId}"]`;
    await s.waitDom(childSel, { state: "visible", timeoutMs: 8000 });
    await s.click(`${childSel} [data-scan]`); // scan reads the row's dataset (no select needed)
    await ctx.delay(200);
    await s.click(childSel);                   // select so the card binds the child's reveal
    // The scan streams back async; poll the (unique) card until it names the cultivar.
    const cardText = await s.waitProbeCall(
      () => s.page.locator('[data-ref="card"]').innerText().catch(() => ""),
      (t) => String(t).includes(CULTIVAR),
      { label: "child genome card names the cultivar", timeoutMs: 12000 },
    ).catch(() => "");
    ctx.note(`child genome card: ${String(cardText).replace(/\s+/gu, " ").slice(0, 180)}`);
    s.assert(String(cardText).includes(CULTIVAR), `child genome card did not name the minted cultivar «${CULTIVAR}»`);
    await ctx.moneyShot("06-minted");
  },
};
