import assert from "node:assert/strict";
import test from "node:test";

import {
  createLaunchHandoff,
  isGameSenderUrl,
  isShellSenderUrl,
} from "../src/hosted-bridge.mjs";

test("shell-control IPC is only accepted from the desktop-owned shell pages", () => {
  assert.equal(isShellSenderUrl("successor://shell/connect.html"), true);
  assert.equal(isShellSenderUrl("successor://app/index.html"), false);
  assert.equal(isShellSenderUrl("https://evil.example/connect.html"), false);
  assert.equal(isShellSenderUrl("successor://shellx/connect.html"), false);
  assert.equal(isShellSenderUrl(undefined), false);
});

test("launch take is only accepted from the game page or an allowed dev origin", () => {
  assert.equal(isGameSenderUrl("successor://app/index.html?slicePath=x"), true);
  assert.equal(isGameSenderUrl("successor://shell/connect.html"), false);
  assert.equal(isGameSenderUrl("http://127.0.0.1:5179/", ["http://127.0.0.1:5179"]), true);
  assert.equal(isGameSenderUrl("http://127.0.0.1:5179/", []), false);
  assert.equal(isGameSenderUrl("https://evil.example/", ["http://127.0.0.1:5179"]), false);
  assert.equal(isGameSenderUrl("not a url", ["http://127.0.0.1:5179"]), false);
});

test("the armed envelope is released exactly once, only to the bound webContents", () => {
  const handoff = createLaunchHandoff();
  const envelope = { schema: "successor.launch-context.v1", gameTicket: "g", chatTicket: "c" };
  assert.equal(handoff.armed(), false);
  assert.equal(handoff.take(7), null);

  handoff.arm(envelope, 7);
  assert.equal(handoff.armed(), true);
  // A wrong sender takes nothing and must NOT burn the pending launch.
  assert.equal(handoff.take(8), null);
  assert.equal(handoff.armed(), true);
  assert.equal(handoff.take(7), envelope);
  // One use: the second take from the right sender gets nothing.
  assert.equal(handoff.take(7), null);
  assert.equal(handoff.armed(), false);
});

test("re-arming replaces the pending launch and disarm clears it", () => {
  const handoff = createLaunchHandoff();
  handoff.arm({ gameTicket: "old" }, 7);
  handoff.arm({ gameTicket: "new" }, 9);
  assert.equal(handoff.take(7), null, "stale window must not receive the replacement envelope");
  assert.equal(handoff.armed(), true);
  assert.deepEqual(handoff.take(9), { gameTicket: "new" });

  handoff.arm({ gameTicket: "x" }, 9);
  handoff.disarm();
  assert.equal(handoff.take(9), null);
});
