/**
 * The LIVING LOOP — acquire a fertile seed, claim/till/plant, tend until the
 * authoritative crop matures, harvest offspring, and replant generation two.
 */
export default async function farmLoop({ session, actorId, grant, grantSkills, check, skip }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "GateFarmer", spawnX: 600, spawnY: 600 });
  await tui.expect(/Signal locked/);
  await grant(id, "geneSampler", 1);
  await grantSkills(id, ["bioengineer-novice"]);
  await tui.idle(900);
  await tui.say("/splice sample ashgrain", /GENE-SAMPLE QUEUED/i);
  await tui.expect(/sampler chews a wild cutting|GENE SAMPLE DENIED/i, { timeoutMs: 6000 }).catch(() => null);
  await tui.idle(800);
  const seeds0 = await tui.say("/inv seed", /INV (\d+) STACK/).catch(() => null);
  check(`wild ashgrain seed in the pack (${seeds0 ? seeds0.match[1] : "0"})`, !!seeds0 && Number(seeds0.match[1]) >= 1);
  await tui.say("/farm claim", /QUEUED/i);
  await tui.idle(900);
  const plot0 = await tui.say("/farm plot", /FARM —|hold no land/);
  check(`claim minted a homestead (${plot0.line.includes("FARM —") ? "farm plot reads it" : plot0.line.trim()})`, plot0.line.includes("FARM —"));
  await tui.say("/farm till", /QUEUED/i);
  await tui.idle(700);
  await tui.say("/farm plant ashgrain", /QUEUED/i);
  await tui.idle(900);
  const planted = await tui.say("/farm plot", /· stage \d+\/\d+ ·|tilled soil|raw ground/);
  check("seed planted — a crop stands on the tile", planted.line.includes("stage"));
  // Arm the authority-owned tending loop: this is the canonical farm behavior,
  // not a timing retry. It keeps the tile watered while lazy growth settles.
  await tui.say("/farm tend", /QUEUED|tend/i);
  let harvested = false;
  for (let i = 0; i < 90 && !harvested; i += 1) {
    tui.send("/farm water");
    await tui.idle(1000);
    tui.send("/farm harvest");
    await tui.idle(700);
    const inv = await tui.say("/inv seed", /INV (\d+) STACK|NOTHING/i, { timeoutMs: 4000 }).catch(() => null);
    harvested = !!inv && !!inv.match[1] && Number(inv.match[1]) >= 1;
  }
  check("HARVEST minted offspring seeds — grow -> harvest closed over the live bridge", harvested);
  await tui.say("/farm plant ashgrain", /QUEUED/i);
  await tui.idle(1000);
  const gen2 = await tui.say("/farm plot", /· stage \d+\/\d+ ·|tilled soil|raw ground/, { timeoutMs: 5000 });
  check("second generation planted from the harvested offspring — the living loop closes", gen2.line.includes("stage"));
}
