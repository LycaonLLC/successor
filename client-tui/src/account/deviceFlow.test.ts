import { describe, expect, it } from "vitest";

import type { AlphaApi, DevicePoll } from "./alphaApi";
import { DeviceFlowError, runDeviceFlow } from "./deviceFlow";

const DEVICE_CODE = "device-code-secret-000000000000000000000001";
const CREDENTIAL = "credential-secret-00000000000000000000000001";
const CONNECT_URL = "https://www.successorgame.com/connect";

interface Harness {
  api: AlphaApi;
  lines: string[];
  sleeps: number[];
  polls: number;
  opened: string[];
}

function harness(polls: DevicePoll[], startOverrides: Partial<{ pollIntervalMs: number; expiresAt: number }> = {}): Harness {
  const state: Harness = { lines: [], sleeps: [], polls: 0, opened: [], api: null as unknown as AlphaApi };
  state.api = {
    apiUrl: "https://www.successorgame.com",
    connectUrl: CONNECT_URL,
    async deviceStart() {
      return {
        deviceCode: DEVICE_CODE,
        userCode: "ABCD2345EF",
        expiresAt: startOverrides.expiresAt ?? Date.now() + 600_000,
        pollIntervalMs: startOverrides.pollIntervalMs ?? 5_000,
      };
    },
    async devicePoll(deviceCode) {
      expect(deviceCode).toBe(DEVICE_CODE);
      state.polls += 1;
      return polls[Math.min(state.polls - 1, polls.length - 1)]!;
    },
    async deviceLogout() {
      return "revoked" as const;
    },
    async listCharacters() {
      return [];
    },
    async playTicket() {
      throw new Error("not under test");
    },
  };
  return state;
}

function flowDeps(state: Harness, openBrowser = false) {
  return {
    api: state.api,
    io: {
      print: (line: string) => state.lines.push(line),
      openBrowser: (url: string) => state.opened.push(url),
    },
    releaseId: "dev",
    openBrowser,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
    },
  };
}

describe("device sign-in flow", () => {
  it("prints the approval URL and human code, never the device secret or credential", async () => {
    const state = harness([{ status: "pending" }, { status: "exchanged", credential: CREDENTIAL, scopes: ["character:list", "play-ticket"] }]);
    const result = await runDeviceFlow(flowDeps(state));
    expect(result.credential).toBe(CREDENTIAL);
    expect(result.scopes).toEqual(["character:list", "play-ticket"]);
    const output = state.lines.join("\n");
    expect(output).toContain(CONNECT_URL);
    expect(output).toContain("ABCD2345EF");
    expect(output).not.toContain(DEVICE_CODE);
    expect(output).not.toContain(CREDENTIAL);
  });

  it("never polls faster than the 5s floor, even when the server invites it", async () => {
    const state = harness(
      [{ status: "pending" }, { status: "exchanged", credential: CREDENTIAL, scopes: [] }],
      { pollIntervalMs: 250 },
    );
    await runDeviceFlow(flowDeps(state));
    expect(state.sleeps.length).toBeGreaterThan(0);
    for (const ms of state.sleeps) expect(ms).toBeGreaterThanOrEqual(5_000);
  });

  it("honors slow_down back-off from the server", async () => {
    const state = harness([
      { status: "pending" },
      { status: "slow_down", retryAfterMs: 12_000 },
      { status: "pending" },
      { status: "exchanged", credential: CREDENTIAL, scopes: [] },
    ]);
    await runDeviceFlow(flowDeps(state));
    expect(state.sleeps[0]).toBe(5_000);
    expect(state.sleeps[1]).toBe(5_000);
    // the sleep after slow_down uses the server's retry window
    expect(state.sleeps[2]).toBe(12_000);
    expect(state.polls).toBe(4);
  });

  it("keeps a slow_down without retryAfterMs above the floor", async () => {
    const state = harness([
      { status: "slow_down" },
      { status: "exchanged", credential: CREDENTIAL, scopes: [] },
    ]);
    await runDeviceFlow(flowDeps(state));
    expect(state.sleeps[1]).toBe(10_000);
  });

  it("surfaces a browser denial as a settled failure", async () => {
    const state = harness([{ status: "denied" }]);
    await expect(runDeviceFlow(flowDeps(state))).rejects.toMatchObject({ outcome: "denied" });
  });

  it("surfaces expiry, both from the server and from the local clock", async () => {
    const server = harness([{ status: "expired" }]);
    await expect(runDeviceFlow(flowDeps(server))).rejects.toMatchObject({ outcome: "expired" });

    const local = harness([{ status: "pending" }], { expiresAt: Date.now() - 1 });
    const failure = await runDeviceFlow(flowDeps(local)).catch((error) => error as DeviceFlowError);
    expect(failure).toBeInstanceOf(DeviceFlowError);
    expect((failure as DeviceFlowError).outcome).toBe("expired");
    expect(local.polls).toBe(0);
  });

  it("surfaces revocation", async () => {
    const state = harness([{ status: "revoked" }]);
    await expect(runDeviceFlow(flowDeps(state))).rejects.toMatchObject({ outcome: "revoked" });
  });

  it("opens the browser only with the explicit flag, and only with the clean URL", async () => {
    const withoutFlag = harness([{ status: "exchanged", credential: CREDENTIAL, scopes: [] }]);
    await runDeviceFlow(flowDeps(withoutFlag, false));
    expect(withoutFlag.opened).toEqual([]);

    const withFlag = harness([{ status: "exchanged", credential: CREDENTIAL, scopes: [] }]);
    await runDeviceFlow(flowDeps(withFlag, true));
    expect(withFlag.opened).toEqual([CONNECT_URL]);
  });
});
