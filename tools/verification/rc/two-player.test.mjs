import test from "node:test";
import assert from "node:assert/strict";
import { runTwoPlayerEntryProof, createInstrumentedTransport, managedSessionName, csrfHeaders, assertPlayTicketCharacter, planTrainerCloneExitRoute, planTrainerInteriorRoute, stopManagedSessions, classifySuccessfulParentMacroResponse, applySuccessfulParentMacroResponse, observeSuccessfulParentMacroResponse, waitForProofPredicate, ensureActiveAccountSessionForCleanup, sanitizeCleanupError, EntryProofFailure, evaluateParentPlayLaunchActivation, decideParentPlayEnterRetry } from "./two-player.mjs";

// Runnable real-browser preflight against a supplied stack:
//   node --input-type=module -e 'import { startLocalStack } from "./stack.mjs"; import { runTwoPlayerEntryProof } from "./two-player.mjs"; const runRoot=process.env.RC_RUN_ROOT; const stack=await startLocalStack({repoRoot:process.cwd(),runRoot,sha:process.env.RC_SHA,signal:undefined,onEvent:console.log}); try { console.log(await runTwoPlayerEntryProof({stack,runRoot,onEvent:console.log})); } finally { await stack.stop(); }'
// RC_RUN_ROOT and RC_SHA are deliberately caller-supplied. Missing runtime
// selectors remain INCOMPLETE; this preflight never invents a fixture or PASS.

test("three-player contract keeps one barrier-synchronized causal journey", async () => {
  const trace = [];
  const stack = { transport: createInstrumentedTransport(trace) };
  const events = [];
  const result = await runTwoPlayerEntryProof({ stack, runRoot: "/run/rc-proof-contract", onEvent: (event) => events.push(event) });
  for (const gate of ["register", "creatorHandshake", "creatorCreate", "logoutLogin", "roster", "pointerBeforeTicket", "clientReadyLaunch", "playStageDesktop", "worldReady", "tuiWorldReady", "sharedWorld", "hostedMacros", "equipmentAuthority", "equipmentDoll", "equipmentPawn", "chatOwnership", "linkDeadSet", "linkDeadCleared", "trainerReject", "trainerSuccess", "cleanup"]) assert.equal(result.gates[gate], "pass", gate);
  assert.deepEqual(result.aliases, { p1: "p1", p2: "p2", p3: "p3" });
  assert.ok(events.every((event) => typeof event.atMs === "number" && event.atMs >= 0));
  assert.ok(trace.indexOf("p1:register") < trace.indexOf("p1:creator"));
  assert.ok(trace.indexOf("p2:register") < trace.indexOf("p2:creator"));
  assert.ok(trace.indexOf("p3:register") < trace.indexOf("p3:creator"));
  assert.ok(trace.indexOf("p1:creator") < trace.indexOf("p1:logout-login"));
  assert.ok(trace.indexOf("p1:logout-login") < trace.indexOf("p1:roster"));
  assert.ok(trace.indexOf("p1:shared") < trace.indexOf("p1:hosted-macros"));
  assert.ok(trace.indexOf("p1:hosted-macros") < trace.indexOf("p1:equipment"));
  for (const alias of ["p1", "p2", "p3"]) assert.ok(trace.includes(`${alias}:cleanup`), `${alias} cleanup`);
  assert.equal(trace.at(-1), "close");
  const logoutEvents = events.filter((event) => event.type === "logout.login");
  assert.equal(logoutEvents.length, 3);
  assert.ok(logoutEvents.every((event) => event.loggedOut === true && event.loggedIn === true && event.rosterPresent === true && event.selected === true && event.enterEnabled === true));
  assert.ok(logoutEvents.every((event) => !("callsign" in event) && !("password" in event) && !("characterId" in event)));
  const macroEvents = events.filter((event) => event.type === "hosted.macros");
  assert.equal(macroEvents.length, 1);
  assert.equal(macroEvents[0].saved, true);
  assert.equal(macroEvents[0].deleted, true);
  assert.equal(macroEvents[0].parentPost, true);
  assert.equal(macroEvents[0].parentDelete, true);
  assert.equal(macroEvents[0].versionAdvanced, true);
  assert.equal(macroEvents[0].listCountAfterSave, 1);
  assert.equal(macroEvents[0].listCountAfterDelete, 0);
  assert.equal(macroEvents[0].versionAfterSave, 2);
  assert.equal(macroEvents[0].versionAfterDelete, 3);
  assert.ok(!("name" in macroEvents[0]) && !("body" in macroEvents[0]) && !("id" in macroEvents[0]) && !("url" in macroEvents[0]));
});

