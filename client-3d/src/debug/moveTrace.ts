import {
  installSuccessorMoveTraceSink,
  type SuccessorMoveTraceEvent,
  type SuccessorMoveTraceInput,
  type SuccessorMoveTraceSink,
} from "@successor/client/src/slice-core/moveTraceSystem";

const MOVE_TRACE_RING_CAP = 2048;

export interface SuccessorMoveTraceProbe {
  readonly enabled: boolean;
  readonly capacity: number;
  readonly count: number;
  /** Return oldest→newest entries and clear the ring. */
  drain(): SuccessorMoveTraceEvent[];
  /** Return oldest→newest entries without clearing. */
  peek(): SuccessorMoveTraceEvent[];
  clear(): void;
}

export interface SuccessorMoveTraceController {
  readonly enabled: boolean;
  dispose(): void;
}

declare global {
  interface Window {
    __successorMoveTrace?: SuccessorMoveTraceProbe;
  }
}

class BrowserSuccessorMoveTrace implements SuccessorMoveTraceSink, SuccessorMoveTraceProbe, SuccessorMoveTraceController {
  readonly enabled = true;
  readonly capacity = MOVE_TRACE_RING_CAP;
  private readonly ring: SuccessorMoveTraceEvent[] = [];
  private head = 0;
  private writtenCount = 0;
  private nextSeq = 1;

  get count(): number {
    return Math.min(this.writtenCount, this.capacity);
  }

  record(input: SuccessorMoveTraceInput): void {
    const event: SuccessorMoveTraceEvent = {
      seq: this.nextSeq,
      tMs: Number(performance.now().toFixed(3)),
      wallTimeMs: Date.now(),
      ...input,
    };
    this.nextSeq += 1;
    this.ring[this.head] = event;
    this.head = (this.head + 1) % this.capacity;
    this.writtenCount += 1;
  }

  drain(): SuccessorMoveTraceEvent[] {
    const events = this.peek();
    this.clear();
    return events;
  }

  peek(): SuccessorMoveTraceEvent[] {
    const out: SuccessorMoveTraceEvent[] = [];
    const count = this.count;
    const start = this.writtenCount >= this.capacity ? this.head : 0;
    for (let i = 0; i < count; i += 1) {
      const event = this.ring[(start + i) % this.capacity];
      if (event) out.push({ ...event });
    }
    return out;
  }

  clear(): void {
    this.ring.length = 0;
    this.head = 0;
    this.writtenCount = 0;
  }

  dispose(): void {
    installSuccessorMoveTraceSink(null);
    if (typeof window !== "undefined" && window.__successorMoveTrace === this) {
      delete window.__successorMoveTrace;
    }
    this.clear();
  }
}

const disabledMoveTraceController: SuccessorMoveTraceController = {
  enabled: false,
  dispose() {
    // no-op
  },
};

export function installSuccessorMoveTraceProbe(): SuccessorMoveTraceController {
  if (!import.meta.env.DEV || typeof window === "undefined" || !moveTraceRequested(window)) {
    installSuccessorMoveTraceSink(null);
    return disabledMoveTraceController;
  }
  const trace = new BrowserSuccessorMoveTrace();
  window.__successorMoveTrace = trace;
  installSuccessorMoveTraceSink(trace);
  return trace;
}

function moveTraceRequested(targetWindow: Window): boolean {
  const params = new URLSearchParams(targetWindow.location.search);
  return params.get("moveTrace") === "1"
    || params.get("movetrace") === "1"
    || targetWindow.localStorage.getItem("successor.moveTrace") === "1";
}
