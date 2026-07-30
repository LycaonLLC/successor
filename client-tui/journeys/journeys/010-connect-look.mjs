/** Connect + look — the front door: signal, area voice, /where truth. */
export default async function connectLook({ session, actorId, check }) {
  const tui = session({ actorId: actorId("a"), displayName: "GateWalker", spawnX: 514, spawnY: 514 });
  await tui.expect(/Signal locked\. You are in the world\./);
  const scene = await tui.expect(/open desert/i);
  check("area voice speaks the biome", /desert/i.test(scene.line));
  await tui.say("/look", /open desert/i);
  const where = await tui.say("/where", /WHERE open-desert-overworld (\d+),(\d+) facing/);
  check("/where reports integer coordinates", Number(where.match[1]) > 0 && Number(where.match[2]) > 0);
  await tui.say("/vitals", /HP|VITALS/i);
}