test("missing runtime probe is explicit incomplete, never a pass", async () => {
  const transport = createInstrumentedTransport([]);
  transport.players = () => {
    const players = transport.__players ?? (transport.__players = []);
    if (players.length === 0) {
      for (const player of createInstrumentedTransport([]).players()) {
        const stage = player.measureStage;
        player.measureStage = async (...args) => ({ ...(await stage(...args)), probeAvailable: false });
        players.push(player);
      }
    }
    return players;
  };
  const result = await runTwoPlayerEntryProof({ stack: { transport }, runRoot: "/run/rc-proof-contract" });
  assert.equal(result.gates.creatorStageDesktop, "incomplete");
  assert.notEqual(result.gates.creatorStageDesktop, "pass");
});

test("ticket and launch ordering failures stop the journey", async () => {
  const transport = createInstrumentedTransport([]);
  const originalPlayers = transport.players();
  for (const player of originalPlayers) {
    const roster = player.rosterEnter;
    player.rosterEnter = async (...args) => ({ ...(await roster(...args)), pointerBeforeTicket: false });
  }
  transport.players = () => originalPlayers;
  const result = await runTwoPlayerEntryProof({ stack: { transport }, runRoot: "/run/rc-proof-contract" });
  assert.equal(result.gates.pointerBeforeTicket, "fail");
  assert.notEqual(result.gates.clientReadyLaunch, "pass");
});

test("isolated projections cannot pass three-player shared-world gate", async () => {
  const transport = createInstrumentedTransport([]);
  const players = transport.players();
  assert.equal(players.length, 3);
  for (const player of players) {
    const roster = player.rosterEnter;
    player.rosterEnter = async (...args) => {
      const result = await roster(...args);
      return { ...result, visibleActorKeys: [result.runtimeActorKey] };
    };
    player.observeSharedWorld = async () => ({ probeAvailable: true, mutualProjection: false });
  }
  transport.players = () => players;
  const result = await runTwoPlayerEntryProof({ stack: { transport }, runRoot: "/run/rc-proof-contract" });
  assert.equal(result.gates.sharedWorld, "fail");
  assert.notEqual(result.gates.hostedMacros, "pass");
  assert.notEqual(result.gates.equipmentAuthority, "pass");
});

test("logout/login failure is fail-closed before roster entry", async () => {
  const transport = createInstrumentedTransport([]);
  const players = transport.players();
  for (const player of players) {
    player.logoutLogin = async () => ({ probeAvailable: true, loggedOut: true, loggedIn: true, rosterPresent: false, selected: false, enterEnabled: false });
  }
  transport.players = () => players;
  const result = await runTwoPlayerEntryProof({ stack: { transport }, runRoot: "/run/rc-proof-contract" });
  assert.equal(result.gates.logoutLogin, "fail");
  assert.notEqual(result.gates.roster, "pass");
  assert.notEqual(result.gates.sharedWorld, "pass");
});

test("hosted macro CRUD failure stops before equipment", async () => {
  const transport = createInstrumentedTransport([]);
  const players = transport.players();
  const p1 = players.find((player) => player.alias === "p1");
  p1.hostedMacroCrud = async () => ({ probeAvailable: true, saved: true, deleted: false, parentPost: true, parentDelete: false, versionAdvanced: false, listCountAfterSave: 1, listCountAfterDelete: 1, versionAfterSave: 2, versionAfterDelete: 2 });
  transport.players = () => players;
  const result = await runTwoPlayerEntryProof({ stack: { transport }, runRoot: "/run/rc-proof-contract" });
  assert.equal(result.gates.hostedMacros, "fail");
  assert.equal(result.gates.sharedWorld, "pass");
  assert.notEqual(result.gates.equipmentAuthority, "pass");
});

