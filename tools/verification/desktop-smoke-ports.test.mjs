import assert from "node:assert/strict";
import test from "node:test";

import { boundedEnvPort, DESKTOP_SMOKE_PORT_RANGE } from "./desktop-smoke-ports.mjs";

test("desktop smoke accepts both farm port-range boundaries", () => {
  const { start, end } = DESKTOP_SMOKE_PORT_RANGE;
  assert.equal(boundedEnvPort("DESKTOP_SMOKE_GAME_PORT", start, { DESKTOP_SMOKE_GAME_PORT: String(start) }), start);
  assert.equal(boundedEnvPort("DESKTOP_SMOKE_PREVIEW_PORT", start, { DESKTOP_SMOKE_PREVIEW_PORT: String(end) }), end);
});

test("desktop smoke rejects ports just outside the farm range", () => {
  const { start, end } = DESKTOP_SMOKE_PORT_RANGE;
  assert.throws(
    () => boundedEnvPort("DESKTOP_SMOKE_GAME_PORT", start, { DESKTOP_SMOKE_GAME_PORT: String(start - 1) }),
    /outside lane port block/,
  );
  assert.throws(
    () => boundedEnvPort("DESKTOP_SMOKE_PREVIEW_PORT", start, { DESKTOP_SMOKE_PREVIEW_PORT: String(end + 1) }),
    /outside lane port block/,
  );
});
