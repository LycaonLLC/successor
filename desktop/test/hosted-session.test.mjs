import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCredentialStore, credentialFilePath } from "../src/credential-store.mjs";
import { createHostedSession } from "../src/hosted-session.mjs";
import { createLaunchHandoff } from "../src/hosted-bridge.mjs";

const CREDENTIAL = "credential-0123456789abcdef0123";
const DEVICE_CODE = "device-code-0123456789abcdef0123";
const USER_CODE = "ABCD2EFGH3";
const GAME_TICKET = "game-ticket-0123456789abcdef";
const CHAT_TICKET = "chat-ticket-0123456789abcdef";
const SECRETS = [CREDENTIAL, DEVICE_CODE, GAME_TICKET, CHAT_TICKET];

function startFakeApi({ approveAfterPolls = 1, characters } = {}) {
  const state = {
    polls: 0,
    decision: null,
    exchanged: false,
    revoked: false,
    characters: characters ?? [
      { id: "char-1", name: "Bountyscout", initialProfessionId: "medic", worldEntryClaimed: true },
      { id: "char-2", name: "Dustcaller", initialProfessionId: null, worldEntryClaimed: false },
    ],
    requests: [],
    ticketMints: 0,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      state.requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization ?? null });
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/alpha-api/device/start") {
        return send(201, {
          authorizationId: "auth_1",
          deviceCode: DEVICE_CODE,
          userCode: USER_CODE,
          expiresAt: Date.now() + 600_000,
          pollIntervalMs: 5000,
          scopes: ["character:list", "play-ticket"],
        });
      }
      if (req.method === "POST" && req.url === "/alpha-api/device/poll") {
        if (JSON.parse(body).deviceCode !== DEVICE_CODE) return send(404, { error: "device_not_found" });
        state.polls += 1;
        if (state.decision) return send(200, { status: state.decision });
        if (state.polls <= approveAfterPolls) return send(200, { status: "pending" });
        if (state.exchanged) return send(200, { status: "exchanged" });
        state.exchanged = true;
        return send(200, { status: "exchanged", credential: CREDENTIAL, scopes: ["character:list", "play-ticket"] });
      }
      if (req.url === "/alpha-api/characters") {
        if (state.revoked || req.headers.authorization !== `Bearer ${CREDENTIAL}`) return send(401, { error: "invalid_auth" });
        return send(200, { characters: state.characters });
      }
      if (req.method === "POST" && req.url === "/alpha-api/play-ticket") {
        if (state.revoked || req.headers.authorization !== `Bearer ${CREDENTIAL}`) return send(401, { error: "invalid_auth" });
        state.ticketMints += 1;
        return send(200, {
          gameTicket: `${GAME_TICKET}-${state.ticketMints}`,
          chatTicket: `${CHAT_TICKET}-${state.ticketMints}`,
          characterId: JSON.parse(body).characterId,
          expiresAt: Date.now() + 45_000,
          endpoints: { game: "ws://127.0.0.1:19999/game/ws", chat: "ws://127.0.0.1:19998/chat" },
          release: { client: "successor-alpha", server: "successor-server-1", shard: "open-desert" },
        });
      }
      if (req.method === "POST" && req.url === "/alpha-api/device/logout") {
        state.revoked = true;
        res.writeHead(204);
        return res.end();
      }
      return send(404, { error: "not_found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function harness({ origin, userDataDir }) {
  const dir = userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "successor-hosted-session-"));
  const logs = [];
  const states = [];
  const navigations = [];
  const external = [];
  const copied = [];
  const handoff = createLaunchHandoff();
  const credentialStore = createCredentialStore({ userDataDir: dir, platform: process.platform });
  const session = createHostedSession({
    config: {
      apiOrigin: origin,
      connectUrl: "https://www.successorgame.com/connect",
      clientId: "successor-desktop",
      releaseId: "successor-alpha",
      scopes: ["character:list", "play-ticket"],
    },
    credentialStore,
    log: (event, details = {}) => logs.push(JSON.stringify({ event, ...details })),
    onState: (snapshot) => states.push(snapshot),
    armLaunch: (envelope) => handoff.arm(envelope, 42),
    disarmLaunch: () => handoff.disarm(),
    navigateToGame: async () => navigations.push("game"),
    navigateToShell: async () => navigations.push("shell"),
    openExternal: async (url) => external.push(url),
    copyText: (text) => copied.push(text),
    delay: async () => undefined,
  });
  return { session, handoff, logs, states, navigations, external, copied, dir, credentialStore };
}

