import { requireRuntimePublicPath } from "../slice-core/runtimePublicPaths";

interface SfxManifest {
  schema: string;
  buses: Record<string, { volume: number; polyphony: number }>;
  clips: SfxManifestClip[];
}

interface SfxManifestClip {
  id: string;
  path: string;
  bus: string;
  volume: number;
  polyphony: number;
  durationSeconds: number | null;
  maxPlaybackMs?: number;
  fadeOutMs?: number;
  playbackRate?: number;
  minSpacingMs?: number;
  loop?: boolean;
  /** Optional authored loop window (seconds) — lets an OST track with a silent
   * intro/outro wrap over its musical body instead of the dead air
   * (soundscape remix 2026-07-09: sleeping_city 208+182ms hole, sandstorm_run
   * 474ms hole, both measured on Chrome decodeAudioData output). */
  loopStartSeconds?: number;
  loopEndSeconds?: number;
}

export interface SfxPoint {
  x: number;
  y: number;
}

export interface SfxPlayOptions {
  volume?: number;
  maxDistanceCells?: number;
  minDistanceCells?: number;
  panDistanceCells?: number;
  maxPan?: number;
  rolloff?: number;
  /**
   * Optional distant-presence bias before the final cutoff taper. Positional
   * audio always reaches silence at maxDistanceCells.
   */
  farGainFloor?: number;
  playbackRate?: number;
  fadeMs?: number;
}

export type SfxProceduralKind = "bullet_crack" | "bullet_whiz";

export interface SfxProceduralOptions extends SfxPlayOptions {
  durationMs?: number;
  intensity?: number;
  seed?: number;
}

export interface SfxSpatialMix {
  distanceCells: number;
  gain: number;
  pan: number;
}

interface LoadedSfxClip {
  buffer: AudioBuffer;
  bus: string;
  volume: number;
  polyphony: number;
  maxPlaybackMs: number | null;
  fadeOutMs: number;
  playbackRate: number;
  minSpacingMs: number;
  loop: boolean;
  loopStartSeconds: number | null;
  loopEndSeconds: number | null;
  active: number;
  lastStartAt: number;
}

interface ActiveSfxLoop {
  source: AudioBufferSourceNode;
  gain: GainNode;
  stopTimer: number | null;
}

interface SfxDebugError {
  id: string | null;
  reason: string;
  path?: string;
  atMs: number;
}

interface SfxDebugProbe {
  ready: boolean;
  unlocked: boolean;
  clipCount: number;
  lastPlayed: string | null;
  listener: SfxPoint | null;
  lastDistanceCells: number | null;
  lastPan: number;
  lastGain: number;
  errors: SfxDebugError[];
  activeLoops?: string[];
  recentPlayed?: Array<{
    id: string;
    atMs: number;
    distanceCells: number | null;
    gain: number;
    pan: number;
  }>;
  /** Dev/probe hook: invokes the real play() path; functions are omitted from JSON dumps. */
  playForProbe?: (id: string) => void;
}

export interface SfxPlayer {
  readonly probe: SfxDebugProbe;
  load: () => Promise<void>;
  setListenerPosition: (position: SfxPoint) => void;
  play: (id: string, options?: SfxPlayOptions) => void;
  playAt: (id: string, position: SfxPoint, options?: SfxPlayOptions) => void;
  playProceduralAt?: (kind: SfxProceduralKind, position: SfxPoint, options?: SfxProceduralOptions) => void;
  setLoop?: (id: string, options?: SfxPlayOptions) => void;
  stopLoop?: (id: string, fadeMs?: number) => void;
  stopAllLoops?: (fadeMs?: number) => void;
}

declare global {
  interface Window {
    __successorSfx?: SfxDebugProbe;
  }
}

const defaultManifestPath = "/successor-audio/sfx/manifest.json";

