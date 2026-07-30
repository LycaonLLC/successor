import assert from "node:assert/strict";
import test from "node:test";

import { createHostedNetworkPolicy } from "../src/hosted-net-policy.mjs";

const STOREFRONT = "https://www.successorgame.com";
const ENDPOINTS = { game: "wss://game.successorgame.com:8443/game/ws", chat: "wss://chat.successorgame.com/chat" };

function armedPolicy() {
  const policy = createHostedNetworkPolicy({ storefrontOrigin: STOREFRONT });
  policy.arm(7, ENDPOINTS);
  return policy;
}

test("websocket upgrades to the exact envelope hosts get the storefront Origin, nothing else", () => {
  const policy = armedPolicy();
  const decision = policy.decideHeaders({
    webContentsId: 7,
    url: "wss://game.successorgame.com:8443/game/ws",
    requestHeaders: {
      Origin: "successor://app",
      Cookie: "__Host-successor_session=leak",
      Authorization: "Bearer credential-leak",
      "User-Agent": "Successor/1.0",
    },
  });
  assert.deepEqual(decision.requestHeaders, {
    "User-Agent": "Successor/1.0",
    Origin: STOREFRONT,
  });
});

test("matchmake and backend HTTP on the game host get the storefront Origin too", () => {
  const policy = armedPolicy();
  const decision = policy.decideHeaders({
    webContentsId: 7,
    url: "https://game.successorgame.com:8443/matchmake/joinOrCreate/game",
    requestHeaders: { Origin: "successor://app", "Content-Type": "application/json" },
  });
  assert.equal(decision.requestHeaders.Origin, STOREFRONT);
  assert.equal(decision.requestHeaders["Content-Type"], "application/json");
});

test("websockets to unexpected hosts are refused; allowed hosts and other schemes pass", () => {
  const policy = armedPolicy();
  assert.deepEqual(policy.decideRequest({ webContentsId: 7, url: "wss://evil.example/game/ws" }), { cancel: true });
  assert.deepEqual(policy.decideRequest({ webContentsId: 7, url: "wss://game.successorgame.com/game/ws" }), { cancel: true }, "same hostname on a different port is a different host");
  assert.deepEqual(policy.decideRequest({ webContentsId: 7, url: "wss://game.successorgame.com:8443/game/ws" }), { cancel: false });
  assert.deepEqual(policy.decideRequest({ webContentsId: 7, url: "https://anywhere.example/asset.png" }), { cancel: false });
});

test("requests from other webContents or to unlisted hosts are never touched", () => {
  const policy = armedPolicy();
  assert.deepEqual(policy.decideRequest({ webContentsId: 8, url: "wss://evil.example/" }), { cancel: false });
  assert.equal(policy.decideHeaders({ webContentsId: 8, url: "wss://game.successorgame.com:8443/game/ws", requestHeaders: {} }), null);
  assert.equal(policy.decideHeaders({ webContentsId: 7, url: "https://www.successorgame.com/alpha-api/characters", requestHeaders: {} }), null, "the account API host is not a game host; no header rewriting there");
  assert.equal(policy.decideHeaders({ webContentsId: 7, url: "successor://app/index.html", requestHeaders: {} }), null);
});

test("an unarmed or cleared policy touches nothing and refuses to arm without both endpoints", () => {
  const policy = createHostedNetworkPolicy({ storefrontOrigin: STOREFRONT });
  assert.equal(policy.armed(), false);
  assert.deepEqual(policy.decideRequest({ webContentsId: 7, url: "wss://game.successorgame.com:8443/game/ws" }), { cancel: false });
  assert.equal(policy.decideHeaders({ webContentsId: 7, url: "wss://game.successorgame.com:8443/game/ws", requestHeaders: {} }), null);

  assert.throws(() => policy.arm(7, { game: ENDPOINTS.game }), /exact game and chat endpoints/);

  policy.arm(7, ENDPOINTS);
  assert.equal(policy.armed(), true);
  policy.clear();
  assert.equal(policy.armed(), false);
  assert.equal(policy.decideHeaders({ webContentsId: 7, url: ENDPOINTS.game, requestHeaders: {} }), null);
});

test("re-arming replaces both the bound webContents and the host allowlist", () => {
  const policy = armedPolicy();
  policy.arm(9, { game: "ws://127.0.0.1:19999/game/ws", chat: "ws://127.0.0.1:19998/chat" });
  assert.deepEqual(policy.decideRequest({ webContentsId: 7, url: ENDPOINTS.game }), { cancel: false }, "old webContents is out of scope after re-arm");
  assert.deepEqual(policy.decideRequest({ webContentsId: 9, url: ENDPOINTS.game }), { cancel: true }, "old hosts are refused after re-arm");
  assert.equal(policy.decideHeaders({ webContentsId: 9, url: "ws://127.0.0.1:19999/game/ws", requestHeaders: {} }).requestHeaders.Origin, STOREFRONT);
});

test("response CORS grants are normalized only for the bound webContents on allowed hosts", () => {
  const policy = armedPolicy();
  const decision = policy.decideResponseHeaders({
    webContentsId: 7,
    url: "https://game.successorgame.com:8443/matchmake/joinOrCreate/game",
    responseHeaders: {
      "content-type": ["application/json"],
      "Access-Control-Allow-Origin": ["https://www.successorgame.com"],
    },
  });
  assert.deepEqual(decision.responseHeaders["Access-Control-Allow-Origin"], ["successor://app"]);
  assert.deepEqual(decision.responseHeaders["Access-Control-Allow-Credentials"], ["true"]);
  assert.deepEqual(decision.responseHeaders["Access-Control-Allow-Private-Network"], ["true"]);
  assert.deepEqual(decision.responseHeaders["content-type"], ["application/json"]);
  assert.equal(policy.decideResponseHeaders({ webContentsId: 8, url: "https://game.successorgame.com:8443/x", responseHeaders: {} }), null);
  assert.equal(policy.decideResponseHeaders({ webContentsId: 7, url: "https://other.example/x", responseHeaders: {} }), null);
  assert.equal(policy.decideResponseHeaders({ webContentsId: 7, url: "wss://game.successorgame.com:8443/game/ws", responseHeaders: {} }), null);
});
