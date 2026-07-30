import { describe, expect, it, vi } from "vitest";

import {
  authorityCellFromPosition,
  placementMatchesMeasuredSite,
  waitAuthorityStationary,
} from "../journeys/camp.mjs";

describe("client-3d camp journey placement measurement", () => {
  it("matches Rust authority cell quantization at positive and negative coordinates", () => {
    expect(authorityCellFromPosition({ x: 512.135, y: 523.744 })).toEqual({ x: 512, y: 523 });
    expect(authorityCellFromPosition({ x: -0.001, y: -4.999 })).toEqual({ x: -1, y: -5 });
  });

  it("accepts a projected camp only when cell and continuous placement position match the settled measurement", () => {
    const contract = placementMatchesMeasuredSite(
      { cellX: 512, cellY: 523 },
      { x: 512.135, y: 523.744 },
      { x: 512.14, y: 523.75 },
    );

    expect(contract).toMatchObject({
      measuredCell: { x: 512, y: 523 },
      placementCell: { x: 512, y: 523 },
      matches: true,
    });
    expect(contract.positionDrift).toBeLessThan(0.01);
  });

  it("rejects the observed gate race even though both samples quantize to the same cell", () => {
    const contract = placementMatchesMeasuredSite(
      { cellX: 512, cellY: 523 },
      { x: 512.14, y: 523.13 },
      { x: 512.14, y: 523.79 },
    );

    expect(contract.measuredCell).toEqual(contract.placementCell);
    expect(contract.positionDrift).toBeCloseTo(0.66, 6);
    expect(contract.matches).toBe(false);
  });

  it("rejects an adjacent projected placement even when player drift is negligible", () => {
    expect(placementMatchesMeasuredSite(
      { cellX: 512, cellY: 524 },
      { x: 512.2, y: 523.8 },
      { x: 512.2, y: 523.8 },
    ).matches).toBe(false);
  });

  it("accepts a drained idle authority snapshot after 700ms even when its tick is constant", async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const idle = {
      tick: 718,
      authorityPlayer: { x: 512, y: 512, areaId: "open-desert-overworld" },
      moveGate: {
        moving: false,
        pendingMoves: 0,
        inFlightMoves: 0,
        sendGateStalled: false,
        sentMoveTail: [],
        receiptTail: [],
      },
    };
    const s = {
      releaseAll: vi.fn(async () => {}),
      probe: vi.fn(async () => idle),
      assert(condition, message) {
        if (!condition) throw new Error(message);
      },
    };

    try {
      const settled = await waitAuthorityStationary(
        { delay: vi.fn(async (ms) => { now += ms; }) },
        s,
        { quietMs: 700, timeoutMs: 2000 },
      );

      expect(s.releaseAll).toHaveBeenCalledOnce();
      expect(settled).toMatchObject({ x: 512, y: 512 });
      expect(s.probe).toHaveBeenCalledTimes(8);
      expect(now).toBe(10_700);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("waits for a queued/in-flight stop receipt and then rejects trailing positive movement", async () => {
    let now = 20_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const pendingStop = {
      moving: false,
      pendingMoves: 1,
      inFlightMoves: 0,
      sendGateStalled: false,
      sentMoveTail: [{ commandId: 41 }],
      receiptTail: [{ commandId: 41, accepted: true, tick: 2327 }],
    };
    const inFlightStop = {
      moving: false,
      pendingMoves: 0,
      inFlightMoves: 1,
      sendGateStalled: false,
      sentMoveTail: [{ commandId: 41 }, { commandId: 42 }],
      receiptTail: [{ commandId: 41, accepted: true, tick: 2327 }],
    };
    const drainedStop = {
      ...inFlightStop,
      inFlightMoves: 0,
      receiptTail: [
        { commandId: 41, accepted: true, tick: 2327 },
        { commandId: 42, accepted: true, tick: 2354 },
      ],
    };
    const probes = [
      { tick: 2353, authorityPlayer: { x: 512.14, y: 523.13 }, moveGate: pendingStop },
      { tick: 2353, authorityPlayer: { x: 512.14, y: 523.42 }, moveGate: inFlightStop },
      { tick: 2354, authorityPlayer: { x: 512.14, y: 523.79 }, moveGate: drainedStop },
    ];
    let probeIndex = 0;
    const s = {
      releaseAll: vi.fn(async () => {}),
      probe: vi.fn(async () => probes[Math.min(probeIndex++, probes.length - 1)]),
      assert(condition, message) {
        if (!condition) throw new Error(message);
      },
    };

    try {
      const settled = await waitAuthorityStationary(
        { delay: vi.fn(async (ms) => { now += ms; }) },
        s,
        { quietMs: 700, timeoutMs: 2500 },
      );

      expect(settled).toMatchObject({ x: 512.14, y: 523.79 });
      expect(s.probe).toHaveBeenCalledTimes(10);
      expect(now).toBe(20_900);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