export function createSfxPlayer(manifestPath = defaultManifestPath): SfxPlayer {
  let context: AudioContext | null = null;
  let output: AudioNode | null = null;
  let manifest: SfxManifest | null = null;
  let loadPromise: Promise<void> | null = null;
  let listenerPosition: SfxPoint | null = null;
  const clips = new Map<string, LoadedSfxClip>();
  const activeLoops = new Map<string, ActiveSfxLoop>();
  /** Loop requests issued before the manifest finished decoding; null = a stop
   * superseded the pending start. Consumed exactly once when load resolves. */
  const pendingLoopIntents = new Map<string, SfxPlayOptions | null>();
  const missingClipPlayLog = new Set<string>();
  const probe: SfxDebugProbe = {
    ready: false,
    unlocked: false,
    clipCount: 0,
    lastPlayed: null,
    listener: null,
    lastDistanceCells: null,
    lastPan: 0,
    lastGain: 1,
    errors: [],
    activeLoops: [],
    recentPlayed: [],
  };
  window.__successorSfx = probe;

  const ensureContext = () => {
    context ??= new AudioContext();
    return context;
  };

  const ensureOutput = () => {
    const audio = ensureContext();
    if (output) return output;
    // Master bus = SAFETY compressor, not glue (soundscape remix 2026-07-09).
    // The previous -18dBTh/12:1/120ms shape was measured (Chrome
    // OfflineAudioContext, staged clips) holding ~7dB of gain reduction
    // CONTINUOUSLY during 600RPM fire — the whole soundscape pumped at fire
    // cadence (the owner's "almost like feedback"), and its auto-makeup lifted
    // all sub-threshold content +6dB over the manifest bus targets. This shape
    // takes ~1.5dB on gunshot crests and 0dB on everything else; master gain
    // compensates the makeup delta so the ratified door lands at its old level.
    const compressor = audio.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    const master = audio.createGain();
    master.gain.value = 1.36;
    compressor.connect(master);
    master.connect(audio.destination);
    output = compressor;
    return output;
  };

  const unlock = () => {
    const audio = ensureContext();
    if (audio.state === "suspended") {
      void audio.resume()
        .then(() => {
          probe.unlocked = audio.state === "running";
        })
        .catch((error: unknown) => recordError(error));
      return;
    }
    probe.unlocked = true;
  };

  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);

  const load = async () => {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const audio = ensureContext();
      const resolvedManifestPath = requireRuntimePublicPath(manifestPath);
      const response = await fetch(resolvedManifestPath, { cache: "no-store" });
      if (!response.ok) throw new Error(`failed to fetch ${resolvedManifestPath}: ${response.status}`);
      manifest = await response.json() as SfxManifest;
      await Promise.all(manifest.clips.map(async (clip) => {
        try {
          const clipPath = requireRuntimePublicPath(clip.path);
          const clipResponse = await fetch(clipPath);
          if (!clipResponse.ok) throw new Error(`failed to fetch ${clipPath}: ${clipResponse.status}`);
          const bytes = await clipResponse.arrayBuffer();
          const buffer = await audio.decodeAudioData(bytes.slice(0));
          clips.set(clip.id, {
            buffer,
            bus: clip.bus,
            volume: clip.volume,
            polyphony: clip.polyphony,
            maxPlaybackMs: typeof clip.maxPlaybackMs === "number" ? clip.maxPlaybackMs : null,
            fadeOutMs: typeof clip.fadeOutMs === "number" ? clip.fadeOutMs : 0,
            playbackRate: typeof clip.playbackRate === "number" ? clip.playbackRate : 1,
            minSpacingMs: typeof clip.minSpacingMs === "number" ? clip.minSpacingMs : (clip.bus === "weapons" ? 32 : 0),
            loop: clip.loop === true,
            loopStartSeconds: typeof clip.loopStartSeconds === "number" ? clip.loopStartSeconds : null,
            loopEndSeconds: typeof clip.loopEndSeconds === "number" ? clip.loopEndSeconds : null,
            active: 0,
            lastStartAt: -Infinity,
          });
        } catch (error: unknown) {
          recordError(error, clip.id, clip.path);
        }
      }));
      probe.ready = true;
      probe.clipCount = clips.size;
    })().catch((error: unknown) => {
      recordError(error, "manifest", manifestPath);
      throw error;
    });
    return loadPromise;
  };

  const setListenerPosition = (position: SfxPoint) => {
    listenerPosition = { ...position };
    probe.listener = { ...position };
  };

  const play = (id: string, options: SfxPlayOptions = {}) => {
    playClip(id, options);
  };
  Object.defineProperty(probe, "playForProbe", {
    value: (id: string) => play(id),
    enumerable: false,
  });

  const playAt = (id: string, position: SfxPoint, options: SfxPlayOptions = {}) => {
    playClip(id, { ...options, position });
  };

  const playProceduralAt = (kind: SfxProceduralKind, position: SfxPoint, options: SfxProceduralOptions = {}) => {
    playProcedural(kind, { ...options, position });
  };

  const setLoop = (id: string, options: SfxPlayOptions = {}) => {
    // Record the intent BEFORE the async load hop: a stopLoop issued while the
    // manifest is still decoding must win over an earlier queued start, or the
    // loop starts anyway and plays forever at a stale volume (orphaned-loop
    // race, soundscape remix 2026-07-09).
    pendingLoopIntents.set(id, options);
    void load()
      .then(() => {
        const intent = pendingLoopIntents.get(id);
        if (intent === undefined) return; // consumed by a newer call
        pendingLoopIntents.delete(id);
        if (intent === null) {
          stopActiveLoop(id, 700);
          return;
        }
        startLoop(id, intent);
      })
      .catch((error: unknown) => recordError(error));
  };

  const stopLoop = (id: string, fadeMs = 700) => {
    if (pendingLoopIntents.has(id)) pendingLoopIntents.set(id, null);
    stopActiveLoop(id, fadeMs);
  };

  const stopAllLoops = (fadeMs = 700) => {
    for (const id of pendingLoopIntents.keys()) pendingLoopIntents.set(id, null);
    for (const id of activeLoops.keys()) stopActiveLoop(id, fadeMs);
  };

  const playClip = (id: string, options: SfxPlayOptions & { position?: SfxPoint } = {}) => {
    void load()
      .then(() => {
        const audio = ensureContext();
        if (audio.state === "suspended") void audio.resume();
        const clip = clips.get(id);
        if (!clip) {
          recordMissingClipPlay(id);
          return;
        }
        const bus = manifest?.buses[clip.bus];
        const minSpacingMs = clip.minSpacingMs;
        if (minSpacingMs > 0 && (audio.currentTime - clip.lastStartAt) * 1000 < minSpacingMs) return;
        const overloadVoices = Math.max(0, clip.active - clip.polyphony + 1);
        if (clip.active >= hardPolyphonyLimit(clip)) return;
        const spatial = options.position && listenerPosition
          ? computeSfxSpatialMix(listenerPosition, options.position, options)
          : { gain: 1, pan: 0, distanceCells: null };
        const busVolume = bus?.volume ?? 1;
        const now = audio.currentTime;
        const concurrencyGain = voiceConcurrencyGain(overloadVoices);
        const peakGain = Math.min(0.95, clip.volume * busVolume * (options.volume ?? 1) * spatial.gain * concurrencyGain);
        // Do not spend a Web Audio voice on a positional sound that has
        // reached its authored cutoff. Besides avoiding needless polyphony,
        // this guarantees remote foley cannot leak across the map at a tiny
        // residual gain.
        if (peakGain <= 0.001) return;
        const source = audio.createBufferSource();
        const gain = audio.createGain();
        const panner = options.position && listenerPosition ? audio.createStereoPanner() : null;
        gain.gain.setValueAtTime(peakGain, now);
        source.buffer = clip.buffer;
        source.playbackRate.value = clamp(clip.playbackRate * (options.playbackRate ?? 1), 0.35, 2.5);
        source.connect(gain);
        if (panner) {
          panner.pan.value = spatial.pan;
          gain.connect(panner);
          panner.connect(ensureOutput());
        } else {
          gain.connect(ensureOutput());
        }
        clip.active += 1;
        clip.lastStartAt = audio.currentTime;
        source.onended = () => {
          clip.active = Math.max(0, clip.active - 1);
        };
        source.start();
        if (clip.maxPlaybackMs !== null) {
          const stopAfterSeconds = Math.min(clip.buffer.duration, clip.maxPlaybackMs / 1000);
          if (stopAfterSeconds < clip.buffer.duration) {
            const stopAt = now + stopAfterSeconds;
            const fadeSeconds = Math.min(clip.fadeOutMs / 1000, Math.max(0, stopAfterSeconds * 0.75));
            if (fadeSeconds > 0) {
              const fadeStart = Math.max(now, stopAt - fadeSeconds);
              gain.gain.setValueAtTime(peakGain, fadeStart);
              gain.gain.linearRampToValueAtTime(0.0001, stopAt);
            }
            source.stop(stopAt);
          }
        }
        probe.lastPlayed = id;
        probe.lastDistanceCells = spatial.distanceCells;
        probe.lastPan = spatial.pan;
        probe.lastGain = Number(spatial.gain.toFixed(3));
        probe.unlocked = audio.state === "running";
        probe.recentPlayed?.push({
          id,
          atMs: Math.round(performance.now() * 10) / 10,
          distanceCells: spatial.distanceCells,
          gain: Number(spatial.gain.toFixed(3)),
          pan: Number(spatial.pan.toFixed(3)),
        });
        if (probe.recentPlayed && probe.recentPlayed.length > 160) {
          probe.recentPlayed.splice(0, probe.recentPlayed.length - 160);
        }
      })
      .catch((error: unknown) => recordError(error));
  };

  function startLoop(id: string, options: SfxPlayOptions): void {
    const audio = ensureContext();
    if (audio.state === "suspended") void audio.resume();
    const clip = clips.get(id);
    if (!clip) {
      recordMissingClipPlay(id);
      return;
    }
    if (!clip.loop) {
      recordError(new Error(`sfx clip ${id} is not marked loopable`));
      return;
    }
    if ((options.volume ?? 1) <= 0.001) {
      stopActiveLoop(id, options.fadeMs ?? 700);
      return;
    }
    const existing = activeLoops.get(id);
    const bus = manifest?.buses[clip.bus];
    const busVolume = bus?.volume ?? 1;
    const peakGain = Math.min(0.95, clip.volume * busVolume * (options.volume ?? 1));
    const fadeSeconds = Math.max(0, options.fadeMs ?? 900) / 1000;
    const now = audio.currentTime;
    if (existing) {
      if (existing.stopTimer !== null) {
        window.clearTimeout(existing.stopTimer);
        existing.stopTimer = null;
      }
      existing.gain.gain.cancelScheduledValues(now);
      existing.gain.gain.setValueAtTime(existing.gain.gain.value, now);
      existing.gain.gain.linearRampToValueAtTime(peakGain, now + fadeSeconds);
      updateActiveLoopProbe();
      return;
    }
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = clip.buffer;
    source.loop = true;
    if (clip.loopStartSeconds !== null && clip.loopStartSeconds > 0 && clip.loopStartSeconds < clip.buffer.duration) {
      source.loopStart = clip.loopStartSeconds;
    }
    if (clip.loopEndSeconds !== null && clip.loopEndSeconds > (clip.loopStartSeconds ?? 0) && clip.loopEndSeconds <= clip.buffer.duration) {
      source.loopEnd = clip.loopEndSeconds;
    }
    source.playbackRate.value = clamp(clip.playbackRate * (options.playbackRate ?? 1), 0.35, 2.5);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + fadeSeconds);
    source.connect(gain);
    gain.connect(ensureOutput());
    activeLoops.set(id, { source, gain, stopTimer: null });
    source.onended = () => {
      activeLoops.delete(id);
      updateActiveLoopProbe();
    };
    source.start();
    probe.lastPlayed = id;
    probe.lastGain = Number(peakGain.toFixed(3));
    probe.unlocked = audio.state === "running";
    updateActiveLoopProbe();
  }

  function stopActiveLoop(id: string, fadeMs = 700): void {
    const loop = activeLoops.get(id);
    if (!loop) return;
    const audio = ensureContext();
    const now = audio.currentTime;
    const fadeSeconds = Math.max(0, fadeMs) / 1000;
    loop.gain.gain.cancelScheduledValues(now);
    loop.gain.gain.setValueAtTime(loop.gain.gain.value, now);
    loop.gain.gain.linearRampToValueAtTime(0.0001, now + fadeSeconds);
    if (loop.stopTimer !== null) window.clearTimeout(loop.stopTimer);
    loop.stopTimer = window.setTimeout(() => {
      try {
        loop.source.stop();
      } catch {
        activeLoops.delete(id);
        updateActiveLoopProbe();
      }
    }, Math.max(0, fadeMs) + 25);
  }

  function updateActiveLoopProbe(): void {
    probe.activeLoops = [...activeLoops.keys()].sort();
  }

  return { probe, load, setListenerPosition, play, playAt, playProceduralAt, setLoop, stopLoop, stopAllLoops };


  function playProcedural(kind: SfxProceduralKind, options: SfxProceduralOptions & { position: SfxPoint }): void {
    const audio = ensureContext();
    if (audio.state === "suspended") void audio.resume();
    const spatial = listenerPosition
      ? computeSfxSpatialMix(listenerPosition, options.position, options)
      : { gain: 1, pan: 0, distanceCells: null };
    const now = audio.currentTime;
    const seed = Math.abs(Math.trunc(options.seed ?? 0));
    const profile = proceduralProfile(kind, seed, options);
    const peakGain = Math.min(0.65, profile.volume * (options.volume ?? 1) * spatial.gain * (options.intensity ?? 1));
    if (peakGain <= 0.001) return;
    const oscillator = audio.createOscillator();
    const filter = audio.createBiquadFilter();
    const gain = audio.createGain();
    const panner = listenerPosition ? audio.createStereoPanner() : null;
    oscillator.type = profile.type;
    oscillator.frequency.setValueAtTime(profile.startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(profile.endFrequency, now + profile.durationSeconds);
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(profile.filterFrequency, now);
    filter.Q.value = profile.q;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + profile.attackSeconds);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + profile.durationSeconds);
    oscillator.connect(filter);
    filter.connect(gain);
    if (panner) {
      panner.pan.value = spatial.pan;
      gain.connect(panner);
      panner.connect(ensureOutput());
    } else {
      gain.connect(ensureOutput());
    }
    oscillator.start(now);
    oscillator.stop(now + profile.durationSeconds);
    probe.lastPlayed = `procedural:${kind}`;
    probe.lastDistanceCells = spatial.distanceCells;
    probe.lastPan = spatial.pan;
    probe.lastGain = Number(spatial.gain.toFixed(3));
    probe.unlocked = audio.state === "running";
    probe.recentPlayed?.push({
      id: `procedural:${kind}`,
      atMs: Math.round(performance.now() * 10) / 10,
      distanceCells: spatial.distanceCells,
      gain: Number(spatial.gain.toFixed(3)),
      pan: Number(spatial.pan.toFixed(3)),
    });
    if (probe.recentPlayed && probe.recentPlayed.length > 160) {
      probe.recentPlayed.splice(0, probe.recentPlayed.length - 160);
    }
  }

  function proceduralProfile(kind: SfxProceduralKind, seed: number, options: SfxProceduralOptions) {
    const unit = ((seed * 1103515245 + 12345) >>> 0) / 0x100000000;
    if (kind === "bullet_crack") {
      const durationSeconds = Math.max(0.018, Math.min(0.07, (options.durationMs ?? 38) / 1000));
      return {
        type: "square" as OscillatorType,
        durationSeconds,
        attackSeconds: Math.min(0.004, durationSeconds * 0.22),
        startFrequency: 3_100 + unit * 1_100,
        endFrequency: 1_250 + unit * 360,
        filterFrequency: 2_600 + unit * 900,
        q: 5.5,
        volume: 0.22,
      };
    }
    const durationSeconds = Math.max(0.055, Math.min(0.16, (options.durationMs ?? 105) / 1000));
    return {
      type: "triangle" as OscillatorType,
      durationSeconds,
      attackSeconds: Math.min(0.012, durationSeconds * 0.22),
      startFrequency: 1_450 + unit * 420,
      endFrequency: 420 + unit * 120,
      filterFrequency: 1_050 + unit * 280,
      q: 3.2,
      volume: 0.13,
    };
  }

  function recordMissingClipPlay(id: string): void {
    if (missingClipPlayLog.has(id)) return;
    missingClipPlayLog.add(id);
    recordError(new Error(`missing sfx clip ${id}`), id);
  }

  function recordError(error: unknown, id: string | null = null, path?: string) {
    const reason = error instanceof Error ? error.message : String(error);
    probe.errors.push({
      id,
      reason,
      path,
      atMs: Math.round(performance.now() * 10) / 10,
    });
    if (probe.errors.length > 12) probe.errors.shift();
  }
}

