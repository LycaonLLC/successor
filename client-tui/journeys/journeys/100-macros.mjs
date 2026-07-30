/** Macro engine — define, run (chained verbs fire), list, remove. */
export default async function macros({ session, actorId, check }) {
  const tui = session({ actorId: actorId("a"), displayName: "GateScribe", spawnX: 514, spawnY: 514 });
  await tui.expect(/Signal locked/);
  await tui.say("/macro def probe /where ; /pause 0.3 ; /vitals", /probe|defined|MACRO/i);
  tui.send("/macro run probe");
  const where = await tui.expect(/WHERE \S+ \d+,\d+/);
  check("macro's /where fired", where.line.length > 0);
  const vitals = await tui.expect(/HP|VITALS/i);
  check("macro's chained /vitals fired after the pause", vitals.line.length > 0);
  const listed = await tui.say("/macro list", /probe/);
  check("macro lists by name", listed.line.includes("probe"));
}
