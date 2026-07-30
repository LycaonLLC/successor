import assert from "node:assert/strict";
import test from "node:test";
import { nativeGameEndpoint, parseTuiProbeOutput, tuiGateStatus, validateLaunchEnvelope } from "./tui.mjs";

test("TUI gate requires authority tick, identity, source match, and teardown", () => {
  const complete = { status: "pass", authorityConnected: true, tickPositive: true, identityMatch: true, sourceMatchesClient: true, cleanupComplete: true };
  const parsedProtocol = { status: "pass", authorityConnected: true, tickPositive: true, identityMatch: true, sourceMatchesClient: true };
  assert.equal(tuiGateStatus(parsedProtocol, true).status, "incomplete");
  assert.equal(tuiGateStatus({ ...parsedProtocol, cleanupComplete: true }, true).status, "pass");
  assert.equal(tuiGateStatus(complete, true).status, "pass");
  assert.equal(tuiGateStatus({ ...complete, tickPositive: false }, true).status, "fail");
  assert.equal(tuiGateStatus({ ...complete, identityMatch: undefined }, true).status, "incomplete");
  assert.equal(tuiGateStatus(complete, false).status, "incomplete");
  assert.equal(tuiGateStatus({ ...complete, cleanupComplete: false }, true).status, "fail");
});

test("bounded TUI protocol admits only safe booleans and excludes capabilities", () => {
  const line = JSON.stringify({ type: "successor.tui.world-ready.v1", status: "pass", authorityConnected: true, tickPositive: true, identityMatch: true, sourceMatchesClient: true });
  assert.deepEqual(parseTuiProbeOutput(line), JSON.parse(line));
  assert.equal(parseTuiProbeOutput(`${line}\n${line}`), null);
  assert.equal(parseTuiProbeOutput(JSON.stringify({ type: "successor.tui.world-ready.v1", status: "pass", authorityConnected: true, tickPositive: true, identityMatch: true, sourceMatchesClient: true, gameTicket: "secret" })), null);
  assert.equal(parseTuiProbeOutput(JSON.stringify({ type: "successor.tui.world-ready.v1", status: "pass", authorityConnected: true, tickPositive: true, identityMatch: true, sourceMatchesClient: "true" })), null);
  const failure = JSON.stringify({ type: "successor.tui.world-ready.v1", status: "fail", reasonClass: "session-start", authorityConnected: false, tickPositive: false, identityMatch: false, sourceMatchesClient: false });
  assert.equal(parseTuiProbeOutput(failure).reasonClass, "session-start");
  assert.equal(parseTuiProbeOutput(failure.replace("session-start", "raw-error")), null);
});


test("TUI launch envelope is bound to the exact local TLS stack", () => {
  const stack = { siteUrl: "https://127.0.0.1:43123", gameEndpoint: "wss://127.0.0.1:43123/game/ws" };
  const envelope = { gameTicket: "ticket", characterId: "char", origin: stack.siteUrl, endpoints: { game: stack.gameEndpoint } };
  assert.equal(validateLaunchEnvelope(envelope, stack), true);
  assert.equal(nativeGameEndpoint(stack), "wss://127.0.0.1:43123");
  assert.throws(() => validateLaunchEnvelope({ ...envelope, origin: "https://127.0.0.1:43124" }, stack), /origin/u);
  assert.throws(() => validateLaunchEnvelope({ ...envelope, endpoints: { game: "wss://127.0.0.1:43124/game/ws" } }, stack), /endpoint/u);
});

test("TUI nonclean process exit cannot claim teardown", () => {
  const result = { status: "pass", authorityConnected: true, tickPositive: true, identityMatch: true, sourceMatchesClient: true, cleanupComplete: false };
  assert.equal(tuiGateStatus(result, true).status, "fail");
});
