import { describe, expect, it, vi } from "vitest";
import {
  loadRuntimePointer,
  parseRuntimePointer,
  RUNTIME_POINTER_PATH,
  RUNTIME_POINTER_SCHEMA,
} from "../src/features/runtimePointer";

const BASE = "https://successor.example/account/";
const ENTRY = "https://cdn.example/releases/0f3a/index.html";
const POINTER = {
  schema: RUNTIME_POINTER_SCHEMA,
  entry: ENTRY,
  manifestSha256: "0f3a".repeat(16),
  sourceCommit: "a".repeat(40),
  clientReleaseId: "client-r1",
};

describe("runtime pointer validation", () => {
  it("accepts the published successor.client-runtime-pointer.v1 shape", () => {
    const url = parseRuntimePointer(POINTER, BASE);
    expect(url?.href).toBe(ENTRY);
    expect(url?.origin).toBe("https://cdn.example");
  });

  it("accepts the canonical beta server release identity", () => {
    const serverReleaseId =
      "planetfall-v5-seed-424242-size-1024-rogues-18-desert-critters-48-verdance-critters-24-areas-open-desert-overworld-verdance-forest-overworld";
    expect(parseRuntimePointer({
      ...POINTER,
      clientReleaseId: "successor-rust-beta@b99dfb6b5f5ee644",
      serverReleaseId,
      channel: "beta",
    }, BASE)?.href).toBe(ENTRY);
  });

  it("demands the exact versioned schema", () => {
    expect(parseRuntimePointer({ entry: ENTRY }, BASE)).toBeNull();
    expect(parseRuntimePointer({ ...POINTER, schema: "successor.client-runtime-pointer.v2" }, BASE)).toBeNull();
    expect(parseRuntimePointer({ ...POINTER, schema: undefined }, BASE)).toBeNull();
    expect(parseRuntimePointer(null, BASE)).toBeNull();
    expect(parseRuntimePointer("pointer", BASE)).toBeNull();
    expect(parseRuntimePointer([POINTER], BASE)).toBeNull();
  });

  it("rejects malformed entries", () => {
    expect(parseRuntimePointer({ ...POINTER, entry: "" }, BASE)).toBeNull();
    expect(parseRuntimePointer({ ...POINTER, entry: 7 }, BASE)).toBeNull();
    expect(parseRuntimePointer({ ...POINTER, entry: `https://cdn.example/${"x".repeat(2048)}` }, BASE)).toBeNull();
    expect(parseRuntimePointer({ ...POINTER, entry: "https://" }, BASE)).toBeNull();
  });

  it("rejects non-http(s) schemes and embedded credentials", () => {
    // eslint-disable-next-line no-script-url
    expect(parseRuntimePointer({ ...POINTER, entry: "javascript:alert(1)" }, BASE)).toBeNull();
    expect(parseRuntimePointer({ ...POINTER, entry: "data:text/html,<p>x</p>" }, BASE)).toBeNull();
    expect(parseRuntimePointer({ ...POINTER, entry: "file:///etc/passwd" }, BASE)).toBeNull();
    expect(parseRuntimePointer({ ...POINTER, entry: "https://user:pw@cdn.example/x.html" }, BASE)).toBeNull();
  });

  it("loads the pointer without caching and reads trouble as absent", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(POINTER), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await loadRuntimePointer(BASE))?.href).toBe(ENTRY);
    expect(fetchMock).toHaveBeenCalledWith(RUNTIME_POINTER_PATH, { cache: "no-store" });

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 404 })));
    expect(await loadRuntimePointer(BASE)).toBeNull();

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("not json", { status: 200 })));
    expect(await loadRuntimePointer(BASE)).toBeNull();

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down")));
    expect(await loadRuntimePointer(BASE)).toBeNull();
    vi.unstubAllGlobals();
  });
});