export function computeSfxSpatialMix(listener: SfxPoint, position: SfxPoint, options: SfxPlayOptions = {}): SfxSpatialMix {
  const dx = position.x - listener.x;
  const dy = position.y - listener.y;
  const distanceCells = Math.hypot(dx, dy);
  const minDistance = options.minDistanceCells ?? 3.5;
  const maxDistance = Math.max(minDistance + 0.1, options.maxDistanceCells ?? 34);
  const t = clamp((distanceCells - minDistance) / (maxDistance - minDistance), 0, 1);
  const rolloff = options.rolloff ?? 1.35;
  const farGainFloor = clamp(options.farGainFloor ?? 0, 0, 0.5);
  const shapedGain = farGainFloor + Math.pow(1 - t, rolloff) * (1 - farGainFloor);
  // A floor is useful for loud reports such as gunfire, but it must not make
  // the source audible forever. Smoothly take every curve to zero over the
  // final 18% of its range; t is clamped, so max range and beyond are silent.
  const cutoffT = clamp((t - 0.82) / 0.18, 0, 1);
  const cutoffGain = 1 - cutoffT * cutoffT * (3 - 2 * cutoffT);
  const gain = clamp(shapedGain * cutoffGain, 0, 1);
  const maxPan = clamp(options.maxPan ?? 0.85, 0, 1);
  const pan = clamp(dx / (options.panDistanceCells ?? 13), -maxPan, maxPan);
  return {
    distanceCells: Number(distanceCells.toFixed(2)),
    gain,
    pan,
  };
}

function hardPolyphonyLimit(clip: Pick<LoadedSfxClip, "polyphony" | "loop">): number {
  if (clip.loop) return clip.polyphony;
  return Math.max(clip.polyphony, Math.min(64, Math.ceil(clip.polyphony * 2.5), clip.polyphony + 12));
}

function voiceConcurrencyGain(overloadVoices: number): number {
  if (overloadVoices <= 0) return 1;
  return clamp(1 / Math.sqrt(1 + overloadVoices * 0.72), 0.38, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
