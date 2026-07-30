import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSfxSpatialMix, createSfxPlayer } from "./sfx";

function audioParam(value = 1): AudioParam {
  return {
    value,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  } as unknown as AudioParam;
}

class FakeAudioContext {
  state: AudioContextState = "running";
  static last: FakeAudioContext | null = null;

  constructor() {
    FakeAudioContext.last = this;
  }

  currentTime = 0;
  destination = { connect: vi.fn() } as unknown as AudioDestinationNode;

  resume = vi.fn(async () => {
    this.state = "running";
  });

  decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
    if (bytes.byteLength === 0) throw new Error("decode failed");
    return { duration: 0.25 } as AudioBuffer;
  });

  createDynamicsCompressor(): DynamicsCompressorNode {
    return {
      connect: vi.fn(),
      threshold: audioParam(),
      knee: audioParam(),
      ratio: audioParam(),
      attack: audioParam(),
      release: audioParam(),
    } as unknown as DynamicsCompressorNode;
  }

  createGain(): GainNode {
    return {
      connect: vi.fn(),
      gain: audioParam(),
    } as unknown as GainNode;
  }

  sources: Array<{ start: ReturnType<typeof vi.fn>; loop: boolean; loopStart?: number; loopEnd?: number }> = [];

  createBufferSource(): AudioBufferSourceNode {
    const source = {
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      playbackRate: audioParam(),
      onended: null,
      buffer: null,
      loop: false,
    };
    this.sources.push(source as never);
    return source as unknown as AudioBufferSourceNode;
  }

  createStereoPanner(): StereoPannerNode {
    return {
      connect: vi.fn(),
      pan: audioParam(0),
    } as unknown as StereoPannerNode;
  }

  createOscillator(): OscillatorNode {
    return {
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      frequency: audioParam(),
      type: "sine",
    } as unknown as OscillatorNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return {
      connect: vi.fn(),
      frequency: audioParam(),
      Q: audioParam(),
      type: "bandpass",
    } as unknown as BiquadFilterNode;
  }
}


