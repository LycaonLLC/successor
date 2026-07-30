import { describe, expect, it, vi } from "vitest";
import type { SfxPlayer, SfxPlayOptions, SfxPoint } from "../audio/sfx";
import { combatAudioFactor, profileForArea, updateRuntimeAudio } from "./ambientAudioSystem";
import { applyServerPacket } from "./gameAuthoritySystem";
import { createPlayState, createRuntimeCombatAudioState, type ActorSnapshot, type PlayState, type SliceSnapshot } from "./gameState";
import { successorAudioIds } from "./successorAudioIds";

interface RecordedLoop {
  id: string;
  volume: number;
  fadeMs: number | undefined;
}

interface RecordedStop {
  id: string;
  fadeMs: number | undefined;
}

function sfxRecorder() {
  const loops: RecordedLoop[] = [];
  const stopped: string[] = [];
  const stopEvents: RecordedStop[] = [];
  const stopAllFadeMs: number[] = [];
  const played: string[] = [];
  const playedAt: string[] = [];
  const playAtPositions: SfxPoint[] = [];
  const playAtOptions: SfxPlayOptions[] = [];
  const rec = {
    loops,
    stopped,
    stopEvents,
    stopAllFadeMs,
    played,
    playedAt,
    playAtPositions,
    playAtOptions,
    probe: {
      ready: true,
      unlocked: true,
      clipCount: 0,
      lastPlayed: null,
      listener: null,
      lastDistanceCells: null,
      lastPan: 0,
      lastGain: 1,
      errors: [],
    },
    load: async () => undefined,
    setListenerPosition: () => undefined,
    play: (id: string) => {
      rec.played.push(id);
    },
    playAt: (id: string, position: SfxPoint, options?: SfxPlayOptions) => {
      rec.playedAt.push(id);
      rec.playAtPositions.push(position);
      rec.playAtOptions.push(options ?? {});
    },
    setLoop: (id: string, options?: SfxPlayOptions) => {
      rec.loops.push({ id, volume: options?.volume ?? 1, fadeMs: options?.fadeMs });
    },
    stopLoop: (id: string, fadeMs?: number) => {
      rec.stopped.push(id);
      rec.stopEvents.push({ id, fadeMs });
    },
    stopAllLoops: (fadeMs?: number) => {
      rec.stopped.push("__all__");
      rec.stopAllFadeMs.push(fadeMs ?? 700);
    },
  };
  return rec as unknown as SfxPlayer & {
    loops: RecordedLoop[];
    stopped: string[];
    stopEvents: RecordedStop[];
    stopAllFadeMs: number[];
    played: string[];
    playedAt: string[];
    playAtPositions: SfxPoint[];
    playAtOptions: SfxPlayOptions[];
  };
}

type Phase = "day" | "night" | "dawn" | "dusk" | "deep_night";

interface TestActor {
  id: string;
  x: number;
  y: number;
  areaId: string;
  lifeState: string;
  inCombat?: boolean;
}

interface MakeStateOptions {
  activeAreaId?: string;
  phase?: Phase;
  playerActorId?: string;
  actors?: Record<string, TestActor>;
  weather?: PlayState["weather"];
}

function makeState(options: MakeStateOptions = {}): PlayState {
  const activeAreaId = options.activeAreaId ?? "open-desert-overworld";
  const playerActorId = options.playerActorId ?? "player";
  return {
    playerActorId,
    activeAreaId,
    player: { x: 10, y: 10 },
    moving: false,
    death: { phase: "alive" } as PlayState["death"],
    worldTimeMs: 0,
    weather: options.weather ?? [],
    worldClock: { lastSnapshot: { phase: options.phase ?? "day" } } as PlayState["worldClock"],
    serverAuthority: {
      playerActorId,
      actors: options.actors ?? {
        player: { id: "player", x: 10, y: 10, areaId: activeAreaId, lifeState: "alive" },
      },
    } as PlayState["serverAuthority"],
    runtimeAudio: {
      ambientAreaId: null,
      loopVolumes: {},
      nextOneShotAtMs: {},
      footstepDistanceCells: 0,
      footstepIndex: 0,
      lastFootstepPlayer: null,
      lastStepAtMs: -Infinity,
      lastCombatAudioAtMs: -Infinity,
      activeCombatMusicId: null,
      npcFootsteps: {},
      surveyPullLoopActive: false,
      surveyPullLoopUntilMs: null,
      combat: createRuntimeCombatAudioState(),
    },
  } as unknown as PlayState;
}

