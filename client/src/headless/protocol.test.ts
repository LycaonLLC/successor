import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SUCCESSOR_DRIVER_VERSION,
  SuccessorDriverProtocol,
  eventEnvelope,
  queryEnvelope,
  receiptEnvelope,
  statusEnvelope,
  type SuccessorDriverEnvelope,
  type SuccessorDriverProtocolHost,
} from "./protocol";

class FakeDriverHost implements SuccessorDriverProtocolHost {
  closed = false;
  private listener: ((envelope: SuccessorDriverEnvelope) => void) | null = null;

  onEnvelope(listener: (envelope: SuccessorDriverEnvelope) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async handleVerb(line: string): Promise<readonly SuccessorDriverEnvelope[]> {
    if (line === "/target nearest hostile") {
      return [eventEnvelope("verb", { line, data: { result: { class: "local", text: "TARGET ROGUE" } } })];
    }
    if (line === "/attack basic_shot rogue") {
      this.listener?.(receiptEnvelope({ commandId: 7, accepted: true, tick: 12, commandKind: "QueueCombatAction" }));
      return [eventEnvelope("authority_queued", { line, data: { commandId: 7, commandKind: "QueueCombatAction", flushed: 1 } })];
    }
    return [statusEnvelope("unknown_verb", { data: { line } })];
  }

  async handleQuery(line: string): Promise<readonly SuccessorDriverEnvelope[]> {
    return [queryEnvelope({
      line,
      verb: line.replace(/^\//u, ""),
      text: "WHERE open-desert 12,18 facing right",
      data: { schema: "successor.query.where.v1", areaId: "open-desert" },
    })];
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listener?.(statusEnvelope("closed"));
  }
}

describe("successor.driver.v1 protocol", () => {
  it("frames query, local event, authority queue, receipt, and quit envelopes as JSONL", async () => {
    const host = new FakeDriverHost();
    const lines: string[] = [];
    const protocol = new SuccessorDriverProtocol(host, { writeLine: (line) => lines.push(line) });

    await protocol.handleLine(JSON.stringify({ op: "query", verb: "/where" }));
    await protocol.handleLine(JSON.stringify({ op: "verb", line: "/target nearest hostile" }));
    await protocol.handleLine(JSON.stringify({ op: "verb", line: "/attack basic_shot rogue" }));
    await protocol.handleLine(JSON.stringify({ op: "quit" }));

    const envelopes = lines.map((line) => JSON.parse(line) as SuccessorDriverEnvelope);
    expect(envelopes.map((envelope) => envelope.v)).toEqual(Array.from({ length: 6 }, () => SUCCESSOR_DRIVER_VERSION));
    expect(envelopes.map((envelope) => envelope.type)).toEqual(["query", "event", "receipt", "event", "status", "status"]);
    expect(envelopes[0]).toMatchObject({ type: "query", verb: "where", text: "WHERE open-desert 12,18 facing right" });
    expect(envelopes[2]).toMatchObject({ type: "receipt", commandId: 7, accepted: true, commandKind: "QueueCombatAction" });
    expect(envelopes[4]).toMatchObject({ type: "status", status: "closing" });
    expect(envelopes[5]).toMatchObject({ type: "status", status: "closed" });
    expect(host.closed).toBe(true);
  });

  it("text mode renders query envelopes through the SP1 query text and leaves other envelopes machine-readable", async () => {
    const host = new FakeDriverHost();
    const lines: string[] = [];
    const protocol = new SuccessorDriverProtocol(host, { text: true, writeLine: (line) => lines.push(line) });

    await protocol.handleLine(JSON.stringify({ op: "query", verb: "/where" }));
    await protocol.handleLine(JSON.stringify({ op: "verb", line: "/target nearest hostile" }));

    expect(lines[0]).toBe("WHERE open-desert 12,18 facing right");
    expect(JSON.parse(lines[1]!) as SuccessorDriverEnvelope).toMatchObject({ type: "event", event: "verb" });
  });

  it("keeps the headless entry free of renderer, browser, and DOM imports", async () => {
    const headlessRoot = path.resolve(import.meta.dirname);
    const files = (await readdir(headlessRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      .map((entry) => path.join(entry.parentPath, entry.name));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*(?:three|pixi\.js|jsdom|client-3d|runtimeBoot|canvas|pixi)[^"']*["']/iu);
      expect(source, file).not.toMatch(/\b(?:window|document|HTMLElement|HTMLCanvasElement|AudioContext|Image)\b/u);
    }
  });
});
