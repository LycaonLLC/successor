/**
 * Extractor loop — place (real rig item), crank, stop, seat a battery,
 * then pack up: with value aboard the pack-up ARMS a confirm (the
 * yield-forfeit ruling); the second call executes.
 */
export default async function extractor({ session, actorId, grant, grantSkills, check, note }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "GateRigger", spawnX: 516, spawnY: 516 });
  await tui.expect(/Signal locked/);
  await tui.say("/extractors", /No extractors/i);
  await grantSkills(id, ["craftsman-novice"]);
  await grant(id, "surveyTool", 1);
  await grant(id, "extractorTool", 1);
  await grant(id, "battery1h", 1);
  await tui.idle(900);
  await tui.say("/survey iron", /SURVEYING/i);
  const reading = await tui.expect(/(scanner paints|Reading lands).*\d+%|iron.*\d+%/i, { timeoutMs: 12_000 });
  check("the category survey establishes the extractor target", /\d+%/.test(reading.line));
  await tui.say("/extractor place iron", /honest ground|drive the extractor/i);
  await tui.expect(/deployed/i);
  const rigs = await tui.say("/extractors", /1\./);
  check("placed rig lists with telemetry", /1\./.test(rigs.line));
  await tui.say("/extractor crank 1", /put your back into the crank/i);
  await tui.idle(2500); // let the drum turn
  await tui.say("/extractor stop 1", /let the crank wind down/i);
  await tui.say("/extractor battery 1", /battery seats with a click/i);
  const packup = await tui.say("/extractor packup 1", /again to confirm|forfeit|break the rig down/i);
  if (/break the rig down/i.test(packup.line)) {
    note("pack-up executed directly (no forfeitable value aboard)");
  } else {
    check("pack-up with value aboard arms a confirm", true);
    await tui.say("/extractor packup 1", /break the rig down and shoulder it/i);
  }
  await tui.say("/extractors", /No extractors/i);
}
