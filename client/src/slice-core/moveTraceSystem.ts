export type SuccessorMoveTraceKind =
  | "input-keydown"
  | "command-enqueued"
  | "command-acked"
  | "render-position-moved";

export type SuccessorMoveTraceValue = string | number | boolean | null | undefined;

export interface SuccessorMoveTraceInput {
  kind: SuccessorMoveTraceKind;
  [field: string]: SuccessorMoveTraceValue;
}

export interface SuccessorMoveTraceEvent extends SuccessorMoveTraceInput {
  seq: number;
  /** Browser monotonic timestamp, milliseconds. */
  tMs: number;
  /** Wall-clock timestamp, milliseconds since epoch. */
  wallTimeMs: number;
}

export interface SuccessorMoveTraceSink {
  readonly enabled: boolean;
  record(event: SuccessorMoveTraceInput): void;
}

let activeMoveTraceSink: SuccessorMoveTraceSink | null = null;

export function installSuccessorMoveTraceSink(sink: SuccessorMoveTraceSink | null): void {
  activeMoveTraceSink = sink;
}

export function successorMoveTraceEnabled(): boolean {
  return activeMoveTraceSink?.enabled === true;
}

export function recordSuccessorMoveTrace(event: SuccessorMoveTraceInput): void {
  const sink = activeMoveTraceSink;
  if (sink?.enabled !== true) return;
  sink.record(event);
}
