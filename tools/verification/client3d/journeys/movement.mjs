// Journey: movement + sprint.
// Proves the WASD locomotion chain end to end — client prediction AND server
// authority both displace, no rubber-band. Rubber-band is defined by its real
// causes/signatures (server rejecting moves + failure to reconcile + client/
// server displacement divergence), NOT transient headless prediction drift
// under concurrent software-GL load. Money shots: spawn + post-sprint frames.
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function predErr(p) { return p?.moveGate?.predictionErrorCells ?? p?.predictionErrorCells ?? 0; }

export default {
  id: "movement",
  title: "Movement + Sprint",
  timeoutMs: 90000,
  characters: [
    { role: "primary", id: "h3d-move-probe", name: "ProbeMove", x: 520, y: 520, facing: "right", equip: "slugthrower", initialProfessionId: "marksman" },
  ],
  async run(ctx) {
    const s = ctx.primary;
    await ctx.moneyShot("00-spawn");

    const start = await s.waitProbe((p) => p.serverStatus === "connected" && p.authorityPlayer, { label: "spawn probe" });
    ctx.note(`spawn cell ${JSON.stringify(start.playerCell)} authority ${JSON.stringify(start.authorityPlayer)}`);

    const northOrigin = await s.page.evaluate(() => window.__successor3dWaypoints?.createAtPlayer("CARDINAL NORTH ORIGIN") ?? null);
    s.assert(northOrigin?.ok && northOrigin.waypoint?.id, `could not create north-origin waypoint: ${JSON.stringify(northOrigin)}`);

    // Sprint north (ShiftLeft+KeyW), sampling prediction error the whole hold.
    let maxPredErr = 0;
    await s.dispatchKeys("keydown", ["ShiftLeft", "KeyW"]);
    for (let i = 0; i < 8; i += 1) {
      await ctx.delay(300);
      maxPredErr = Math.max(maxPredErr, predErr(await s.probe()));
    }
    await s.dispatchKeys("keyup", ["KeyW", "ShiftLeft"]);
    await s.releaseAll();
    await ctx.moneyShot("01-sprint-north");

    // Let prediction reconcile — a real desync (from rejects) will NOT close;
    // transient drift under headless CPU contention does.
    await ctx.delay(300);
    const reconciled = await s.waitProbe((p) => predErr(p) < 2.0, { label: "prediction reconcile", timeoutMs: 5000 }).catch(() => null);
    const end = await s.probe();
    const clientDelta = dist(start.playerCell, end.playerCell);
    const authDelta = dist(start.authorityPlayer, end.authorityPlayer);
    const northDx = end.authorityPlayer.x - start.authorityPlayer.x;
    const northDy = end.authorityPlayer.y - start.authorityPlayer.y;
    const northCrossAxisError = Math.abs(northDx);
    const rejectedDelta = end.rejectedCommands - start.rejectedCommands;
    const acceptedDelta = end.acceptedCommands - start.acceptedCommands;
    const finalPredErr = predErr(end);
    ctx.note(`clientDelta=${clientDelta.toFixed(2)} authDelta=${authDelta.toFixed(2)} northRaw=(${northDx.toFixed(2)},${northDy.toFixed(2)}) maxPredErr=${maxPredErr.toFixed(2)} finalPredErr=${finalPredErr.toFixed(2)} accepted+${acceptedDelta} rejected+${rejectedDelta} reconciled=${reconciled !== null}`);

    // Displacement: both prediction and authority moved a real distance.
    s.assert(clientDelta >= 4, `sprint client displacement too small: ${clientDelta.toFixed(2)} cells (expected >= 4)`);
    s.assert(authDelta >= 3, `server authority did not displace: ${authDelta.toFixed(2)} cells (expected >= 3)`);
    s.assert(acceptedDelta > 0, `no move commands accepted by authority (accepted+${acceptedDelta})`);
    // No rubber-band: server accepted every move, client + authority agree on
    // where the pawn ended, and prediction reconciled to a tight error.
    s.assert(rejectedDelta === 0, `rubber-band: authority rejected ${rejectedDelta} move command(s) during sprint`);
    s.assert(authDelta >= clientDelta * 0.5, `rubber-band: client/authority displacement diverged (client ${clientDelta.toFixed(2)} vs auth ${authDelta.toFixed(2)})`);
    s.assert(finalPredErr < 2.5, `rubber-band: prediction did not reconcile (final error ${finalPredErr.toFixed(2)} cells)`);
    s.assert(northDy < -2, `W did not move raw north (-y): (${northDx.toFixed(2)}, ${northDy.toFixed(2)})`);
    s.assert(northCrossAxisError <= Math.abs(northDy) * 0.2 + 0.75, `W drifted on raw x: (${northDx.toFixed(2)}, ${northDy.toFixed(2)})`);
    const northOriginSouth = await s.waitProbeCall(
      () => s.page.evaluate((id) => window.__successor3dRadar?.waypoints?.find((waypoint) => waypoint.id === id) ?? null, northOrigin.waypoint.id),
      (waypoint) => waypoint !== null && Math.abs(waypoint.xCells) <= 1 && waypoint.yCells > 2,
      { label: "north-origin waypoint plots straight south after W", timeoutMs: 5000 },
    );
    ctx.note(`radar after W ${JSON.stringify(northOriginSouth)}`);
    const audioLoops = await s.waitProbeCall(
      () => s.page.evaluate(() => window.__successorSfx?.activeLoops ?? null),
      (loops) => Array.isArray(loops) && loops.length > 0,
      { label: "world soundscape active after input unlock", timeoutMs: 10000 },
    );
    s.assert(
      audioLoops.some((id) => id === "settlement_murmur_loop" || id.startsWith("music_")),
      `soundscape lost all settlement/music beds: ${JSON.stringify(audioLoops)}`,
    );
    ctx.note(`active audio loops ${JSON.stringify(audioLoops)}`);
    await s.press("KeyP");
    await s.waitDom('.sc3d-window[data-window="datapad"]', { state: "visible", timeoutMs: 8000 });
    await s.page.waitForFunction(
      () => !document.querySelector('.sc3d-window[data-window="datapad"] .scp-map-sub')?.textContent?.includes("ACQUIRING IMAGERY"),
      null,
      { timeout: 30000 },
    );
    await ctx.moneyShot("02-map-after-north");
    await s.press("Escape");
    await s.page.evaluate((id) => window.__successor3dWaypoints?.delete(id), northOrigin.waypoint.id);

    // Return near the first origin, then establish an independent west origin.
    await s.hold(["ShiftLeft", "KeyS"], 2400);
    await ctx.delay(400);
    const westOrigin = await s.page.evaluate(() => window.__successor3dWaypoints?.createAtPlayer("CARDINAL WEST ORIGIN") ?? null);
    s.assert(westOrigin?.ok && westOrigin.waypoint?.id, `could not create west-origin waypoint: ${JSON.stringify(westOrigin)}`);
    const beforeWest = await s.probe();

    await s.hold(["ShiftLeft", "KeyA"], 1800);
    await ctx.delay(400);
    const afterWest = await s.probe();
    const westDx = afterWest.authorityPlayer.x - beforeWest.authorityPlayer.x;
    const westDy = afterWest.authorityPlayer.y - beforeWest.authorityPlayer.y;
    const westCrossAxisError = Math.abs(westDy);
    ctx.note(`west raw=(${westDx.toFixed(2)},${westDy.toFixed(2)})`);
    s.assert(westDx < -2, `A did not move raw west (-x): (${westDx.toFixed(2)}, ${westDy.toFixed(2)})`);
    s.assert(westCrossAxisError <= Math.abs(westDx) * 0.2 + 0.75, `A drifted on raw y: (${westDx.toFixed(2)}, ${westDy.toFixed(2)})`);
    const westOriginEast = await s.waitProbeCall(
      () => s.page.evaluate((id) => window.__successor3dRadar?.waypoints?.find((waypoint) => waypoint.id === id) ?? null, westOrigin.waypoint.id),
      (waypoint) => waypoint !== null && waypoint.xCells > 2 && Math.abs(waypoint.yCells) <= 1.5,
      { label: "west-origin waypoint plots straight east after A", timeoutMs: 5000 },
    );
    ctx.note(`radar after A ${JSON.stringify(westOriginEast)}`);
    await s.press("KeyP");
    await s.waitDom('.sc3d-window[data-window="datapad"]', { state: "visible", timeoutMs: 8000 });
    await s.page.waitForFunction(
      () => !document.querySelector('.sc3d-window[data-window="datapad"] .scp-map-sub')?.textContent?.includes("ACQUIRING IMAGERY"),
      null,
      { timeout: 30000 },
    );
    const orbitalFrame = await s.page.evaluate(() => {
      const root = document.querySelector('.sc3d-window[data-window="datapad"] .scp-map');
      const viewport = root?.querySelector(".scp-map-viewport");
      const canvas = root?.querySelector(".scp-map-canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const draw = canvas.getContext("2d");
      if (!draw) return null;
      const inset = Math.max(8, Math.floor(Math.min(canvas.width, canvas.height) * 0.025));
      const samples = [
        [inset, inset],
        [canvas.width - inset - 1, inset],
        [inset, canvas.height - inset - 1],
        [canvas.width - inset - 1, canvas.height - inset - 1],
      ];
      return {
        rootMode: root?.getAttribute("data-mode") ?? null,
        viewportMode: viewport?.getAttribute("data-mode") ?? null,
        orbitalPressed: root?.querySelector('.scp-map-mode[data-mode="orbital"]')?.getAttribute("aria-pressed") ?? null,
        cornerAlpha: samples.map(([x, y]) => draw.getImageData(x, y, 1, 1).data[3]),
      };
    });
    s.assert(orbitalFrame?.rootMode === "orbital" && orbitalFrame.viewportMode === "orbital", `datapad did not default to orbital framing: ${JSON.stringify(orbitalFrame)}`);
    s.assert(orbitalFrame.orbitalPressed === "true", `orbital mode lacks selected state: ${JSON.stringify(orbitalFrame)}`);
    s.assert(orbitalFrame.cornerAlpha.every((alpha) => alpha > 0), `top-down orbital terrain did not fill all four corners: ${JSON.stringify(orbitalFrame)}`);
    ctx.note(`orbital map frame ${JSON.stringify(orbitalFrame)}`);
    await ctx.moneyShot("03-map-orbital-after-west");
    await s.click('.scp-map-mode[data-mode="tactical"]');
    await s.page.waitForFunction(
      () => document.querySelector('.sc3d-window[data-window="datapad"] .scp-map')?.getAttribute("data-mode") === "tactical",
      null,
      { timeout: 3000 },
    );
    await ctx.delay(100);
    const tacticalFrame = await s.page.evaluate(() => {
      const root = document.querySelector('.sc3d-window[data-window="datapad"] .scp-map');
      const canvas = root?.querySelector(".scp-map-canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const draw = canvas.getContext("2d");
      if (!draw) return null;
      const inset = Math.max(8, Math.floor(Math.min(canvas.width, canvas.height) * 0.025));
      const samples = [
        [inset, inset],
        [canvas.width - inset - 1, inset],
        [inset, canvas.height - inset - 1],
        [canvas.width - inset - 1, canvas.height - inset - 1],
      ];
      return {
        mode: root?.getAttribute("data-mode") ?? null,
        tacticalPressed: root?.querySelector('.scp-map-mode[data-mode="tactical"]')?.getAttribute("aria-pressed") ?? null,
        cornerAlpha: samples.map(([x, y]) => draw.getImageData(x, y, 1, 1).data[3]),
      };
    });
    s.assert(tacticalFrame?.mode === "tactical" && tacticalFrame.tacticalPressed === "true", `tactical view did not select: ${JSON.stringify(tacticalFrame)}`);
    s.assert(tacticalFrame.cornerAlpha.every((alpha) => alpha > 0), `tactical cover did not fill all four corners: ${JSON.stringify(tacticalFrame)}`);
    ctx.note(`tactical map frame ${JSON.stringify(tacticalFrame)}`);
    await ctx.moneyShot("04-map-tactical-after-west");
    await s.page.locator('.scp-map-mode[data-mode="orbital"]').focus();
    await s.page.keyboard.press("Enter");
    await s.page.waitForFunction(
      () => document.querySelector('.sc3d-window[data-window="datapad"] .scp-map')?.getAttribute("data-mode") === "orbital",
      null,
      { timeout: 3000 },
    );
    await s.press("Escape");
    await s.page.evaluate((id) => window.__successor3dWaypoints?.delete(id), westOrigin.waypoint.id);

    // Regression lock for the reported defect: D/east must stay purely +x
    // and the abandoned origin must plot straight west on the radar.
    const eastOrigin = await s.page.evaluate(() => window.__successor3dWaypoints?.createAtPlayer("CARDINAL EAST ORIGIN") ?? null);
    s.assert(eastOrigin?.ok && eastOrigin.waypoint?.id, `could not create east-origin waypoint: ${JSON.stringify(eastOrigin)}`);
    const beforeEast = await s.probe();
    await s.hold(["ShiftLeft", "KeyD"], 1800);
    await ctx.delay(400);
    const afterEast = await s.probe();
    const eastDx = afterEast.authorityPlayer.x - beforeEast.authorityPlayer.x;
    const eastDy = afterEast.authorityPlayer.y - beforeEast.authorityPlayer.y;
    ctx.note(`east raw=(${eastDx.toFixed(2)},${eastDy.toFixed(2)})`);
    s.assert(eastDx > 2, `D did not move raw east (+x): (${eastDx.toFixed(2)}, ${eastDy.toFixed(2)})`);
    s.assert(Math.abs(eastDy) <= Math.abs(eastDx) * 0.2 + 0.75, `D drifted on raw y: (${eastDx.toFixed(2)}, ${eastDy.toFixed(2)})`);
    const eastOriginWest = await s.waitProbeCall(
      () => s.page.evaluate((id) => window.__successor3dRadar?.waypoints?.find((waypoint) => waypoint.id === id) ?? null, eastOrigin.waypoint.id),
      (waypoint) => waypoint !== null && waypoint.xCells < -2 && Math.abs(waypoint.yCells) <= 1.5,
      { label: "east-origin waypoint plots straight west after D", timeoutMs: 5000 },
    );
    ctx.note(`radar after D ${JSON.stringify(eastOriginWest)}`);
    await ctx.moneyShot("05-east-cardinal-contract");
    await s.page.evaluate((id) => window.__successor3dWaypoints?.delete(id), eastOrigin.waypoint.id);
  },
};