test("three-player cleanup marks every account actor", async () => {
  const trace = [];
  const transport = createInstrumentedTransport(trace);
  await runTwoPlayerEntryProof({ stack: { transport }, runRoot: "/run/rc-proof-contract" });
  assert.deepEqual(
    trace.filter((entry) => entry.endsWith(":cleanup")),
    ["p1:cleanup", "p2:cleanup", "p3:cleanup"],
  );
  assert.equal(trace.at(-1), "close");
});

test("managed browser session names stay inside launcher contract", () => {
  const name = managedSessionName("rc-20260726T052901Z-913988-151", "p1");
  assert.match(name, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u);
  assert.ok(name.length <= 32);
  assert.ok(name.endsWith("-p1"));
});


test("browser launch mutation requires the exact in-memory CSRF header", () => {
  assert.deepEqual(csrfHeaders("csrf-value"), { "content-type": "application/json", "x-csrf-token": "csrf-value" });
  assert.throws(() => csrfHeaders(""), /csrf token unavailable/u);
});


test("play-ticket character must equal the requested created character", () => {
  assert.equal(assertPlayTicketCharacter("created-character", { characterId: "created-character" }), true);
  assert.throws(() => assertPlayTicketCharacter("created-character", { characterId: "other-character" }), /character/u);
});

test("parent play launch activation fails closed for wrong selection, disabled, and unfocused submit", () => {
  const ready = {
    optionMatchCount: 1,
    selectedMatches: true,
    formBound: true,
    submitEnabled: true,
    submitVisible: true,
    activeIsSubmit: true,
  };
  assert.deepEqual(evaluateParentPlayLaunchActivation(ready), {
    ok: true,
    reason: "ready",
    selectedMatches: true,
    formBound: true,
    submitEnabled: true,
    submitVisible: true,
    activeIsSubmit: true,
  });

  assert.equal(evaluateParentPlayLaunchActivation({ ...ready, optionMatchCount: 0 }).reason, "missing-character-option");
  assert.equal(evaluateParentPlayLaunchActivation({ ...ready, optionMatchCount: 2 }).reason, "duplicate-character-option");
  assert.equal(evaluateParentPlayLaunchActivation({ ...ready, selectedMatches: false }).reason, "wrong-character-selected");
  assert.equal(evaluateParentPlayLaunchActivation({ ...ready, formBound: false }).reason, "launch-form-unbound");
  assert.equal(evaluateParentPlayLaunchActivation({ ...ready, submitVisible: false }).reason, "submit-not-visible");
  assert.equal(evaluateParentPlayLaunchActivation({ ...ready, submitEnabled: false }).reason, "submit-disabled");
  assert.equal(evaluateParentPlayLaunchActivation({ ...ready, activeIsSubmit: false }).reason, "submit-unfocused");
  assert.equal(evaluateParentPlayLaunchActivation({ ...ready, activeIsSubmit: false }).ok, false);
  // Reasons stay non-sensitive enums only.
  for (const reason of [
    "missing-character-option",
    "duplicate-character-option",
    "wrong-character-selected",
    "launch-form-unbound",
    "submit-not-visible",
    "submit-disabled",
    "submit-unfocused",
  ]) {
    assert.match(reason, /^[a-z-]+$/u);
  }
});

test("parent play enter retry disposition allows one no-request retry then fails closed", () => {
  assert.deepEqual(
    decideParentPlayEnterRetry({ attempt: 1, maxAttempts: 2, sawPointer: false, sawTicket: false }),
    { action: "retry", reason: "no-launch-request" },
  );
  assert.deepEqual(
    decideParentPlayEnterRetry({ attempt: 2, maxAttempts: 2, sawPointer: false, sawTicket: false }),
    { action: "fail", reason: "no-launch-request" },
  );
  assert.deepEqual(
    decideParentPlayEnterRetry({ attempt: 1, maxAttempts: 2, sawPointer: true, sawTicket: false }),
    { action: "continue", reason: "pointer-observed" },
  );
  assert.deepEqual(
    decideParentPlayEnterRetry({ attempt: 1, maxAttempts: 2, sawPointer: false, sawTicket: true }),
    { action: "continue", reason: "ticket-observed" },
  );
  // Ticket alone still continues into existing pointer-before-ticket fail-closed path.
  assert.equal(decideParentPlayEnterRetry({ attempt: 2, sawPointer: true, sawTicket: true }).action, "continue");
  assert.equal(decideParentPlayEnterRetry({ attempt: 1, sawPointer: true }).action, "continue");
});


