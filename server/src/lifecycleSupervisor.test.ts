import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHostedStateLock, hostedStateLockHealthy, releaseHostedStateLock } from "./lifecycleSupervisor.js";

describe("hosted durability lease", () => {
  const leases: Array<{ child: { kill(signal?: NodeJS.Signals): boolean }; released: boolean }> = [];
  afterEach(async () => {
    for (const lease of leases.splice(0)) await releaseHostedStateLock(lease as never);
  });

  it("rejects a second writer and loses readiness when the supervisor is killed", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "successor-hosted-lock-"));
    const first = await acquireHostedStateLock(stateDir);
    leases.push(first);
    expect(hostedStateLockHealthy()).toBe(true);
    await expect(acquireHostedStateLock(stateDir)).rejects.toThrow();
    first.child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hostedStateLockHealthy()).toBe(false);
  });
});
