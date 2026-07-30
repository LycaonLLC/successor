/**
 * Universal hand sample + specialist survey. Sampling is the tool-free entry
 * verb; Craftsman plus the matching survey tool paints the richer reading.
 */
export default async function surveySample({ session, actorId, grant, grantSkills, check }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "GateProspector" }); // default spawn — the v1 sampling ground
  await tui.expect(/Signal locked/);

  await tui.say("/sample iron", /SAMPLING .* HOLD POSITION/i);
  const handAction = await tui.expect(/kneel and work a small sample loose by hand/i);
  check("an ordinary player can begin a tool-free hand sample", /by hand/i.test(handAction.line));
  const sampleOutcome = await tui.expect(/Pay dirt: iron|sampler comes up.*iron|You pull iron.*out of the ground/i, { timeoutMs: 15_000 });
  check("the universal sample resolves through authority with iron in hand", /iron/i.test(sampleOutcome.line));

  // Specialist knowledge remains gated on Craftsman plus the category tool.
  await grantSkills(id, ["craftsman-novice"]);
  await grant(id, "surveyTool", 1);
  await tui.idle(900);
  await tui.say("/survey iron", /SURVEYING/i);
  const reading = await tui.expect(/(scanner paints|Reading lands).*\d+%|iron.*\d+%/i, { timeoutMs: 12_000 });
  check("the scanner reports a concentration reading", /\d+%/.test(reading.line));
}
