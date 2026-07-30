import { createInterface } from "node:readline";

export const SUCCESSOR_DRIVER_VERSION = "successor.driver.v1" as const;

export type SuccessorDriverEnvelopeType = "receipt" | "query" | "event" | "status";

export interface SuccessorDriverBaseEnvelope {
  v: typeof SUCCESSOR_DRIVER_VERSION;
  type: SuccessorDriverEnvelopeType;
}

export interface SuccessorDriverReceiptEnvelope extends SuccessorDriverBaseEnvelope {
  type: "receipt";
  commandId: number;
  accepted: boolean;
  tick: number;
  reasonCode?: string;
  commandKind?: string;
}

export interface SuccessorDriverQueryEnvelope extends SuccessorDriverBaseEnvelope {
  type: "query";
  line: string;
  verb: string;
  text: string;
  data: Record<string, unknown>;
}
export interface SuccessorDriverDialogueDelivery {
  actorId: string;
  speaker: string;
  body: string;
  areaId?: string;
  x?: number;
  y?: number;
  tick?: number;
}


export interface SuccessorDriverEventEnvelope extends SuccessorDriverBaseEnvelope {
  type: "event";
  event: string;
  line?: string;
  data?: Record<string, unknown>;
}

export interface SuccessorDriverStatusEnvelope extends SuccessorDriverBaseEnvelope {
  type: "status";
  status: string;
  message?: string;
  data?: Record<string, unknown>;
}

export type SuccessorDriverEnvelope =
  | SuccessorDriverReceiptEnvelope
  | SuccessorDriverQueryEnvelope
  | SuccessorDriverEventEnvelope
  | SuccessorDriverStatusEnvelope;

export type SuccessorDriverInboundFrame =
  | { op: "verb"; line: string }
  | { op: "query"; verb: string }
  | { op: "quit" };

export interface SuccessorDriverProtocolHost {
  handleVerb(line: string): Promise<readonly SuccessorDriverEnvelope[]>;
  handleQuery(line: string): Promise<readonly SuccessorDriverEnvelope[]>;
  close(): Promise<void>;
  onEnvelope?(listener: (envelope: SuccessorDriverEnvelope) => void): () => void;
}

export interface SuccessorDriverProtocolOptions {
  text?: boolean;
  writeLine?: (line: string) => void;
}

export function statusEnvelope(status: string, extra: Omit<SuccessorDriverStatusEnvelope, "v" | "type" | "status"> = {}): SuccessorDriverStatusEnvelope {
  return { v: SUCCESSOR_DRIVER_VERSION, type: "status", status, ...extra };
}

export function eventEnvelope(event: string, extra: Omit<SuccessorDriverEventEnvelope, "v" | "type" | "event"> = {}): SuccessorDriverEventEnvelope {
  return { v: SUCCESSOR_DRIVER_VERSION, type: "event", event, ...extra };
}

export function queryEnvelope(input: Omit<SuccessorDriverQueryEnvelope, "v" | "type">): SuccessorDriverQueryEnvelope {
  return { v: SUCCESSOR_DRIVER_VERSION, type: "query", ...input };
}

export function receiptEnvelope(input: Omit<SuccessorDriverReceiptEnvelope, "v" | "type">): SuccessorDriverReceiptEnvelope {
  return { v: SUCCESSOR_DRIVER_VERSION, type: "receipt", ...input };
}

export class SuccessorDriverProtocol {
  private readonly text: boolean;
  private readonly writeLine: (line: string) => void;
  private readonly unsubscribe: (() => void) | null;
  private closed = false;

  constructor(private readonly host: SuccessorDriverProtocolHost, options: SuccessorDriverProtocolOptions = {}) {
    this.text = options.text === true;
    this.writeLine = options.writeLine ?? ((line) => process.stdout.write(`${line}\n`));
    this.unsubscribe = host.onEnvelope?.((envelope) => this.writeEnvelope(envelope)) ?? null;
  }

  async run(input: NodeJS.ReadableStream): Promise<void> {
    const reader = createInterface({ input, crlfDelay: Infinity, terminal: false });
    try {
      for await (const line of reader) {
        await this.handleLine(line);
        if (this.closed) break;
      }
    } finally {
      reader.close();
      this.dispose();
    }
  }

  async handleLine(rawLine: string): Promise<void> {
    if (this.closed) return;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const frame = this.parseFrame(trimmed);
    if (!frame) return;

    if (frame.op === "verb") {
      await this.writeMany(await this.host.handleVerb(frame.line));
      return;
    }
    if (frame.op === "query") {
      await this.writeMany(await this.host.handleQuery(frame.verb));
      return;
    }

    this.writeEnvelope(statusEnvelope("closing"));
    this.closed = true;
    await this.host.close();
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  private parseFrame(rawLine: string): SuccessorDriverInboundFrame | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine) as unknown;
    } catch (error) {
      this.writeEnvelope(statusEnvelope("invalid_json", { message: error instanceof Error ? error.message : "invalid JSON" }));
      return null;
    }

    if (!isRecord(parsed) || typeof parsed.op !== "string") {
      this.writeEnvelope(statusEnvelope("invalid_frame", { message: "driver frame requires an op" }));
      return null;
    }

    if (parsed.op === "verb") {
      if (typeof parsed.line !== "string" || parsed.line.trim().length === 0) {
        this.writeEnvelope(statusEnvelope("invalid_frame", { message: "verb frame requires a non-empty line" }));
        return null;
      }
      return { op: "verb", line: parsed.line };
    }

    if (parsed.op === "query") {
      if (typeof parsed.verb !== "string" || parsed.verb.trim().length === 0) {
        this.writeEnvelope(statusEnvelope("invalid_frame", { message: "query frame requires a non-empty verb" }));
        return null;
      }
      return { op: "query", verb: parsed.verb };
    }

    if (parsed.op === "quit") return { op: "quit" };

    this.writeEnvelope(statusEnvelope("unsupported_op", { message: `unsupported op ${parsed.op}` }));
    return null;
  }

  private async writeMany(envelopes: readonly SuccessorDriverEnvelope[]): Promise<void> {
    for (const envelope of envelopes) this.writeEnvelope(envelope);
  }

  private writeEnvelope(envelope: SuccessorDriverEnvelope): void {
    if (this.text && envelope.type === "query") {
      this.writeLine(envelope.text);
      return;
    }
    this.writeLine(JSON.stringify(envelope));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
