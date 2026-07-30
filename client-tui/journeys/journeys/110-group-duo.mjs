/**
 * Groups, two sessions — invite prose, per-observer countdown invite,
 * symmetric AOI-joined rosters, leave → cross-observer dissolution.
 */
export default async function groupDuo({ session, actorId, check }) {
  const a = session({ actorId: actorId("a"), displayName: "GateMarlow", spawnX: 514, spawnY: 514 });
  const b = session({ actorId: actorId("b"), displayName: "GatePetra", spawnX: 514, spawnY: 514 });
  await a.expect(/Signal locked/);
  await b.expect(/Signal locked/);
  await a.idle(1200); // AOI settle — B must enter A's scope before the invite resolves
  await a.say("/group", /You walk alone\./);
  let invited = false;
  for (let attempt = 0; attempt < 4 && !invited; attempt += 1) {
    const result = await a.say("/group invite gatepetra", /wave them over|No one in scope answers/);
    invited = result.line.includes("wave them over");
    if (!invited) await a.idle(1200);
  }
  check("invite resolves the partner from AOI", invited);
  let invite = null;
  for (let attempt = 0; attempt < 5 && !invite; attempt += 1) {
    const poll = await b.say("/group", /wants you in their crew — \/group accept or \/group decline \((\d+)s\)|You walk alone\./);
    if (poll.line.includes("wants you in their crew")) invite = poll;
    else await b.idle(900); // the invite frame rides the next delta
  }
  check("invite frame streams to the invitee", invite !== null);
  if (!invite) return;
  check(`pending invite counts down live (${invite.match[1]}s)`, Number(invite.match[1]) > 0 && Number(invite.match[1]) <= 30);
  await b.say("/group accept", /fall in together/);
  await a.idle(700); // membership frame rides the next delta
  await a.say("/group", /Your crew \(2\):/);
  await a.expect(/★ GateMarlow\s+H\s+\d+%\s+you/);
  const petraRow = await a.expect(/· GatePetra\s+H\s+\d+%\s+(\S+ \d+c|out of scope|another area)/);
  check("member row carries AOI-joined position", petraRow.line.length > 0);
  await b.say("/group", /Your crew \(2\):/);
  await b.expect(/★ GateMarlow/);
  await b.say("/group leave", /peel away from the crew/);
  let alone = false;
  for (let attempt = 0; attempt < 5 && !alone; attempt += 1) {
    const poll = await a.say("/group", /You walk alone\.|Your crew \(2\):/);
    alone = poll.line.includes("walk alone");
    if (!alone) await a.idle(900); // the leave frame rides the next delta
  }
  check("dissolution propagated cross-observer", alone);
}
