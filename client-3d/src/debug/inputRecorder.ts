const INPUT_RING_CAP = 64;
const ATTACK_WARN_THROTTLE_MS = 2_000;

export type InputEventKind = "down" | "up" | "dblclick" | "key" | "radial" | "command";
export type InputCommandSource = "dblclick" | "ability" | "radial" | "default";

export interface InputRecorderEntry {
  kind: InputEventKind;
  button?: number;
  code?: string;
  actorId?: string | null;
  routed: string;
  commandKind?: string;
  source?: InputCommandSource;
}

export interface RecordedInputEvent extends InputRecorderEntry {
  seq: number;
  tMs: number;
}

export interface InputRecorderProbe {
  entries(): readonly RecordedInputEvent[];
  readonly anomalies: number;
  clear(): void;
}

declare global {
  interface Window {
    __successor3dInputRec?: InputRecorderProbe;
  }
}

const ring: RecordedInputEvent[] = Array.from({ length: INPUT_RING_CAP }, () => ({
  seq: 0,
  tMs: 0,
  kind: "down",
  button: undefined,
  code: undefined,
  actorId: undefined,
  routed: "",
  commandKind: undefined,
  source: undefined,
}));
let head = 0;
let count = 0;
let nextSeq = 1;
let anomalyCount = 0;
let lastAttackWarnAtMs = Number.NEGATIVE_INFINITY;

const probe: InputRecorderProbe = {
  entries: collectEntries,
  get anomalies(): number {
    return anomalyCount;
  },
  clear: clearInputRecorder,
};

export function recordInputEvent(entry: InputRecorderEntry): void {
  const nowMs = performance.now();
  const slot = ring[head]!;
  slot.seq = nextSeq;
  slot.tMs = nowMs;
  slot.kind = entry.kind;
  slot.button = entry.button;
  slot.code = entry.code;
  slot.actorId = entry.actorId;
  slot.routed = entry.routed;
  slot.commandKind = entry.commandKind;
  slot.source = entry.source;
  nextSeq += 1;
  head = (head + 1) % INPUT_RING_CAP;
  if (count < INPUT_RING_CAP) count += 1;

  if (isUnsanctionedAttackCommand(entry)) {
    anomalyCount += 1;
    if (nowMs - lastAttackWarnAtMs >= ATTACK_WARN_THROTTLE_MS) {
      lastAttackWarnAtMs = nowMs;
      console.warn("[sc3d-input] attack without sanctioned source", entry);
    }
  }
}

export function installInputRecorderProbe(): void {
  const targetWindow = typeof window === "undefined" ? undefined : window;
  if (targetWindow === undefined) return;
  targetWindow.__successor3dInputRec = probe;
}

function collectEntries(): readonly RecordedInputEvent[] {
  const out: RecordedInputEvent[] = [];
  const start = count >= INPUT_RING_CAP ? head : 0;
  for (let i = 0; i < count; i += 1) {
    const slot = ring[(start + i) % INPUT_RING_CAP]!;
    out.push({
      seq: slot.seq,
      tMs: slot.tMs,
      kind: slot.kind,
      button: slot.button,
      code: slot.code,
      actorId: slot.actorId,
      routed: slot.routed,
      commandKind: slot.commandKind,
      source: slot.source,
    });
  }
  return out;
}

function clearInputRecorder(): void {
  for (let i = 0; i < INPUT_RING_CAP; i += 1) {
    const slot = ring[i]!;
    slot.seq = 0;
    slot.tMs = 0;
    slot.kind = "down";
    slot.button = undefined;
    slot.code = undefined;
    slot.actorId = undefined;
    slot.routed = "";
    slot.commandKind = undefined;
    slot.source = undefined;
  }
  head = 0;
  count = 0;
  nextSeq = 1;
  anomalyCount = 0;
  lastAttackWarnAtMs = Number.NEGATIVE_INFINITY;
}

function isUnsanctionedAttackCommand(entry: InputRecorderEntry): boolean {
  if (entry.kind !== "command") return false;
  const commandKind = entry.commandKind;
  if (commandKind === undefined) return false;
  if (entry.source === "dblclick" || entry.source === "ability" || entry.source === "radial") return false;
  return commandKind === "basic_shot" || commandKind.startsWith("attack");
}
