import { describe, expect, it } from "vitest";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { computeLayout, renderFrame, type FrameInputs } from "../app";
import { createContactTracker } from "../game/contacts";
import { surfaceToText } from "../term/compositor";
import { Surface } from "../term/surface";
import { ChatPane } from "./chat";
import { createCommandLine, insertText } from "./commandLine";
import { LogPane } from "./log";
import { createQueuePaneState } from "./queue";
import { createPalette } from "./styles";
import { ToastStack } from "./toasts";
import { createWeaponPaneState } from "./weapon";

function frameInputs(): FrameInputs {
  const { state, slice } = createTuiPlayStateFixture();
  const tracker = createContactTracker();
  tracker.update(state);
  const log = new LogPane();
  const at = 1_000;
  log.push({ register: "scene", text: "You stand in the open desert. The light is hard and flat, heat standing on the sand.", atMs: at });
  log.push({ register: "world", text: "A rogue trooper comes into scope, a stretch off to the east, weapon drawn.", atMs: at });
  log.push({ register: "echo", text: "/attack rogue-1", atMs: at });
  log.push({ register: "combat", text: "Your shot takes the rogue trooper square in the chest — 18.", atMs: at });
  log.push({ register: "reject", text: "SAMPLE RESOURCE DENIED — SAMPLER COOLING.", atMs: at });
  log.push({ register: "survey", text: "The scanner paints Dantooine iron strongest far off to the east — 100% at the peak.", atMs: at });
  const chatPane = new ChatPane();
  chatPane.push({
    id: "m1",
    channel: "local",
    sender: { id: "rusk", displayName: "Rusk" },
    body: "anyone near the extractor?",
    sentAt: "2026-07-08T00:00:00Z",
    zoneId: "open-desert",
    system: false,
  });
  const commandLine = createCommandLine();
  insertText(commandLine, "/attack rogue-1");
  return {
    state,
    slice,
    contacts: tracker.contacts(),
    log,
    chatPane,
    toasts: new ToastStack(),
    queuePane: createQueuePaneState(),
    weaponPane: createWeaponPaneState(),
    commandLine,
    palette: createPalette(),
  };
}

describe("full frame composition", () => {
  it("100×30 carries the full rail and the hero log", () => {
    const surface = new Surface(100, 30);
    renderFrame(surface, frameInputs());
    const text = surfaceToText(surface);
    expect(text).toContain("SUCCESSOR · OPEN DESERT");
    expect(text).toContain("HP");           // vitals rail
    expect(text).toContain("SLUGTHROWER"); // weapon designation
    expect(text).toContain("SHOT");         // queue row (pending basic_shot)
    expect(text).toContain("Rogue troop");  // contact list
    expect(text).toContain("weapon drawn"); // world prose intact
    expect(text).toContain("[local] Rusk: anyone near the extractor?");
    expect(text).toContain("> /attack rogue-1");
    expect(text).toMatchSnapshot();
  });

  it("80×24 collapses the rail first — prose and command line survive (hero-log law)", () => {
    const surface = new Surface(80, 24);
    renderFrame(surface, frameInputs());
    const text = surfaceToText(surface);
    expect(text).not.toContain("SLUGTHROWER"); // rail gone
    expect(text).toContain("weapon drawn"); // prose survives
    expect(text).toContain("> /attack rogue-1");
    expect(text).toMatchSnapshot();
  });

  it("layout never lets rails eat the log below the breakpoints", () => {
    const wide = computeLayout(120, 34);
    expect(wide.rail).not.toBeNull();
    expect(wide.log.w).toBeGreaterThan(80);
    const mid = computeLayout(90, 30);
    expect(mid.rail?.w).toBe(24);
    const narrow = computeLayout(72, 22);
    expect(narrow.rail).toBeNull();
    expect(narrow.log.w).toBe(70);
    expect(narrow.command.y).toBe(21);
  });

  it("frames are deterministic — same inputs, same cells", () => {
    const a = new Surface(100, 30);
    const b = new Surface(100, 30);
    renderFrame(a, frameInputs());
    renderFrame(b, frameInputs());
    expect(surfaceToText(a)).toBe(surfaceToText(b));
  });
});
