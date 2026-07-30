import { describe, expect, it } from "vitest";
import type { SfxPlayer, SfxProceduralKind, SfxProceduralOptions, SfxPoint, SfxPlayOptions } from "../audio/sfx";
import {
  combatAudioListenerPosition,
  combatAudioSeed,
  deterministicAudioUnit,
  playWeaponFireAudio,
  updateCombatAudioBursts,
} from "./combatAudioSystem";
import { rollBurstDelayMsForOrdinal } from "./rollBurstCadence";
import { createRuntimeCombatAudioState, type PlayState } from "./gameState";

function sfxRecorder(): SfxPlayer & {
  playedAt: string[];
  playAtOptions: SfxPlayOptions[];
  procedural: SfxProceduralKind[];
} {
  const recorder = {
    playedAt: [] as string[],
    playAtOptions: [] as SfxPlayOptions[],
    procedural: [] as SfxProceduralKind[],
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
    play: () => undefined,
    playAt: (id: string, _position: SfxPoint, options?: SfxPlayOptions) => {
      recorder.playedAt.push(id);
      recorder.playAtOptions.push(options ?? {});
    },
    playProceduralAt: (kind: SfxProceduralKind, _position: SfxPoint, _options?: SfxProceduralOptions) => {
      recorder.procedural.push(kind);
    },
  };
  return recorder as SfxPlayer & {
    playedAt: string[];
    playAtOptions: SfxPlayOptions[];
    procedural: SfxProceduralKind[];
  };
}

function state(overrides: Partial<PlayState> = {}): PlayState {
  return {
    playerActorId: "camera",
    player: { x: 4, y: 0 },
    worldTimeMs: 0,
    observerCamera: { followActorId: "listener", inputLocked: true },
    serverAuthority: { playerActorId: "camera" },
    runtimeAudio: {
      ambientAreaId: null,
      loopVolumes: {},
      nextOneShotAtMs: {},
      footstepDistanceCells: 0,
      footstepIndex: 0,
      lastFootstepPlayer: null,
      lastStepAtMs: -Infinity,
      lastShotsFired: 0,
      lastCombatAudioAtMs: -Infinity,
      combat: createRuntimeCombatAudioState(),
    },
    ...overrides,
  } as PlayState;
}