test("managed browser cleanup retries and detects survivors", async () => {
  const calls = [];
  const command = (argv) => { calls.push(argv); return argv[0] === "stop" ? { status: 1 } : { status: 0, stdout: JSON.stringify({ sessions: [{ name: "rc-p1" }] }) }; };
  await assert.rejects(stopManagedSessions(["rc-p1"], command, async () => {}), /survivors/u);
  assert.equal(calls.filter(([verb]) => verb === "stop").length, 12);
});

function fakeMacroResponse({ url, method = "POST", status = 200, frame = "main", mainFrame = null } = {}) {
  const sharedMain = mainFrame ?? { id: "main" };
  const iframe = { id: "iframe" };
  const requestFrame = frame === "main" ? sharedMain : iframe;
  return {
    response: {
      url: () => url,
      status: () => status,
      request: () => ({
        method: () => method,
        frame: () => requestFrame,
      }),
    },
    mainFrame: sharedMain,
  };
}

test("parent macro response classification accepts only successful main-frame character macros mutations", () => {
  const siteOrigin = "https://rc.example.test";
  const okPost = fakeMacroResponse({
    url: `${siteOrigin}/alpha-api/characters/char-1/macros`,
    method: "POST",
    status: 200,
    frame: "main",
  });
  const okDelete = fakeMacroResponse({
    url: `${siteOrigin}/alpha-api/characters/char-1/macros/macro-1`,
    method: "DELETE",
    status: 204,
    frame: "main",
  });
  assert.equal(classifySuccessfulParentMacroResponse(okPost.response, { siteOrigin, mainFrame: okPost.mainFrame }), "post");
  assert.equal(classifySuccessfulParentMacroResponse(okDelete.response, { siteOrigin, mainFrame: okDelete.mainFrame }), "delete");

  const counts = { post: 0, delete: 0 };
  assert.equal(applySuccessfulParentMacroResponse(counts, okPost.response, { siteOrigin, mainFrame: okPost.mainFrame }), "post");
  assert.equal(applySuccessfulParentMacroResponse(counts, okDelete.response, { siteOrigin, mainFrame: okDelete.mainFrame }), "delete");
  assert.deepEqual(counts, { post: 1, delete: 1 });
});

test("parent macro response classification rejects failed, foreign, iframe, wrong-method, and neighbor paths", () => {
  const siteOrigin = "https://rc.example.test";
  // Share one mainFrame object so status/method/path rejections are not accidental reference mismatches.
  const mainFrame = { id: "shared-main" };

  const cases = [
    fakeMacroResponse({ url: `${siteOrigin}/alpha-api/characters/char-1/macros`, method: "POST", status: 403, frame: "main", mainFrame }),
    fakeMacroResponse({ url: `${siteOrigin}/alpha-api/characters/char-1/macros`, method: "POST", status: 500, frame: "main", mainFrame }),
    fakeMacroResponse({ url: "https://evil.example/alpha-api/characters/char-1/macros", method: "POST", status: 200, frame: "main", mainFrame }),
    fakeMacroResponse({ url: `${siteOrigin}/alpha-api/characters/char-1/macros`, method: "POST", status: 200, frame: "iframe", mainFrame }),
    fakeMacroResponse({ url: `${siteOrigin}/alpha-api/characters/char-1/macros`, method: "GET", status: 200, frame: "main", mainFrame }),
    fakeMacroResponse({ url: `${siteOrigin}/alpha-api/characters/char-1/macros/../settings`, method: "POST", status: 200, frame: "main", mainFrame }),
    fakeMacroResponse({ url: `${siteOrigin}/game/characters/char-1/macros`, method: "POST", status: 200, frame: "main", mainFrame }),
    fakeMacroResponse({ url: `${siteOrigin}/alpha-api/characters/char-1/macros-extra`, method: "POST", status: 200, frame: "main", mainFrame }),
  ];

  // Prove shared identity for the main-frame cases that should fail for other reasons.
  for (const sample of cases) {
    if (sample.response.request().frame() === mainFrame) {
      assert.equal(sample.mainFrame, mainFrame);
      assert.equal(sample.response.request().frame(), mainFrame);
    }
  }

  const counts = { post: 0, delete: 0 };
  for (const sample of cases) {
    assert.equal(classifySuccessfulParentMacroResponse(sample.response, { siteOrigin, mainFrame }), null);
    assert.equal(applySuccessfulParentMacroResponse(counts, sample.response, { siteOrigin, mainFrame }), null);
  }
  assert.deepEqual(counts, { post: 0, delete: 0 });

  // Control: identical path/method/frame with 2xx still counts when using the shared mainFrame.
  const ok = fakeMacroResponse({
    url: `${siteOrigin}/alpha-api/characters/char-1/macros`,
    method: "POST",
    status: 201,
    frame: "main",
    mainFrame,
  });
  assert.equal(classifySuccessfulParentMacroResponse(ok.response, { siteOrigin, mainFrame }), "post");
  assert.equal(applySuccessfulParentMacroResponse(counts, ok.response, { siteOrigin, mainFrame }), "post");
  assert.deepEqual(counts, { post: 1, delete: 0 });
});

