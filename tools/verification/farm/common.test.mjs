import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runProcess } from "./common.mjs";

describe("farm runProcess abort contract", () => {
  it("fails closed when passed an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("test abort"));
    const result = await runProcess(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1_000)"], {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.aborted, true);
  });

  it("terminates an in-flight child on abort without misreporting a timeout", async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(new Error("test abort")), 30).unref();
    const result = await pending;
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(result.timedOut, false);
  });
});