async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createSfxPlayer resilient loading", () => {
  beforeEach(() => {
    const windowStub = {
      addEventListener: vi.fn(),
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
      __successorSfx: undefined,
    } as unknown as Window & typeof globalThis;
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips missing and undecodable clips while keeping the soundscape ready", async () => {
    const manifest = {
      schema: "successor-sfx-manifest-v1",
      buses: { ui: { volume: 1, polyphony: 4 } },
      clips: [
        { id: "ok", path: "/ok.mp3", bus: "ui", volume: 1, polyphony: 1, durationSeconds: 0.25 },
        { id: "missing", path: "/missing.mp3", bus: "ui", volume: 1, polyphony: 1, durationSeconds: 0.25 },
        { id: "bad", path: "/bad.mp3", bus: "ui", volume: 1, polyphony: 1, durationSeconds: 0.25 },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/manifest.json") return { ok: true, json: async () => manifest } as Response;
      if (url === "/ok.mp3") return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
      if (url === "/bad.mp3") return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const sfx = createSfxPlayer("/manifest.json");
    await expect(sfx.load()).resolves.toBeUndefined();

    expect(sfx.probe.ready).toBe(true);
    expect(sfx.probe.clipCount).toBe(1);
    expect(sfx.probe.errors).toEqual([
      expect.objectContaining({ id: "missing", path: "/missing.mp3", reason: "failed to fetch /missing.mp3: 404" }),
      expect.objectContaining({ id: "bad", path: "/bad.mp3", reason: "decode failed" }),
    ]);
  });

  it("makes play() of an unknown id a silent no-op logged once", async () => {
    const manifest = {
      schema: "successor-sfx-manifest-v1",
      buses: { ui: { volume: 1, polyphony: 4 } },
      clips: [
        { id: "ok", path: "/ok.mp3", bus: "ui", volume: 1, polyphony: 1, durationSeconds: 0.25 },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/manifest.json") return { ok: true, json: async () => manifest } as Response;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    }) as unknown as typeof fetch);

    const sfx = createSfxPlayer("/manifest.json");
    await sfx.load();
    sfx.play("bogus");
    sfx.play("bogus");
    await flushMicrotasks();

    expect(sfx.probe.lastPlayed).toBeNull();
    expect(sfx.probe.errors.filter((error) => error.id === "bogus")).toEqual([
      expect.objectContaining({ id: "bogus", reason: "missing sfx clip bogus" }),
    ]);
  });

  it("lets a stopLoop issued mid-decode win over the queued start (orphaned-loop race)", async () => {
    const manifest = {
      schema: "successor-sfx-manifest-v1",
      buses: { ambient_bed: { volume: 1, polyphony: 4 } },
      clips: [
        { id: "bed", path: "/bed.mp3", bus: "ambient_bed", volume: 1, polyphony: 1, durationSeconds: 0.25, loop: true },
      ],
    };
    let releaseClip: () => void = () => undefined;
    const clipGate = new Promise<void>((resolve) => {
      releaseClip = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/manifest.json") return { ok: true, json: async () => manifest } as Response;
      await clipGate;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    }) as unknown as typeof fetch);

    const sfx = createSfxPlayer("/manifest.json");
    sfx.setLoop?.("bed", { volume: 0.4 });
    sfx.stopLoop?.("bed", 100);
    releaseClip();
    await sfx.load();
    await flushMicrotasks();

    expect(sfx.probe.activeLoops).toEqual([]);
    expect(FakeAudioContext.last?.sources.every((source) => source.start.mock.calls.length === 0)).toBe(true);

    // Sanity inverse: a fresh set AFTER load starts the loop for real.
    sfx.setLoop?.("bed", { volume: 0.4 });
    await flushMicrotasks();
    expect(sfx.probe.activeLoops).toEqual(["bed"]);
  });

  it("applies manifest loopStartSeconds/loopEndSeconds to the loop source window", async () => {
    const manifest = {
      schema: "successor-sfx-manifest-v1",
      buses: { music: { volume: 1, polyphony: 4 } },
      clips: [
        {
          id: "track", path: "/track.mp3", bus: "music", volume: 1, polyphony: 1,
          durationSeconds: 0.25, loop: true, loopStartSeconds: 0.05, loopEndSeconds: 0.2,
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/manifest.json") return { ok: true, json: async () => manifest } as Response;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    }) as unknown as typeof fetch);

    const sfx = createSfxPlayer("/manifest.json");
    await sfx.load();
    sfx.setLoop?.("track", { volume: 0.3 });
    await flushMicrotasks();

    const source = FakeAudioContext.last?.sources.find((candidate) => candidate.loop);
    expect(source?.loopStart).toBe(0.05);
    expect(source?.loopEnd).toBe(0.2);
  });

  it("does not allocate a source for positional audio at or beyond its cutoff", async () => {
    const manifest = {
      schema: "successor-sfx-manifest-v1",
      buses: { impacts: { volume: 1, polyphony: 4 } },
      clips: [
        { id: "impact", path: "/impact.mp3", bus: "impacts", volume: 1, polyphony: 1, durationSeconds: 0.25 },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/manifest.json") return { ok: true, json: async () => manifest } as Response;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    }) as unknown as typeof fetch);

    const sfx = createSfxPlayer("/manifest.json");
    await sfx.load();
    sfx.setListenerPosition({ x: 0, y: 0 });
    sfx.playAt("impact", { x: 14, y: 0 }, {
      minDistanceCells: 1,
      maxDistanceCells: 14,
      farGainFloor: 0.2,
    });
    sfx.playAt("impact", { x: 140, y: 0 }, {
      minDistanceCells: 1,
      maxDistanceCells: 14,
      farGainFloor: 0.2,
    });
    await flushMicrotasks();

    expect(FakeAudioContext.last?.sources).toHaveLength(0);

    sfx.playAt("impact", { x: 2, y: 0 }, {
      minDistanceCells: 1,
      maxDistanceCells: 14,
    });
    await flushMicrotasks();
    expect(FakeAudioContext.last?.sources).toHaveLength(1);
  });
});

describe("computeSfxSpatialMix", () => {
  it("falls monotonically to silence at max range, including with a far-presence bias", () => {
    const options = {
      minDistanceCells: 2,
      maxDistanceCells: 14,
      rolloff: 1.8,
      farGainFloor: 0.2,
    };
    const gains = [2, 6, 10, 13, 14, 40].map((x) => computeSfxSpatialMix({ x: 0, y: 0 }, { x, y: 0 }, options).gain);

    expect(gains[0]).toBe(1);
    expect(gains[0]).toBeGreaterThan(gains[1]!);
    expect(gains[1]).toBeGreaterThan(gains[2]!);
    expect(gains[2]).toBeGreaterThan(gains[3]!);
    expect(gains[3]).toBeGreaterThan(0);
    expect(gains[4]).toBe(0);
    expect(gains[5]).toBe(0);
  });
});