test("parent macro response observer swallows mainFrame teardown throws", () => {
  const siteOrigin = "https://rc.example.test";
  const mainFrame = { id: "shared-main" };
  const ok = fakeMacroResponse({
    url: `${siteOrigin}/alpha-api/characters/char-1/macros`,
    method: "POST",
    status: 200,
    frame: "main",
    mainFrame,
  });
  const counts = { post: 0, delete: 0 };

  assert.equal(
    observeSuccessfulParentMacroResponse(counts, ok.response, {
      siteOrigin,
      page: {
        mainFrame() {
          throw new Error("Execution context was destroyed, most likely because of a navigation");
        },
      },
    }),
    null,
  );
  assert.deepEqual(counts, { post: 0, delete: 0 });

  assert.equal(
    observeSuccessfulParentMacroResponse(counts, ok.response, {
      siteOrigin,
      page: { mainFrame: () => mainFrame },
    }),
    "post",
  );
  assert.deepEqual(counts, { post: 1, delete: 0 });
});

test("hosted macro parent wait timeout attributes to hostedMacros, not observation", async () => {
  await assert.rejects(
    () => waitForProofPredicate(async () => false, "parent macro POST", 30, "hostedMacros"),
    (error) => {
      assert.equal(error instanceof EntryProofFailure, true);
      assert.equal(error.gate, "hostedMacros");
      assert.match(String(error.message), /parent macro POST/u);
      assert.notEqual(error.gate, "observation");
      return true;
    },
  );
});

test("logged-out cleanup re-logins through visible form before delete path", async () => {
  const actions = [];
  const password = "super-secret-cleanup-password-value";
  const callsign = "rcprivatecallsign99";
  let sessionState = "none";
  const locators = new Map();
  const page = {
    async goto(url, opts) {
      actions.push({ type: "goto", url, opts });
    },
    async waitForFunction(fn, _arg, _opts) {
      actions.push({ type: "waitForFunction" });
      // Helper only continues once session is active|none; keep none for re-login path.
      if (sessionState !== "active" && sessionState !== "none") sessionState = "none";
      return true;
    },
    async evaluate(fn) {
      actions.push({ type: "evaluate" });
      // emulate body dataset read used by helper
      return sessionState;
    },
    locator(selector) {
      if (!locators.has(selector)) {
        const fills = [];
        locators.set(selector, {
          fills,
          async waitFor() { actions.push({ type: "waitFor", selector }); },
          async fill(value) {
            fills.push(value);
            actions.push({ type: "fill", selector, value });
          },
          async click() { actions.push({ type: "click", selector }); },
          async check() { actions.push({ type: "check", selector }); },
        });
      }
      return locators.get(selector);
    },
    waitForResponse(predicate) {
      actions.push({ type: "waitForResponse" });
      const response = {
        url: () => "https://rc.example.test/alpha-api/login",
        request: () => ({ method: () => "POST" }),
        status: () => 200,
      };
      assert.equal(predicate(response), true);
      return Promise.resolve(response);
    },
  };

  const result = await ensureActiveAccountSessionForCleanup(page, {
    siteUrl: "https://rc.example.test",
    callsign,
    password,
    alias: "p2",
  });
  assert.deepEqual(result, { relogin: true });
  assert.ok(actions.some((entry) => entry.type === "goto" && String(entry.url).endsWith("/account/")));
  assert.equal(locators.get("#login-callsign").fills.at(-1), callsign);
  assert.equal(locators.get("#login-password").fills.at(-1), password);
  assert.ok(actions.some((entry) => entry.type === "click" && entry.selector === "#login-form button[type=submit]"));
  assert.ok(actions.some((entry) => entry.type === "waitFor" && entry.selector === "body[data-session-state=active]"));
  assert.ok(!actions.some((entry) => /reg-/u.test(String(entry.selector ?? ""))));
  assert.ok(!JSON.stringify(actions).includes("register"));
});

