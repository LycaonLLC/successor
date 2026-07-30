/**
 * Travel + exchange — catalog truth and honest reach denies: the gate
 * asserts DENY copy as product surface (earlier sandbox design's "get to the counter").
 */
export default async function travelExchange({ session, actorId, grant, check }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "GateCourier", spawnX: 514, spawnY: 514 });
  await tui.expect(/Signal locked/);
  const list = await tui.say("/travel list", /Travel|catalog|terminal/i);
  check("travel list speaks catalog or honest absence", list.line.length > 0);
  const buy = await tui.say("/travel buy verdance", /counter|terminal|reach|DENIED|No route/i);
  check("ticket purchase denies honestly away from the counter", buy.line.length > 0);
  await grant(id, "stimpak", 1);
  const store = await tui.say("/exchange store stimpak 1", /counter|exchange|reach|NO TARGET|DENIED/i);
  check("exchange store denies honestly without a counter", store.line.length > 0);
  await tui.say("/exchange list", /EXCHANGE|empty|ledger|No/i);
}
