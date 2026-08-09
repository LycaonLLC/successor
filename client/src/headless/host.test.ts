import path from "node:path";
import { describe, expect, it } from "vitest";

import { enqueueAuthorityCommand } from "../slice-core/authorityCommandSystem";
import { createSuccessorHeadlessHost, joinBodyFor, type SuccessorHeadlessHostOptions } from "./host";

describe("successor headless host", () => {
  it("requeues one unconfirmed authority envelope exactly once when the host closes", async () => {
    const host = await createSuccessorHeadlessHost({
      endpoint: "ws://unused.test",
      slicePath: path.resolve(import.meta.dirname, "../../public/successor-slice/open-desert-slice.json"),
    });
    const command = enqueueAuthorityCommand(host.state.authorityCommands, {
      EnterTransition: { transition_id: "headless-handoff" },
    }, 20);
    host.state.authorityCommands.pending.shift();
    host.state.authorityCommands.inFlight = command;

    await host.close();
    await host.close();

    expect(host.state.authorityCommands.inFlight).toBeNull();
    expect(host.state.authorityCommands.pending.map((pending) => pending.command_id)).toEqual([command.command_id]);
  });

  it("issues a fresh authority command above the restored command-ID floor", async () => {
    const alreadyUsedCommandId = 47;
    const host = await createSuccessorHeadlessHost({
      endpoint: "ws://unused.test",
      slicePath: path.resolve(import.meta.dirname, "../../public/successor-slice/open-desert-slice.json"),
      commandIdFloor: alreadyUsedCommandId + 1,
    });

    const command = enqueueAuthorityCommand(host.state.authorityCommands, {
      EnterTransition: { transition_id: "post-restart" },
    }, 20);

    expect(command.command_id).toBe(alreadyUsedCommandId + 1);
    expect(command.command_id).toBeGreaterThan(alreadyUsedCommandId);
  });

  it("sends exactly the standalone game capability in the join body", () => {
    const base: SuccessorHeadlessHostOptions = {
      endpoint: "http://127.0.0.1:9",
      slicePath: "unused.json",
      playerId: "legacy-player",
      actorId: "char_a",
      displayName: "Legacy Player",
      clientReleaseId: "release-a",
      zoneId: "open-desert",
      characterId: "char_a",
      ticket: "legacy-ticket",
      spawnArea: "camp",
      spawnX: 4,
      spawnY: 5,
      facing: "left",
    };

    expect(joinBodyFor({ ...base, gameTicket: "game-capability" }, "char_a")).toEqual({
      gameTicket: "game-capability",
      release: "release-a",
    });
    expect(joinBodyFor(base, "char_a")).toEqual({
      playerId: "legacy-player",
      actorId: "char_a",
      displayName: "Legacy Player",
      zoneId: "open-desert",
      characterId: "char_a",
      ticket: "legacy-ticket",
      spawnArea: "camp",
      spawnX: "4",
      spawnY: "5",
      facing: "left",
    });
  });

  it("clears the one-use game ticket as soon as the join request is built", async () => {
    const options: SuccessorHeadlessHostOptions = {
      // nothing listens here — the join fails, which is the point
      endpoint: "http://127.0.0.1:9",
      slicePath: path.resolve(import.meta.dirname, "../../public/successor-slice/open-desert-slice.json"),
      characterId: "char_a",
      actorId: "char_a",
      gameTicket: "game-capability",
      clientReleaseId: "release-a",
      readyTimeoutMs: 1_000,
    };
    const host = await createSuccessorHeadlessHost(options);
    await expect(host.start()).rejects.toThrow();
    expect(options.gameTicket).toBeUndefined();
  });
});
