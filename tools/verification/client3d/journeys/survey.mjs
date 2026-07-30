// Journey: universal hand sample first, then trained/tool survey. A fresh
// Marksman assigns Hand sample from the real Action Browser, opens the family
// picker from the toolbar, and starts a concrete sample without a Craftsman
// box or survey tool. Only after that proof do we grant Craftsman + the Mineral
// Survey Tool and exercise the richer heatmap path.
// Money shots: first-use hand-sample picker, sampling countdown/flash, survey heatmap.
import { ITEM } from "./_helpers.mjs";

const RESOURCE_ITEM_ID_BY_FAMILY = Object.freeze({
  metal: 2001,
  copper: 2007,
  chemical: 2002,
  gas: 2004,
  water: 2005,
  carbon: 2008,
});

function sampledFamilyQuantity(oracle, actorId, itemId) {
  return (oracle?.inventory ?? [])
    .filter((row) => Number(row.itemId) === itemId && String(row.container).startsWith(actorId))
    .reduce((total, row) => total + Number(row.quantity ?? 0), 0);
}

export default {
  id: "survey",
  title: "Universal hand sample + trained tool survey",
  timeoutMs: 120000,
  characters: [{
    role: "primary",
    id: "h3d-survey-probe",
    name: "ProbeSurvey",
    x: 516,
    y: 512,
    initialProfessionId: "marksman",
    skillBoxIds: ["marksman-novice"],
  }],
  async run(ctx) {
    const s = ctx.primary;
    await ctx.moneyShot("00-spawn");

    const initial = await s.oracle();
    const actor = initial.actors?.[s.actorId];
    const initialBoxes = (actor?.professions ?? []).flatMap((profession) => profession.skillBoxes ?? []);
    const initialItems = (initial.inventory ?? []).filter((row) => String(row.container).startsWith(s.actorId));
    s.assert(!initialBoxes.includes("craftsman-novice"), `fresh sampler unexpectedly has Craftsman: ${JSON.stringify(initialBoxes)}`);
    s.assert(!initialItems.some((row) => Number(row.itemId) === ITEM.mineralSurveyTool), "fresh sampler unexpectedly owns a Mineral Survey Tool");

    // Real player route: Actions (B) -> double-click Hand sample -> slot 1 ->
    // first-use family picker. No remembered `$last` family is involved.
    await s.press("KeyB");
    await s.waitDom('.sc3d-window[data-window="actions"]', { state: "visible", timeoutMs: 6000 });
    await s.page.locator('.scp-action-row[data-action="sample"]').dblclick();
    await s.press("KeyB");
    await s.page.locator('.sc3d-toolbar-slot[data-slot="0"]').click();
    await s.waitDom('.sc3d-window[data-window="surveyTool"]', { state: "visible", timeoutMs: 6000 });
    await s.waitProbeCall(
      () => s.page.locator('.sc3d-window[data-window="surveyTool"] [data-ref="status"]').innerText().catch(() => ""),
      (text) => text.includes("HAND SAMPLE READY")
        && text.includes("TOOL SURVEY REQUIRES CRAFTSMAN + MATCHING TOOL"),
      { label: "tool-free hand-sample picker status", timeoutMs: 6000 },
    );
    const selectedFamilySelector = '.sc3d-window[data-window="surveyTool"] .dws-target-btn[data-family][aria-checked="true"]';
    await s.waitDom(selectedFamilySelector, { state: "visible", timeoutMs: 6000 });
    const sampledFamily = await s.page.locator(selectedFamilySelector).first().getAttribute("data-family");
    const sampledItemId = RESOURCE_ITEM_ID_BY_FAMILY[sampledFamily];
    s.assert(sampledItemId != null, `no inventory item mapping for sampled family ${JSON.stringify(sampledFamily)}`);
    await ctx.moneyShot("01-hand-sample-picker");

    const [beforeSample, beforeSampleOracle] = await Promise.all([s.probe(), s.oracle()]);
    const knownReceiptIds = new Set((beforeSample.authorityReceiptTail ?? []).map((entry) => entry.commandId));
    const quantityBefore = sampledFamilyQuantity(beforeSampleOracle, s.actorId, sampledItemId);
    await s.click('[data-ref="sampleBtn"]');
    const sampleAccepted = await s.waitProbe(
      (probe) => (probe.authorityReceiptTail ?? []).some((entry) => (
        !knownReceiptIds.has(entry.commandId)
        && entry.kind === "SampleResource"
        && entry.accepted === true
      )),
      { label: "tool-free SampleResource accepted", timeoutMs: 12000 },
    );
    const sampleReceipt = (sampleAccepted.authorityReceiptTail ?? []).find((entry) => (
      !knownReceiptIds.has(entry.commandId) && entry.kind === "SampleResource"
    ));
    s.assert(sampleReceipt?.accepted === true, `tool-free sample rejected: ${JSON.stringify(sampleReceipt ?? null)}`);

    let sawSamplingFlash = false;
    const sampled = await s.waitProbeCall(
      async () => {
        const [oracle, flash] = await Promise.all([
          s.oracle(),
          s.page.locator(".sc3d-extraction-flash:not([hidden])").count().catch(() => 0),
        ]);
        sawSamplingFlash ||= flash > 0;
        return {
          quantity: sampledFamilyQuantity(oracle, s.actorId, sampledItemId),
          flash,
        };
      },
      (value) => value.quantity > quantityBefore,
      { label: `${sampledFamily} hand-sample total quantity increase`, timeoutMs: 20000 },
    );
    s.assert(
      sampled.quantity > quantityBefore,
      `${sampledFamily} sample did not increase total item ${sampledItemId} quantity: ${quantityBefore} -> ${sampled.quantity}`,
    );
    ctx.note(`untrained ${sampledFamily} hand sample accepted without tool -> total quantity ${quantityBefore} to ${sampled.quantity}; presentation flash=${sawSamplingFlash || sampled.flash > 0}`);
    await ctx.moneyShot("02-hand-sampling");
    await s.slash("/stand");

    // Specialist depth: add the normal Craftsman novice box and matching tool,
    // then prove the richer concentration map becomes available.
    const skill = await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: ["craftsman-novice"] } });
    const give = await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.mineralSurveyTool, variant_id: 0, quantity: 1 } });
    ctx.note(`grant craftsman-novice -> ${JSON.stringify(skill.receipt ?? skill.error ?? "?")}; Mineral Survey Tool -> ${JSON.stringify(give.receipt ?? give.error ?? "?")}`);

    const before = await s.probe("__successor3dSurvey");
    const beforeVersion = before?.version ?? -1;
    await s.slash("/survey iron");
    // A concentration disc must be discovered (heatmap populated).
    const surveyed = await s.waitProbe(
      (m) => m.version !== beforeVersion && (m.discCount > 0 || m.localConcentrationMilli != null),
      { name: "__successor3dSurvey", label: "survey disc discovered", timeoutMs: 12000 },
    );
    ctx.note(`survey -> version ${surveyed.version} discCount ${surveyed.discCount} conc ${surveyed.localConcentrationMilli}`);
    await ctx.moneyShot("03-heatmap");
    s.assert(surveyed.discCount > 0 || surveyed.localConcentrationMilli != null, `survey found no iron concentration`);
  },
};
