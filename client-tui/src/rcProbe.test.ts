import { describe, expect, it } from "vitest";
import { rcProbeSourceMatchesClient, runRcWorldProbeFromFd } from "./rcProbe";
import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";

const slice: Pick<SliceSnapshot, "stateHash" | "actors" | "spawnZones"> = {
  stateHash: "slice-hash",
  actors: [],
  spawnZones: [],
};

const matchingAuthority = {
  sourceStateHash: "slice-hash",
  sourceActorCount: 0,
  sourceMatchesClient: true,
};

describe("rcProbeSourceMatchesClient", () => {
  it("rejects absent source metadata even when the authority flag is true", () => {
    expect(rcProbeSourceMatchesClient({ ...matchingAuthority, sourceStateHash: null }, slice)).toBe(false);
    expect(rcProbeSourceMatchesClient({ ...matchingAuthority, sourceActorCount: null }, slice)).toBe(false);
  });

  it("rejects malformed or mismatched source metadata", () => {
    expect(rcProbeSourceMatchesClient({ ...matchingAuthority, sourceActorCount: 0.5 }, slice)).toBe(false);
    expect(rcProbeSourceMatchesClient({ ...matchingAuthority, sourceStateHash: "other" }, slice)).toBe(false);
    expect(rcProbeSourceMatchesClient({ ...matchingAuthority, sourceActorCount: 1 }, slice)).toBe(false);
  });

  it("accepts exact source metadata only when shared authority marked it true", () => {
    expect(rcProbeSourceMatchesClient(matchingAuthority, slice)).toBe(true);
    expect(rcProbeSourceMatchesClient({ ...matchingAuthority, sourceMatchesClient: false }, slice)).toBe(false);
  });
});


describe("runRcWorldProbeFromFd", () => {
  it("classifies an unreadable capability channel without exposing the error", async () => {
    await expect(runRcWorldProbeFromFd(-1)).rejects.toMatchObject({ reasonClass: "input" });
  });
});
