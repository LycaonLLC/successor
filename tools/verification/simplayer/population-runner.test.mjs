import assert from "node:assert/strict";
import { test } from "node:test";

import { captureStableLocalSourceIdentity, evaluateSourceBinding } from "./population-runner.mjs";

test("stable source identity is accepted and preserved", async () => {
  const hash = "a".repeat(64);
  const identity = await captureStableLocalSourceIdentity({ root: ".", capture: async () => ({ sourceHash: hash }) });
  assert.equal(identity.sourceHash, hash);
  assert.deepEqual(evaluateSourceBinding(identity, identity), { localStartHash: hash, localFinalHash: hash, stable: true });
});

test("changed source identity is explicitly non-stable", () => {
  const start = { sourceHash: "a".repeat(64) };
  const final = { sourceHash: "b".repeat(64) };
  assert.deepEqual(evaluateSourceBinding(start, final), { localStartHash: start.sourceHash, localFinalHash: final.sourceHash, stable: false });
});
