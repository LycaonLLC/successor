/** Query verbs — /inv /nearby /queue /budget /receipts speak scoped truth. */
export default async function queries({ session, actorId, grant, check }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "GateClerk", spawnX: 514, spawnY: 514 });
  await tui.expect(/Signal locked/);
  await grant(id, "stimpak", 2);
  await tui.idle(900); // the grant delta rides the next snapshot
  const inv = await tui.say("/inv stimpak", /INV (\d+) STACK/);
  check("granted stimpaks visible in scoped /inv", Number(inv.match[1]) >= 1);
  check("inventory rows are own containers only", inv.line.includes(`${id}:`) || inv.line.includes("field-pack"));
  await tui.say("/nearby", /NEARBY/);
  await tui.say("/queue", /queue|idle/i);
  await tui.say("/budget", /ok \d+|BUDGET|sent/i);
  await tui.say("/receipts 4", /No receipts yet\.|#\d+ t\d+/);
}