describe("combatAudioSystem", () => {
  it("keeps automatic remote fire as spatial transients without stacked tail/casing clutter", () => {
    const play = state();
    const sfx = sfxRecorder();
    const position = { x: 10, y: 5 };
    const direction = { x: 1, y: 0 };

    playWeaponFireAudio(play, sfx, {
      shooterActorId: "rogue-1",
      weaponId: "slugthrower",
      position,
      direction,
      eventId: 101,
    });
    play.worldTimeMs = 100;
    playWeaponFireAudio(play, sfx, {
      shooterActorId: "rogue-1",
      weaponId: "slugthrower",
      position,
      direction,
      eventId: 102,
    });
    play.worldTimeMs = 310;
    updateCombatAudioBursts(play, sfx, play.worldTimeMs);

    expect(sfx.playedAt[0]).toBe("slugthrower_fire");
    expect(sfx.playedAt.filter((id) => id === "slugthrower_fire")).toHaveLength(2);
    expect(sfx.playedAt.some((id) => id.startsWith("gunshot_"))).toBe(false);
    expect(sfx.playedAt.some((id) => id.startsWith("casing_bounce_slugthrower_"))).toBe(false);
    const firstShotIndex = sfx.playedAt.findIndex((id) => id === "slugthrower_fire");
    expect(sfx.playAtOptions[firstShotIndex]?.volume).toBeLessThan(0.28);
    expect(play.runtimeAudio.combat.metrics).toMatchObject({
      shotEvents: 2,
      transientPlays: 2,
      burstStarts: 1,
      burstContinuations: 1,
    });
    expect(play.runtimeAudio.combat.metrics.burstTailPlays).toBe(0);
    expect(play.runtimeAudio.combat.metrics.burstTailSuppressions).toBe(0);
    expect(play.runtimeAudio.combat.metrics.casingLayerPlays).toBe(0);
  });

  it("adds an audible local slugthrower tail and casing layers under the main crack", () => {
    const play = state();
    const sfx = sfxRecorder();

    playWeaponFireAudio(play, sfx, {
      shooterActorId: "camera",
      weaponId: "slugthrower",
      position: combatAudioListenerPosition(play),
      direction: { x: 1, y: 0 },
      eventId: 501,
      local: true,
    });

    expect(sfx.playedAt[0]).toBe("slugthrower_fire");
    const tailId = sfx.playedAt.find((id) => id.startsWith("gunshot_"));
    expect(tailId).toBeDefined();
    expect(tailId).not.toBe("gunshot_2");
    expect(sfx.playedAt.some((id) => id.startsWith("casing_bounce_slugthrower_"))).toBe(true);
    const crackVolume = sfx.playAtOptions[sfx.playedAt.indexOf("slugthrower_fire")]?.volume ?? 0;
    const tailVolume = sfx.playAtOptions[sfx.playedAt.findIndex((id) => id.startsWith("gunshot_"))]?.volume ?? 0;
    const casingVolume = sfx.playAtOptions[sfx.playedAt.findIndex((id) => id.startsWith("casing_bounce_slugthrower_"))]?.volume ?? 0;
    expect(crackVolume).toBeCloseTo(0.65);
    expect(tailVolume).toBeCloseTo(0.32);
    expect(casingVolume).toBeCloseTo(0.38);
    expect(tailVolume).toBeGreaterThan(0.3);
    expect(casingVolume).toBeGreaterThan(0.3);
    expect(tailVolume).toBeLessThan(crackVolume);
    expect(casingVolume).toBeLessThan(crackVolume);
  });

  it("keeps melee-family fire out of gunshot audio", () => {
    const play = state();
    const sfx = sfxRecorder();

    expect(playWeaponFireAudio(play, sfx, {
      shooterActorId: "camera",
      weaponId: "vibrosword",
      position: combatAudioListenerPosition(play),
      direction: { x: 1, y: 0 },
      eventId: 701,
      local: true,
    })).toBe(false);

    expect(sfx.playedAt).toEqual([]);
    expect(play.runtimeAudio.combat.metrics.shotEvents).toBe(0);
    expect(play.runtimeAudio.combat.metrics.transientPlays).toBe(0);
  });

  it("uses the shared 115ms roll-burst cadence for six-pellet readout", () => {
    expect([0, 1, 2, 3, 4, 5].map((ordinal) => rollBurstDelayMsForOrdinal(ordinal))).toEqual([
      0,
      115,
      230,
      345,
      460,
      575,
    ]);
  });

  it("keeps a render-late 115ms local burst in one audio tail group", () => {
    const play = state();
    const sfx = sfxRecorder();
    const position = combatAudioListenerPosition(play);

    playWeaponFireAudio(play, sfx, {
      shooterActorId: "camera",
      weaponId: "slugthrower",
      position,
      direction: { x: 1, y: 0 },
      eventId: 610,
      local: true,
    });
    play.worldTimeMs = rollBurstDelayMsForOrdinal(1) + 80;
    playWeaponFireAudio(play, sfx, {
      shooterActorId: "camera",
      weaponId: "slugthrower",
      position,
      direction: { x: 1, y: 0 },
      eventId: 611,
      local: true,
    });

    expect(sfx.playedAt.filter((id) => id === "slugthrower_fire")).toHaveLength(2);
    expect(sfx.playedAt.filter((id) => id.startsWith("gunshot_"))).toHaveLength(1);
    expect(play.runtimeAudio.combat.metrics.burstStarts).toBe(1);
    expect(play.runtimeAudio.combat.metrics.burstContinuations).toBe(1);
    expect(play.runtimeAudio.combat.metrics.burstTailPlays).toBe(1);
  });

  it("records weapon fire spatial gain and pan around the camera listener", () => {
    const play = state();
    const sfx = sfxRecorder();

    expect(combatAudioListenerPosition(play)).toEqual({ x: 4.5, y: 0.5 });

    playWeaponFireAudio(play, sfx, {
      shooterActorId: "rogue-left",
      weaponId: "slugthrower",
      position: { x: -40, y: 0 },
      direction: { x: 1, y: 0 },
      eventId: 301,
    });
    play.worldTimeMs = 220;
    playWeaponFireAudio(play, sfx, {
      shooterActorId: "rogue-near",
      weaponId: "slugthrower",
      position: combatAudioListenerPosition(play),
      direction: { x: 1, y: 0 },
      eventId: 302,
    });

    const metrics = play.runtimeAudio.combat.metrics;
    expect(metrics.weaponSpatialSamples).toBe(2);
    expect(metrics.weaponSpatialGainMin).toBeLessThan(0.4);
    expect(metrics.weaponSpatialGainMax).toBeGreaterThan(0.9);
    expect(metrics.weaponSpatialPanAbsMax).toBeGreaterThan(0.4);
    expect(metrics.weaponSpatialFarEvents).toBe(1);
    expect(metrics.weaponSpatialNearEvents).toBe(1);
    expect(metrics.recentEvents.at(-1)?.gain).toBeGreaterThan(0.9);
  });

  it("suppresses duplicate authoritative shot-event audio", () => {
    const play = state();
    const sfx = sfxRecorder();
    const params = {
      shooterActorId: "rogue-1",
      weaponId: "slugthrower" as const,
      position: { x: 10, y: 5 },
      direction: { x: 1, y: 0 },
      eventId: 101,
    };

    expect(playWeaponFireAudio(play, sfx, params)).toBe(true);
    const playedAfterFirst = sfx.playedAt.length;
    play.worldTimeMs = 120;
    expect(playWeaponFireAudio(play, sfx, params)).toBe(false);

    expect(sfx.playedAt).toHaveLength(playedAfterFirst);
    expect(play.runtimeAudio.combat.metrics.shotEvents).toBe(1);
    expect(play.runtimeAudio.combat.metrics.duplicateShotEventSuppressions).toBe(1);
  });

  it("keeps pitch variation deterministic from shooter, weapon, and event id", () => {
    const seed = combatAudioSeed("rogue-1", "slugthrower", 77);
    expect(seed).toBe(combatAudioSeed("rogue-1", "slugthrower", 77));
    expect(deterministicAudioUnit(seed, 17)).toBe(deterministicAudioUnit(seed, 17));
    expect(combatAudioSeed("rogue-1", "slugthrower", 78)).not.toBe(seed);
  });
});
