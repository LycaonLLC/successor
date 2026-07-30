import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- the JavaScript driver intentionally has no declaration file.
import { startSuccessorDriverBot } from "../../../tools/driver-protocol/successor-driver-bot.mjs";
import { EventEmitter } from "node:events";

class MockStream extends EventEmitter {
  setEncoding() {}
}

class MockChildProcess extends EventEmitter {
  stdout = new MockStream();
  stderr = new MockStream();
  stdin = {
    write: vi.fn(),
  };
  killed = false;
  kill = vi.fn();
}

vi.mock("node:child_process", () => {
  return {
    spawn: () => new MockChildProcess(),
  };
});

describe("startSuccessorDriverBot bounded buffers", () => {
  it("enforces limits and tracks dropped counters for envelopes, textLines, and stderr", () => {
    const bot = startSuccessorDriverBot({
      cliPath: "dummy",
      gameUrl: "http://dummy",
      actorId: "test-actor",
    });

    const child = bot.child;

    // 1. Test envelopes cap: 512.
    for (let i = 0; i < 600; i++) {
      child.stdout.emit("data", `${JSON.stringify({ type: "envelope", id: i })}\n`);
    }
    expect(bot.envelopes.length).toBe(512);
    expect(bot.envelopes[0]).toEqual({ type: "envelope", id: 88 });
    expect(bot.dropped.envelopes).toBe(88);

    // 2. Test textLines cap: 128.
    for (let i = 0; i < 200; i++) {
      child.stdout.emit("data", `raw text line ${i}\n`);
    }
    expect(bot.textLines.length).toBe(128);
    expect(bot.textLines[0]).toBe("raw text line 72");
    expect(bot.dropped.textLines).toBe(72);

    // 3. Test stderr cap: 256.
    for (let i = 0; i < 300; i++) {
      child.stderr.emit("data", `stderr line ${i}\n`);
    }
    expect(bot.stderr.length).toBe(256);
    expect(bot.stderr[0]).toBe("stderr line 44");
    expect(bot.dropped.stderr).toBe(44);
  });

  it("enforces partial buffer limits and increments dedicated counters for stdout", () => {
    const bot = startSuccessorDriverBot({
      cliPath: "dummy",
      gameUrl: "http://dummy",
      actorId: "test-actor",
    });

    const child = bot.child;

    // A chunk with >64KiB character length and no newline
    const overlongChunk = "a".repeat(64 * 1024 + 1); // 65537 chars
    child.stdout.emit("data", overlongChunk);

    // Verify dedicated counters incremented
    expect(bot.dropped.stdoutBufferTruncations).toBe(1);
    expect(bot.dropped.stdoutBufferDrops).toBe(1);

    // Since it had no newline, the buffer should have been cleared (shrunk to 0)
    // Send a valid JSON envelope now to verify recovery (overlong partial followed by valid newline JSON recovery)
    child.stdout.emit("data", `{"recovered":true}\n`);
    expect(bot.envelopes.length).toBe(1);
    expect(bot.envelopes[0]).toEqual({ recovered: true });
    // And it didn't get treated as textLines because recovery worked and cleared the overlong partial
    expect(bot.textLines.length).toBe(0);
  });

  it("enforces partial buffer limits and increments dedicated counters for stderr", () => {
    const bot = startSuccessorDriverBot({
      cliPath: "dummy",
      gameUrl: "http://dummy",
      actorId: "test-actor",
    });

    const child = bot.child;

    const overlongChunk = "e".repeat(64 * 1024 + 1); // 65537 chars
    child.stderr.emit("data", overlongChunk);

    expect(bot.dropped.stderrBufferTruncations).toBe(1);
    expect(bot.dropped.stderrBufferDrops).toBe(1);

    // Verify recovery by sending a valid stderr line
    child.stderr.emit("data", "error recovered\n");
    expect(bot.stderr.length).toBe(1);
    expect(bot.stderr[0]).toBe("error recovered");
  });

  it("successfully parses valid JSON fragmented across many small chunks", () => {
    const bot = startSuccessorDriverBot({
      cliPath: "dummy",
      gameUrl: "http://dummy",
      actorId: "test-actor",
    });

    const child = bot.child;

    const fragments = [
      '{"type":',
      '"envelope"',
      ',"sequence"',
      ':42',
      ',"payload"',
      ':{"active"',
      ':true}',
      '}\n'
    ];

    for (const chunk of fragments) {
      child.stdout.emit("data", chunk);
    }

    expect(bot.envelopes.length).toBe(1);
    expect(bot.envelopes[0]).toEqual({
      type: "envelope",
      sequence: 42,
      payload: { active: true }
    });
    expect(bot.dropped.stdoutBufferTruncations).toBe(0);
    expect(bot.dropped.stdoutBufferDrops).toBe(0);
  });

  it("handles multibyte input without growing unbounded or corrupting later valid ASCII JSON", () => {
    const bot = startSuccessorDriverBot({
      cliPath: "dummy",
      gameUrl: "http://dummy",
      actorId: "test-actor",
    });

    const child = bot.child;

    // 💩 is 2 UTF-16 code units (surrogate pair)
    // We send enough to exceed 64KiB (65536 code units).
    // Let's send 33000 of them, which is 66000 code units (characters).
    const multibyteChunk = "💩".repeat(33000);
    child.stdout.emit("data", multibyteChunk);

    // Verify cap was hit and partial buffer cleared/dropped
    expect(bot.dropped.stdoutBufferTruncations).toBe(1);
    expect(bot.dropped.stdoutBufferDrops).toBe(1);

    // Send valid ASCII JSON following the overlong multibyte chunk
    child.stdout.emit("data", `{"valid":true}\n`);

    expect(bot.envelopes.length).toBe(1);
    expect(bot.envelopes[0]).toEqual({ valid: true });
    expect(bot.textLines.length).toBe(0);
  });

  it("handles a single chunk containing a newline-terminated JSON envelope larger than 64KiB", () => {
    const bot = startSuccessorDriverBot({
      cliPath: "dummy",
      gameUrl: "http://dummy",
      actorId: "test-actor",
    });

    const child = bot.child;

    const largeValue = "a".repeat(64 * 1024 + 10);
    const validJsonEnvelope = JSON.stringify({ type: "envelope", data: largeValue }) + "\n";
    child.stdout.emit("data", validJsonEnvelope);

    expect(bot.envelopes.length).toBe(1);
    expect(bot.envelopes[0]).toEqual({ type: "envelope", data: largeValue });
    expect(bot.dropped.stdoutBufferTruncations).toBe(0);
    expect(bot.dropped.stdoutBufferDrops).toBe(0);
  });

  it("preserves valid lines when a chunk contains valid JSON followed by an oversized unterminated suffix, while bounding/counting the suffix", () => {
    const bot = startSuccessorDriverBot({
      cliPath: "dummy",
      gameUrl: "http://dummy",
      actorId: "test-actor",
    });

    const child = bot.child;

    const validPart = `{"valid":true}\n`;
    const oversizedSuffix = "a".repeat(64 * 1024 + 1);
    child.stdout.emit("data", validPart + oversizedSuffix);

    expect(bot.envelopes.length).toBe(1);
    expect(bot.envelopes[0]).toEqual({ valid: true });
    expect(bot.dropped.stdoutBufferTruncations).toBe(1);
    expect(bot.dropped.stdoutBufferDrops).toBe(1);
  });

  it("preserves valid lines on stderr followed by an oversized unterminated suffix, bounding the suffix", () => {
    const bot = startSuccessorDriverBot({
      cliPath: "dummy",
      gameUrl: "http://dummy",
      actorId: "test-actor",
    });

    const child = bot.child;

    const validStderrPart = "error-prefix-line\n";
    const oversizedStderrSuffix = "e".repeat(64 * 1024 + 1);
    child.stderr.emit("data", validStderrPart + oversizedStderrSuffix);

    expect(bot.stderr.length).toBe(1);
    expect(bot.stderr[0]).toBe("error-prefix-line");
    expect(bot.dropped.stderrBufferTruncations).toBe(1);
    expect(bot.dropped.stderrBufferDrops).toBe(1);
  });
});