function assertNoSecretLeaks({ logs, states, navigations, external }) {
  const surfaces = [...logs, ...states.map((snapshot) => JSON.stringify(snapshot)), ...navigations, ...external];
  for (const surface of surfaces) {
    for (const secret of SECRETS) {
      assert.ok(!surface.includes(secret), `secret leaked into observable surface: ${surface.slice(0, 120)}`);
    }
  }
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("full hosted flow: restore -> link -> approve -> characters -> one Enter arms one envelope", async () => {
  const api = await startFakeApi({ approveAfterPolls: 2 });
  const h = harness({ origin: api.origin });
  try {
    await h.session.restore();
    assert.equal(h.session.snapshot().stage, "signin");
    const linking = await h.session.startLink();
    assert.equal(linking.stage, "linking");
    assert.equal(linking.link.userCode, USER_CODE);
    assert.equal(linking.link.verificationUrl, "https://www.successorgame.com/connect");
    assert.ok(!linking.link.verificationUrl.includes(USER_CODE), "approval URL must not carry the code");
    h.session.copyCode();
    assert.deepEqual(h.copied, [USER_CODE]);
    await h.session.openApproval();
    assert.deepEqual(h.external, ["https://www.successorgame.com/connect"]);
    await waitFor(() => h.session.snapshot().stage === "characters", "credential exchange");
    const roster = h.session.snapshot();
    assert.equal(roster.persisted, true);
    assert.deepEqual(roster.characters.map((row) => row.id), ["char-1", "char-2"]);
    const entered = await h.session.enterWorld("char-1");
    assert.equal(entered.stage, "in-world");
    assert.deepEqual(h.navigations, ["game"]);
    const message = h.handoff.take(42);
    assert.equal(message.schema, "successor.launch-context.v1");
    assert.equal(message.characterId, "char-1");
    assert.equal(h.handoff.take(42), null, "envelope must be one-use");
    assertNoSecretLeaks(h);
    const stored = fs.readFileSync(credentialFilePath(h.dir), "utf8");
    assert.ok(stored.includes('"v":2'));
    } finally {
    h.session.dispose();
    await api.close();
  }
});

test("denied and expired device decisions land back on sign-in with honest notices", async () => {
  const api = await startFakeApi();
  const h = harness({ origin: api.origin });
  try {
    await h.session.restore();
    api.state.decision = "denied";
    await h.session.startLink();
    await waitFor(() => h.session.snapshot().notice === "denied", "denied notice");
    assert.equal(h.session.snapshot().stage, "signin");
    api.state.decision = "expired";
    await h.session.startLink();
    await waitFor(() => h.session.snapshot().notice === "expired", "expired notice");
    assert.equal(h.session.snapshot().stage, "signin");
    assertNoSecretLeaks(h);
  } finally {
    h.session.dispose();
    await api.close();
  }
});

test("one-leg launch failure discards the envelope, returns to select, and remints fresh on retry", async () => {
  const api = await startFakeApi();
  const h = harness({ origin: api.origin });
  try {
    await h.session.restore();
    await h.session.startLink();
    await waitFor(() => h.session.snapshot().stage === "characters", "exchange");
    await h.session.enterWorld("char-2");
    assert.equal(api.state.ticketMints, 1);
    await h.session.handleLaunchFailure("chat-failed");
    assert.equal(h.handoff.take(42), null, "failed launch must not leave a collectible envelope");
    assert.equal(h.session.snapshot().stage, "characters");
    assert.equal(h.session.snapshot().notice, "launch-failed");
    assert.deepEqual(h.navigations, ["game", "shell"]);
    const retried = await h.session.enterWorld("char-2");
    assert.equal(retried.stage, "in-world");
    assert.equal(api.state.ticketMints, 2);
    const message = h.handoff.take(42);
    assert.ok(message.gameTicket.endsWith("-2"));
    assertNoSecretLeaks(h);
  } finally {
    h.session.dispose();
    await api.close();
  }
});

test("restore uses the stored credential and server-side revoke clears it", async () => {
  const api = await startFakeApi();
  const first = harness({ origin: api.origin });
  try {
    await first.session.restore();
    await first.session.startLink();
    await waitFor(() => first.session.snapshot().stage === "characters", "exchange");
  } finally {
    first.session.dispose();
  }
  const second = harness({ origin: api.origin, userDataDir: first.dir });
  try {
    await second.session.restore();
    assert.equal(second.session.snapshot().stage, "characters");
    assert.equal(second.session.snapshot().persisted, true);
    api.state.revoked = true;
    await second.session.refreshCharacters();
    const snapshot = second.session.snapshot();
    assert.equal(snapshot.stage, "signin");
    assert.equal(snapshot.notice, "revoked");
    assert.equal(fs.existsSync(credentialFilePath(first.dir)), false);
    assertNoSecretLeaks(second);
  } finally {
    second.session.dispose();
    await api.close();
  }
});

test("relaunch with a saved sign-in and one character always shows roster until explicit Enter", async () => {
  const api = await startFakeApi({ characters: [{ id: "char-solo", name: "Lycaon", initialProfessionId: "scout", worldEntryClaimed: true }] });
  const first = harness({ origin: api.origin });
  try {
    await first.session.restore();
    await first.session.startLink();
    await waitFor(() => first.session.snapshot().stage === "characters", "exchange");
    assert.deepEqual(first.navigations, []);
  } finally {
    first.session.dispose();
  }
  const second = harness({ origin: api.origin, userDataDir: first.dir });
  try {
    await second.session.restore();
    assert.equal(second.session.snapshot().stage, "characters");
    assert.deepEqual(second.session.snapshot().characters.map((row) => row.id), ["char-solo"]);
    assert.deepEqual(second.navigations, [], "restore must not auto-launch even with one character");
    assert.equal(api.state.ticketMints, 0);
    const entered = await second.session.enterWorld("char-solo");
    assert.equal(entered.stage, "in-world");
    assert.deepEqual(second.navigations, ["game"]);
    assert.equal(api.state.ticketMints, 1);
    assert.equal(second.handoff.take(42).characterId, "char-solo");
    await second.session.handleLaunchFailure("game-leg-failed");
    assert.equal(second.session.snapshot().stage, "characters");
    assert.equal(second.session.snapshot().notice, "launch-failed");
    assertNoSecretLeaks(second);
  } finally {
    second.session.dispose();
    await api.close();
  }
});

test("restore with no characters yet keeps the roster page and its guidance", async () => {
  const api = await startFakeApi({ characters: [] });
  const first = harness({ origin: api.origin });
  try {
    await first.session.restore();
    await first.session.startLink();
    await waitFor(() => first.session.snapshot().stage === "characters", "exchange");
  } finally {
    first.session.dispose();
  }
  const second = harness({ origin: api.origin, userDataDir: first.dir });
  try {
    await second.session.restore();
    assert.equal(second.session.snapshot().stage, "characters");
    assert.deepEqual(second.session.snapshot().characters, []);
    assert.deepEqual(second.navigations, []);
    assert.equal(api.state.ticketMints, 0);
    assertNoSecretLeaks(second);
  } finally {
    second.session.dispose();
    await api.close();
  }
});

test("sign-out revokes server-side, clears the stored credential, and lands on sign-in", async () => {
  const api = await startFakeApi();
  const h = harness({ origin: api.origin });
  try {
    await h.session.restore();
    await h.session.startLink();
    await waitFor(() => h.session.snapshot().stage === "characters", "exchange");
    const out = await h.session.signOut();
    assert.equal(out.stage, "signin");
    assert.equal(api.state.revoked, true);
    assert.equal(fs.existsSync(credentialFilePath(h.dir)), false);
    assert.equal((await h.session.enterWorld("char-1")).stage, "signin");
    assertNoSecretLeaks(h);
  } finally {
    h.session.dispose();
    await api.close();
  }
});

test("shell control ops never expose secrets and unknown ops just return the snapshot", async () => {
  const api = await startFakeApi();
  const h = harness({ origin: api.origin });
  try {
    await h.session.restore();
    const snapshot = await h.session.control({ op: "definitely-not-an-op" });
    assert.equal(snapshot.stage, "signin");
    const linked = await h.session.control({ op: "start-link" });
    assert.deepEqual(Object.keys(linked).sort(), ["approvalHost", "characters", "link", "notice", "persistAvailable", "persisted", "stage"]);
    assert.deepEqual(Object.keys(linked.link).sort(), ["expiresAt", "userCode", "verificationUrl"]);
    assertNoSecretLeaks(h);
  } finally {
    h.session.dispose();
    await api.close();
  }
});
