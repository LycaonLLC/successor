/**
 * Trade, two sessions — the whole spoken double-lock protocol with the
 * offer id PARSED FROM PROSE (the harness philosophy: assert the surface
 * players read; never assume clean-room numbering).
 */
export default async function tradeDuo({ session, actorId, grant, check }) {
  const aId = actorId("a");
  const bId = actorId("b");
  const a = session({ actorId: aId, displayName: "GateMarlow", spawnX: 514, spawnY: 514 });
  const b = session({ actorId: bId, displayName: "GatePetra", spawnX: 514, spawnY: 514 });
  await a.expect(/Signal locked/);
  await b.expect(/Signal locked/);
  await grant(aId, "stimpak", 3);
  await grant(aId, "iron", 1); // request-side resolution
  await grant(bId, "iron", 10);
  await a.idle(1200); // grant deltas + mutual AOI before the propose
  await a.say("/inv stimpak", /INV \d+ STACK/);
  a.send("/trade propose gatepetra give stimpak:2 for 2001:5");
  await a.expect(/You offer GatePetra: Stimpak A ×2 — asking Iron Resource Container ×5/);
  // the table opens on BOTH sides; the offer id is TAUGHT in the prose
  const opened = await b.expect(/«GateMarlow» is at the table — offer (\d+): yours Iron Resource Container ×5 · theirs Stimpak A ×2/);
  const offer = opened.match[1];
  check(`offer id taught in-fiction (${offer})`, Number(offer) > 0);
  await b.expect(new RegExp(`/trade accept ${offer} locks your side`));
  // B's table view before any move
  await b.say("/trade", new RegExp(`TRADE — offer ${offer} with «GateMarlow» · NEGOTIATING`));
  await b.expect(/yours {2}— Iron Resource Container ×5 {3}\[open\]/);
  // dual lock — A HEARS B's lock
  b.send(`/trade accept ${offer}`);
  await a.expect(/«GatePetra» locks their side\./);
  a.send(`/trade accept ${offer}`);
  await b.expect(/«GateMarlow» locks their side\./);
  await b.expect(new RegExp(`Both sides stand locked — /trade confirm ${offer} seals it`));
  // The anti-abuse beat: A's credit move clears BOTH locks, B hears it.
  a.send(`/trade credits ${offer} 5`);
  await b.expect(/«GateMarlow» puts 5 credits on the table — the locks come off\./);
  // relock + dual confirm
  b.send(`/trade accept ${offer}`);
  await a.expect(/«GatePetra» locks their side\./);
  a.send(`/trade accept ${offer}`);
  await b.expect(/«GateMarlow» locks their side\./);
  const table = await a.say("/trade", new RegExp(`TRADE — offer ${offer} with «GatePetra» · (CONFIRM|BOTH LOCKED)`));
  check(`table stage reflects the server VM (${table.match[1]})`, table.match[1].length > 0);
  b.send(`/trade confirm ${offer}`);
  await a.expect(/«GatePetra»'s hand comes down\./);
  a.send(`/trade confirm ${offer}`);
  await a.expect(/Hands shake — the trade is done\./);
  await b.expect(/Hands shake — the trade is done\./);
  // the oracle: goods actually moved
  const ironA = await a.say("/inv iron", /INV \d+ STACK/);
  check("A holds the iron (swap executed)", /[6-9] AVAILABLE|\d\d+ AVAILABLE/.test(ironA.line));
  const stimB = await b.say("/inv stimpak", /INV \d+ STACK/);
  check("B holds the stimpaks", /\d+ AVAILABLE/.test(stimB.line));
}
