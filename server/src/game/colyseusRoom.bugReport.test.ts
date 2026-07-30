import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeAuthConfig } from "../auth/runtime.js";
import { SuccessorGameRoom } from "./colyseusRoom.js";

const runtimeAuth: RuntimeAuthConfig = {
  mode: "standalone",
  origin: "https://www.successorgame.com",
  clientOrigin: "https://client.successorgame.com",
  shardId: "open-desert",
  clientReleaseId: "client-authoritative",
  serverReleaseId: "server-authoritative",
  issuer: "successor-server",
  controlDbPath: path.join(tmpdir(), "successor-bug-report-room-test.sqlite"),
  claimSecret: Buffer.alloc(32, 0x11),
};

interface RoomHarness {
  runtimeAuth: RuntimeAuthConfig;
  identities: Map<string, unknown>;
  connectedSessions: Set<string>;
  controlStore: { createBugReport: ReturnType<typeof vi.fn> };
  bugReportRates: Map<string, { count: number; resetAt: number }>;
  receiveBugReport(client: unknown, payload: unknown): void;
}

function harness(): RoomHarness {
  const room = Object.create(SuccessorGameRoom.prototype) as RoomHarness;
  room.runtimeAuth = runtimeAuth;
  room.identities = new Map([[
    "session-reporter",
    {
      actorId: "char-reporter",
      playerId: "char-reporter",
      displayName: "Reporter",
      zoneId: runtimeAuth.shardId,
      characterId: "char-reporter",
      ownerRef: "owner-reporter",
      launchProvenance: {
        launchId: "launch-reporter",
        accountId: "account-reporter",
        ownerRef: "owner-reporter",
        characterId: "char-reporter",
        issuer: runtimeAuth.issuer,
      },
    },
  ]]);
  room.connectedSessions = new Set(["session-reporter"]);
  room.controlStore = {
    createBugReport: vi.fn(() => ({ reportId: "bug_1234", createdAt: 42 })),
  };
  room.bugReportRates = new Map();
  return room;
}

function payload(requestId = "6e934dfe-e9da-4d15-8da4-e6e32b7d5ab8") {
  return {
    schema: "successor.bug-report-submission.v1",
    requestId,
    category: "gameplay",
    body: "The extractor vanished immediately after I placed it.",
    diagnostics: {
      shardId: "client-cannot-claim-this",
      accountId: "client-cannot-claim-this",
    },
  };
}

describe("Colyseus player bug report transport", () => {
  it("binds identity and release metadata from the authenticated room", () => {
    const room = harness();
    const send = vi.fn();
    room.receiveBugReport({ sessionId: "session-reporter", send }, payload());

    expect(room.controlStore.createBugReport).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-reporter",
      ownerRef: "owner-reporter",
      characterId: "char-reporter",
      launchId: "launch-reporter",
      shardId: runtimeAuth.shardId,
      clientReleaseId: runtimeAuth.clientReleaseId,
      serverReleaseId: runtimeAuth.serverReleaseId,
    }));
    expect(send).toHaveBeenCalledWith("bugReportResult", {
      schema: "successor.bug-report-result.v1",
      requestId: payload().requestId,
      status: "accepted",
      reportId: "bug_1234",
      receivedAt: 42,
    });
  });

  it("rejects malformed reports and rate-limits a connected session", () => {
    const room = harness();
    const send = vi.fn();
    const client = { sessionId: "session-reporter", send };

    room.receiveBugReport(client, { ...payload(), body: "too short" });
    expect(send).toHaveBeenLastCalledWith("bugReportResult", expect.objectContaining({
      status: "rejected",
      reasonCode: "invalid_report",
    }));
    expect(room.bugReportRates.size).toBe(0);

    room.bugReportRates.clear();
    for (let index = 0; index < 6; index += 1) {
      room.receiveBugReport(client, payload(`6e934dfe-e9da-4d15-8da4-e6e32b7d5ab${index}`));
    }
    expect(room.controlStore.createBugReport).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenLastCalledWith("bugReportResult", expect.objectContaining({
      status: "rejected",
      reasonCode: "rate_limited",
    }));
  });
});