test("cleanup failures scrub private callsign/password from thrown errors", () => {
  const password = "super-secret-cleanup-password-value";
  const callsign = "rcprivatecallsign99";
  const error = sanitizeCleanupError(
    new Error(`login failed for ${callsign} with ${password}`),
    "p1",
  );
  assert.match(error.message, /account cleanup login failed for p1/u);
  assert.ok(!error.message.includes(password));
  assert.ok(!error.message.includes(callsign));
});

test("planTrainerCloneExitRoute stages axis-separated clone exit without re-entry", () => {
  const interior = planTrainerCloneExitRoute({ x: 519, y: 503 });
  assert.deepEqual(interior.map((leg) => leg.step), [
    "clone-clear-left",
    "clone-entry",
    "clone-south-portal",
    "clone-south-lane",
    "commerce-south-lane",
    "door-approach",
  ]);
  assert.deepEqual(interior.map((leg) => [leg.x, leg.y]), [
    [516.8, 504.8],
    [518.5, 506],
    [518.5, 508.5],
    [518.5, 512],
    [506, 512],
    [506, 508],
  ]);
  assert.deepEqual(interior[0].axisOrder, ["x", "y"]);
  assert.equal(interior[0].drive, undefined);
  assert.deepEqual(interior[1].axisOrder, ["y", "x"]);
  assert.equal(interior[1].drive, "point");
  assert.ok(interior.findIndex((leg) => leg.step === "clone-clear-left")
    < interior.findIndex((leg) => leg.step === "clone-entry"));
  assert.ok(interior.filter((leg) => leg.step !== "clone-entry").every((leg) => leg.drive !== "point"));

  // RC exterior south-face spawn must not re-enter the facility.
  const exterior = planTrainerCloneExitRoute({ x: 519, y: 513.38 });
  assert.deepEqual(exterior.map((leg) => leg.step), [
    "clone-south-lane",
    "commerce-south-lane",
    "door-approach",
  ]);
  assert.ok(exterior.every((leg) => leg.y >= 508));
  assert.equal(exterior[0].axisOrder[0], "y");

  assert.deepEqual(planTrainerCloneExitRoute({ x: 506, y: 508 }), []);
  assert.deepEqual(planTrainerCloneExitRoute({ x: 510.6, y: 503 }), []);
});

test("planTrainerInteriorRoute plans axis-separated collision-avoiding route north then east", () => {
  const route = planTrainerInteriorRoute({ x: 506, y: 508 });
  assert.deepEqual(route.map((leg) => leg.step), [
    "trainer-north-corridor",
    "trainer-stand-approach",
  ]);
  assert.deepEqual(route.map((leg) => [leg.x, leg.y]), [
    [506, 503.0],
    [510.6, 503.0],
  ]);
  assert.deepEqual(route[0].axisOrder, ["y", "x"]);
  assert.deepEqual(route[1].axisOrder, ["x", "y"]);
  assert.ok(route[0].tolerance >= 0.35 && route[0].tolerance <= 0.4);
  assert.ok(route[1].tolerance >= 0.35 && route[1].tolerance <= 0.4);
  assert.equal(route[0].drive, undefined);
  assert.equal(route[1].drive, undefined);

  // Assert pure axis-separated movement (no diagonal drive)
  assert.deepEqual(route[0].axisOrder[0], "y");
  assert.deepEqual(route[1].axisOrder[0], "x");

  const northOnly = planTrainerInteriorRoute({ x: 506, y: 503 });
  assert.deepEqual(northOnly.map((leg) => leg.step), ["trainer-stand-approach"]);
  assert.deepEqual([northOnly[0].x, northOnly[0].y], [510.6, 503.0]);

  const atStand = planTrainerInteriorRoute({ x: 510.6, y: 503.0 });
  assert.deepEqual(atStand, []);
});