function makeSlice(): SliceSnapshot {
  return {
    areas: [{ id: "open-desert-overworld", width: 1024, height: 1024 }],
    zone: { width: 1024, height: 1024 },
  } as unknown as SliceSnapshot;
}

function stormWeather(overrides: Partial<PlayState["weather"][number]> = {}): PlayState["weather"][number] {
  return {
    areaId: "open-desert-overworld",
    eventType: "sandstorm",
    phase: "active",
    centerX: 512,
    centerY: 512,
    radiusCells: 48,
    intensity: 1,
    magnitude: 0.9,
    phaseEndsAtTick: 1_200,
    resolvesAtTick: 2_400,
    sweepDirRad: 0,
    ...overrides,
  };
}

const authorityPlayer: ActorSnapshot = {
  id: "player",
  entity: "actor.player",
  areaId: "open-desert-overworld",
  label: "Field Observer",
  role: "player",
  sprite: "adventurer-premium-male",
  poseSet: "idle",
  direction: "right",
  cell: { x: 10, y: 10 },
  route: [],
};

function makeAuthoritySlice(): SliceSnapshot {
  return {
    schema: "test",
    tick: 1,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Test", width: 64, height: 64, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 64, height: 64, level: 0 }],
    stateHash: "hash",
    camera: { followActor: "player", zoom: 1 },
    actors: [authorityPlayer],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function shardSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema: "successor.authoritative-shard-snapshot.v1" as const,
    shardId: "test",
    tick: 20,
    playerActorId: "player",
    sourceStateHash: "hash",
    sourceActorCount: 1,
    actors: {
      player: actorSnapshot("player", 10, 10, 100),
    },
    counters: counters(),
    ...overrides,
  };
}

function actorSnapshot(id: string, x: number, y: number, credits = 100) {
  return {
    id,
    label: id,
    areaId: "open-desert-overworld",
    x,
    y,
    direction: "right" as const,
    lifeState: "alive" as const,
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    statuses: [],
    credits,
  };
}

function counters() {
  return {
    acceptedCommands: 0,
    rejectedCommands: 0,
    shotsFired: 0,
    hits: 0,
    deaths: 0,
  };
}

describe("ambientAudioSystem", () => {
  describe("profileForArea", () => {
    it("resolves open-desert-overworld to the ratified desert day/night slots and desert combat pool", () => {
      const profile = profileForArea("open-desert-overworld");
      expect(profile.footstepSurface).toBe("grass");
      expect(profile.loops.some((layer) => layer.id === successorAudioIds.musicDesertDayDustSilentWorldLoop)).toBe(true);
      expect(profile.loops.some((layer) => layer.id === successorAudioIds.musicDesertNightSleepingCityLoop)).toBe(true);
      expect(profile.loops.some((layer) => layer.id === "music_glacial_remnant_loop")).toBe(false);
      expect(profile.loops.some((layer) => layer.id === "music_desert_city_daywalk_loop")).toBe(false);
      expect(profile.combatMusicIds).toEqual([
        successorAudioIds.musicCombatSandstormRunLoop,
        successorAudioIds.musicCombatRedDunesLoop,
      ]);
      expect(profile.combatMusicIds).not.toContain("music_combat_dune_fire_charge_loop");
    });

    it("falls back to the canonical open-desert profile", () => {
      const profile = profileForArea("totally-unknown-area");
      expect(profile.loops.some((layer) => layer.id === successorAudioIds.settlementMurmurLoop)).toBe(true);
      expect(profile.combatMusicIds).toEqual([
        successorAudioIds.musicCombatSandstormRunLoop,
        successorAudioIds.musicCombatRedDunesLoop,
      ]);
    });

    it("keeps intermittent desert wildlife in the canonical and fallback profiles", () => {
      for (const areaId of ["open-desert-overworld", "totally-unknown-area"]) {
        const profile = profileForArea(areaId);
        expect(profile.oneShots.flatMap((layer) => layer.clips).some((clip) => clip.startsWith("amb_desert_crow_"))).toBe(true);
      }
    });

    it("does not stack multiple non-combat music loops in any area profile phase", () => {
      const profileIds = ["open-desert-overworld", "totally-unknown-area"];
      for (const areaId of profileIds) {
        const profile = profileForArea(areaId);
        for (const phase of ["day", "night"] as const) {
          const activeMusic = profile.loops
            .filter((layer) => layer.id.startsWith("music_") && !layer.combatOnly)
            .filter((layer) => layer.volume * (phase === "night" ? (layer.nightMix ?? 1) : (layer.dayMix ?? 1)) > 0.01)
            .map((layer) => layer.id);
          expect(activeMusic, `${areaId} ${phase}`).toHaveLength(1);
        }
      }
    });
  });

  describe("combatAudioFactor", () => {
    it("decays linearly from 1 to 0 across the ~6s post-combat linger window", () => {
      const state = makeState();
      state.runtimeAudio.lastCombatAudioAtMs = 1_000;
      expect(combatAudioFactor(state, 1_000)).toBeCloseTo(1, 2);
      expect(combatAudioFactor(state, 4_500)).toBeGreaterThan(0);
      expect(combatAudioFactor(state, 4_500)).toBeLessThan(0.5);
      expect(combatAudioFactor(state, 7_000)).toBe(0);
    });

    it("is silent before any combat and guards against non-finite clocks", () => {
      const state = makeState();
      state.runtimeAudio.lastCombatAudioAtMs = -Infinity;
      expect(combatAudioFactor(state, 5_000)).toBe(0);
    });
  });

  describe("updateRuntimeAudio — ambient loops + music", () => {
    it("starts the desert day profile with settlement + Dust Silent World music on the first frame", () => {
      const state = makeState();
      const sfx = sfxRecorder();
      updateRuntimeAudio(state, makeSlice(), sfx, 0);

      const ids = sfx.loops.map((loop) => loop.id);
      expect(ids).toContain(successorAudioIds.settlementMurmurLoop);
      expect(ids).toContain(successorAudioIds.musicDesertDayDustSilentWorldLoop);
      expect(ids).not.toContain("music_glacial_remnant_loop");
      expect(ids).not.toContain(successorAudioIds.musicDesertNightSleepingCityLoop);
      expect(sfx.loops.find((loop) => loop.id === successorAudioIds.musicDesertDayDustSilentWorldLoop)?.volume).toBeGreaterThanOrEqual(0.3);
    });

    it("starts the desert night profile with settlement + Sleeping City music on the first frame", () => {
      const night = makeState({ phase: "night" });
      const sfx = sfxRecorder();
      updateRuntimeAudio(night, makeSlice(), sfx, 0);

      const ids = sfx.loops.map((loop) => loop.id);
      const dayPrimary = sfx.loops.find((loop) => loop.id === successorAudioIds.musicDesertDayDustSilentWorldLoop)?.volume ?? 0;
      const sleepingCity = sfx.loops.find((loop) => loop.id === successorAudioIds.musicDesertNightSleepingCityLoop)?.volume ?? 0;
      expect(ids).toContain(successorAudioIds.settlementMurmurLoop);
      expect(ids).toContain(successorAudioIds.musicDesertNightSleepingCityLoop);
      expect(ids).not.toContain("music_glacial_remnant_loop");
      expect(sleepingCity).toBeGreaterThan(0.3);
      expect(dayPrimary).toBe(0);
    });

    it("keeps the desert night to the canonical settlement and music loops", () => {
      const night = makeState({ phase: "night" });
      const sfx = sfxRecorder();
      const slice = makeSlice();
      for (let time = 0; time <= 53_000; time += 1_000) {
        updateRuntimeAudio(night, slice, sfx, time);
      }
      expect(sfx.loops.some((loop) => loop.id === successorAudioIds.settlementMurmurLoop)).toBe(true);
      expect(sfx.loops.some((loop) => loop.id === successorAudioIds.musicDesertNightSleepingCityLoop)).toBe(true);
    });

    it("fires rare distant cricket one-shots at night, quieter than footsteps, minutes apart", () => {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        const night = makeState({ phase: "night" });
        const sfx = sfxRecorder();
        const slice = makeSlice();
        updateRuntimeAudio(night, slice, sfx, 0); // primes nextOneShotAtMs = 0.35*minDelay
        const firstDue = 90_000 * 0.35;
        updateRuntimeAudio(night, slice, sfx, firstDue - 1_000);
        expect(sfx.playedAt.filter((id) => id.startsWith("amb_night_cricket_distant_"))).toHaveLength(0);
        updateRuntimeAudio(night, slice, sfx, firstDue + 1_000);
        const chirps = sfx.playedAt
          .map((id, index) => ({ id, options: sfx.playAtOptions[index] }))
          .filter((entry) => entry.id.startsWith("amb_night_cricket_distant_"));
        expect(chirps).toHaveLength(1);
        // Half-level owner retune: far below the footstep one-shot volume (0.42).
        expect(chirps[0]!.options?.volume ?? 1).toBeCloseTo(0.13);
        // Rare: the next chirp is scheduled at least minDelayMs (90s) out.
        const key = "open-desert-overworld:night-crickets";
        expect(night.runtimeAudio.nextOneShotAtMs[key] ?? 0).toBeGreaterThanOrEqual(firstDue + 1_000 + 90_000);
        // Day never chirps: nightOnly layer.
        const day = makeState({ phase: "day" });
        const daySfx = sfxRecorder();
        updateRuntimeAudio(day, slice, daySfx, 0);
        updateRuntimeAudio(day, slice, daySfx, 400_000);
        expect(daySfx.playedAt.filter((id) => id.startsWith("amb_night_cricket_distant_"))).toHaveLength(0);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  describe("updateRuntimeAudio — combat music crossfade", () => {
    it("engages a combat track on the local player's inCombat flag and fades back out ~6s after disengage", () => {
      const state = makeState();
      const sfx = sfxRecorder();
      const slice = makeSlice();
      updateRuntimeAudio(state, slice, sfx, 0);

      const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
      const player = state.serverAuthority.actors[playerActorId]!;
      const pool = profileForArea("open-desert-overworld").combatMusicIds!;

      // Engage: the streamed local-player inCombat flag goes true.
      player.inCombat = true;
      updateRuntimeAudio(state, slice, sfx, 1_000);
      expect(state.runtimeAudio.activeCombatMusicId).not.toBeNull();
      expect(pool).toContain(state.runtimeAudio.activeCombatMusicId);
      const activeCombatTrack = state.runtimeAudio.activeCombatMusicId!;
      expect(sfx.loops.find((loop) => loop.id === activeCombatTrack)?.fadeMs).toBe(1_100);

      // Disengage: flag drops, but music lingers inside the 6s window.
      player.inCombat = false;
      updateRuntimeAudio(state, slice, sfx, 5_000);
      expect(state.runtimeAudio.activeCombatMusicId).not.toBeNull();

      // Past the ~6s tail from the last combat tick, the track clears.
      updateRuntimeAudio(state, slice, sfx, 8_000);
      expect(state.runtimeAudio.activeCombatMusicId).toBeNull();
      expect(sfx.stopEvents).toContainEqual({ id: activeCombatTrack, fadeMs: 1_100 });
    });

    it("crossfades every loop over 900ms when the listener changes areas", () => {
      const state = makeState();
      const sfx = sfxRecorder();
      const slice = makeSlice();
      updateRuntimeAudio(state, slice, sfx, 0);
      state.activeAreaId = "some-other-area";
      updateRuntimeAudio(state, slice, sfx, 1_000);

      expect(sfx.stopAllFadeMs).toEqual([900, 900]);
    });

  });

  describe("updateRuntimeAudio — weather", () => {
    it("keeps storm audio silent when streamed weather intensity is zero", () => {
      const state = makeState({ weather: [stormWeather({ intensity: 0, magnitude: 1 })] });
      const sfx = sfxRecorder();
      updateRuntimeAudio(state, makeSlice(), sfx, 0);

      expect(sfx.loops.some((loop) => loop.id === successorAudioIds.rainLightLoop || loop.id === successorAudioIds.rainHeavyLoop)).toBe(false);
      expect(sfx.playedAt.some((id) => (successorAudioIds.thunder as readonly string[]).includes(id))).toBe(false);
    });

    it("plays deterministic thunder for strong sandstorms", () => {
      const state = makeState({ weather: [stormWeather({ intensity: 1, magnitude: 0.9 })] });
      const sfx = sfxRecorder();
      updateRuntimeAudio(state, makeSlice(), sfx, 0);

      const thunder = sfx.playedAt.filter((id) => (successorAudioIds.thunder as readonly string[]).includes(id));
      expect(thunder.length).toBe(1);
    });
    it("preserves heavy rain", () => {
      const state = makeState({ weather: [stormWeather({ eventType: "heavy-rain", intensity: 1, magnitude: 0.9 })] });
      const sfx = sfxRecorder();
      updateRuntimeAudio(state, makeSlice(), sfx, 0);

      expect(sfx.loops.some((loop) => loop.id === successorAudioIds.rainHeavyLoop)).toBe(true);
      expect(sfx.loops.some((loop) => loop.id === successorAudioIds.rainLightLoop)).toBe(false);
      expect(sfx.playedAt.some((id) => (successorAudioIds.thunder as readonly string[]).includes(id))).toBe(true);
    });
  });

  describe("authority-driven audio hooks", () => {
    it("plays credits_chime for positive local credit receipt deltas while honoring min-spacing", () => {
      const slice = makeAuthoritySlice();
      const state = createPlayState(slice);
      const sfx = sfxRecorder();
      applyServerPacket(state, slice, {
        type: "game.hello",
        sessionId: "g_1",
        playerActorId: "player",
        serverTime: "1970-01-01T00:00:00.000Z",
        snapshot: shardSnapshot(),
      } as never, sfx);

      state.worldTimeMs = 1_000;
      applyServerPacket(state, slice, {
        type: "game.delta",
        receipts: [{ commandId: 1001, accepted: true, tick: 21 }],
        delta: {
          schema: "successor.authoritative-shard-delta.v1",
          shardId: "test",
          tick: 21,
          playerActorId: "player",
          actors: { player: actorSnapshot("player", 10, 10, 140) },
          counters: counters(),
        },
        events: [],
      } as never, sfx);

      state.worldTimeMs = 1_100;
      applyServerPacket(state, slice, {
        type: "game.delta",
        receipts: [{ commandId: 1002, accepted: true, tick: 22 }],
        delta: {
          schema: "successor.authoritative-shard-delta.v1",
          shardId: "test",
          tick: 22,
          playerActorId: "player",
          actors: { player: actorSnapshot("player", 10, 10, 160) },
          counters: counters(),
        },
        events: [],
      } as never, sfx);

      state.worldTimeMs = 1_400;
      applyServerPacket(state, slice, {
        type: "game.delta",
        receipts: [{ commandId: 1003, accepted: true, tick: 23 }],
        delta: {
          schema: "successor.authoritative-shard-delta.v1",
          shardId: "test",
          tick: 23,
          playerActorId: "player",
          actors: { player: actorSnapshot("player", 10, 10, 180) },
          counters: counters(),
        },
        events: [],
      } as never, sfx);

      expect(sfx.played.filter((id) => id === successorAudioIds.creditsChime)).toHaveLength(2);
    });

    it("plays door_slide positionally when a streamed door state toggles", () => {
      const slice = makeAuthoritySlice();
      slice.props.push({
        id: "door-house",
        entity: "prop/door-house",
        areaId: "open-desert-overworld",
        label: "Door House",
        kind: "prop",
        cell: { x: 10, y: 4 },
        size: { w: 5, h: 4 },
        interactive: false,
        solid: false,
        door: { blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295 }, interactRadiusCells: 2.2 },
      });
      const state = createPlayState(slice);
      const sfx = sfxRecorder();
      applyServerPacket(state, slice, {
        type: "game.hello",
        sessionId: "g_1",
        playerActorId: "player",
        serverTime: "1970-01-01T00:00:00.000Z",
        snapshot: shardSnapshot({ propStates: { "door-house": { doorOpen: false } } }),
      } as never, sfx);
      state.serverAuthority.sentCommandLog.push({
        commandId: 88,
        kind: "ToggleDoor",
        sentAtMs: 0,
        propId: "door-house",
      });
      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 88, accepted: true, tick: 21 }],
        events: [],
      } as never, sfx);


      applyServerPacket(state, slice, {
        type: "game.delta",
        receipts: [],
        delta: {
          schema: "successor.authoritative-shard-delta.v1",
          shardId: "test",
          tick: 21,
          playerActorId: "player",
          actors: {},
          propStates: { "door-house": { doorOpen: true } },
          counters: counters(),
        },
        events: [],
      } as never, sfx);

      expect(sfx.playedAt).toContain(successorAudioIds.doorSlide);
      expect(sfx.playedAt.filter((id) => id === successorAudioIds.doorSlide)).toHaveLength(1);
      const position = sfx.playAtPositions[sfx.playedAt.indexOf(successorAudioIds.doorSlide)]!;
      expect(position.x).toBeCloseTo(13.04);
      expect(position.y).toBeCloseTo(7.8525);
    });


    it("spawns HARVESTED floating status and plays positional inventory_transfer audio on accepted HarvestCorpse receipt", () => {
      const slice = makeAuthoritySlice();
      const state = createPlayState(slice);
      state.serverAuthority.connected = true;
      state.serverAuthority.status = "connected";
      state.serverAuthority.playerActorId = state.playerActorId;
      state.serverAuthority.sourceMatchesClient = true;

      state.serverAuthority.actors["creature_1"] = {
        id: "creature_1",
        areaId: "open-desert-overworld",
        x: 12,
        y: 18,
        entity: "desert_wolf",
        label: "Desert Wolf",
        lifeState: "dead",
        direction: "south",
        vitals: { health: 0, stamina: 0 },
        maxVitals: { health: 100, stamina: 100 },
      } as never;

      const sfx = sfxRecorder();

      state.serverAuthority.sentCommandLog.push({
        commandId: 101,
        kind: "HarvestCorpse",
        sentAtMs: 100,
        targetActorId: "creature_1",
      });

      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 101, accepted: true, tick: 50 }],
        events: [],
      } as never, sfx);

      const statusText = state.floatingTexts.find((t) => t.actorId === "creature_1");
      expect(statusText).toBeDefined();
      expect(statusText?.label).toBe("HARVESTED");
      expect(statusText?.color).toBe("#a3be8c");
      expect(statusText?.x).toBeCloseTo(12.5);
      expect(statusText?.y).toBeCloseTo(16.28);

      expect(sfx.playedAt).toContain("inventory_transfer");
      const sfxIdx = sfx.playedAt.indexOf("inventory_transfer");
      expect(sfx.playAtPositions[sfxIdx]).toEqual({ x: 12.5, y: 18.5 });
    });

    it("suppresses harvest 3D feedback on duplicate, rejected, or missing/wrong-area target actor", () => {
      const slice = makeAuthoritySlice();
      const state = createPlayState(slice);
      state.serverAuthority.connected = true;
      state.serverAuthority.status = "connected";
      state.serverAuthority.playerActorId = state.playerActorId;
      state.serverAuthority.sourceMatchesClient = true;

      state.serverAuthority.actors["creature_other_area"] = {
        id: "creature_other_area",
        areaId: "some-other-area",
        x: 10,
        y: 10,
      } as never;

      const sfx = sfxRecorder();

      // Case 1: Rejected receipt
      state.serverAuthority.sentCommandLog.push({
        commandId: 201,
        kind: "HarvestCorpse",
        sentAtMs: 200,
        targetActorId: "creature_1",
      });
      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 201, accepted: false, tick: 60 }],
        events: [],
      } as never, sfx);

      expect(state.floatingTexts).toHaveLength(0);
      expect(sfx.playedAt).not.toContain("inventory_transfer");

      // Case 2: Missing target actor
      state.serverAuthority.sentCommandLog.push({
        commandId: 202,
        kind: "HarvestCorpse",
        sentAtMs: 210,
        targetActorId: "nonexistent_actor",
      });
      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 202, accepted: true, tick: 61 }],
        events: [],
      } as never, sfx);

      expect(state.floatingTexts).toHaveLength(0);
      expect(sfx.playedAt).not.toContain("inventory_transfer");

      // Case 3: Target actor in wrong area
      state.serverAuthority.sentCommandLog.push({
        commandId: 203,
        kind: "HarvestCorpse",
        sentAtMs: 220,
        targetActorId: "creature_other_area",
      });
      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 203, accepted: true, tick: 62 }],
        events: [],
      } as never, sfx);

      expect(state.floatingTexts).toHaveLength(0);
      expect(sfx.playedAt).not.toContain("inventory_transfer");

      // Case 4: Duplicate receipt processing
      state.serverAuthority.actors["creature_2"] = {
        id: "creature_2",
        areaId: "open-desert-overworld",
        x: 5,
        y: 5,
      } as never;
      state.serverAuthority.sentCommandLog.push({
        commandId: 204,
        kind: "HarvestCorpse",
        sentAtMs: 230,
        targetActorId: "creature_2",
      });
      // First receipt (accepted)
      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 204, accepted: true, tick: 63 }],
        events: [],
      } as never, sfx);
      expect(state.floatingTexts).toHaveLength(1);
      expect(sfx.playedAt.filter((s) => s === "inventory_transfer")).toHaveLength(1);

      // Duplicate receipt (same commandId)
      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 204, accepted: true, tick: 63 }],
        events: [],
      } as never, sfx);
      expect(state.floatingTexts).toHaveLength(1);
      expect(sfx.playedAt.filter((s) => s === "inventory_transfer")).toHaveLength(1);
    });

    it("starts and stops survey_pull_loop from accepted SampleResource and SurveyResource receipts", () => {
      const slice = makeAuthoritySlice();
      const state = createPlayState(slice);
      state.serverAuthority.connected = true;
      state.serverAuthority.status = "connected";
      state.serverAuthority.playerActorId = state.playerActorId;
      state.serverAuthority.sourceMatchesClient = true;
      const sfx = sfxRecorder();
      state.worldTimeMs = 500;
      state.serverAuthority.sentCommandLog.push({
        commandId: 77,
        kind: "SampleResource",
        sentAtMs: 480,
      });
      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 77, accepted: true, tick: 30 }],
        events: [],
      } as never, sfx);

      updateRuntimeAudio(state, slice, sfx, 500);
      expect(sfx.loops.some((loop) => loop.id === successorAudioIds.surveyPullLoop)).toBe(true);

      updateRuntimeAudio(state, slice, sfx, 3_500);
      expect(sfx.stopped).toContain(successorAudioIds.surveyPullLoop);

      state.worldTimeMs = 4_000;
      state.serverAuthority.sentCommandLog.push({
        commandId: 78,
        kind: "SurveyResource",
        sentAtMs: 3_980,
      });
      applyServerPacket(state, slice, {
        type: "game.receipts",
        receipts: [{ commandId: 78, accepted: true, tick: 31 }],
        events: [],
      } as never, sfx);
      updateRuntimeAudio(state, slice, sfx, 4_000);
      expect(sfx.loops.filter((loop) => loop.id === successorAudioIds.surveyPullLoop)).toHaveLength(2);
    });
  });

  describe("updateRuntimeAudio — footsteps", () => {
    it("fires local-player grass footsteps at stride cadence only while moving", () => {
      const state = makeState();
      const sfx = sfxRecorder();
      const slice = makeSlice();
      updateRuntimeAudio(state, slice, sfx, 0); // prime lastFootstepPlayer

      // Stationary + moving true: no distance, no step.
      state.moving = true;
      updateRuntimeAudio(state, slice, sfx, 200);
      expect(sfx.playedAt.some((id) => id.startsWith("footstep_grass_"))).toBe(false);

      // Move past the grass stride spacing (~0.53 cells): a step fires.
      state.player.x += 0.6;
      updateRuntimeAudio(state, slice, sfx, 400);
      const steps = sfx.playedAt.filter((id) => id.startsWith("footstep_grass_"));
      expect(steps.length).toBe(1);
    });

    it("plays positional footsteps for nearby moving NPCs but excludes the local player and culls distant/dead ones", () => {
      const state = makeState({
        actors: {
          player: { id: "player", x: 10, y: 10, areaId: "open-desert-overworld", lifeState: "alive" },
          near: { id: "near", x: 12, y: 10, areaId: "open-desert-overworld", lifeState: "alive" },
          far: { id: "far", x: 60, y: 60, areaId: "open-desert-overworld", lifeState: "alive" },
          dead: { id: "dead", x: 11, y: 10, areaId: "open-desert-overworld", lifeState: "downed" },
        },
      });
      const sfx = sfxRecorder();
      const slice = makeSlice();
      updateRuntimeAudio(state, slice, sfx, 0); // prime NPC trackers

      // Move every NPC past the NPC stride spacing (~0.62 cells).
      state.serverAuthority.actors.near!.x = 12.7; // moved 0.7, in range
      state.serverAuthority.actors.far!.x = 60.7; // moved but beyond cull distance
      state.serverAuthority.actors.dead!.x = 11.7; // moved but downed
      updateRuntimeAudio(state, slice, sfx, 250);

      const steps = sfx.playedAt.filter((id) => id.startsWith("footstep_grass_"));
      // Only the nearby living NPC produced a step.
      expect(steps.length).toBe(1);
    });
  });
});
