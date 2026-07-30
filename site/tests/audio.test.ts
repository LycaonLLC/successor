import { beforeEach, describe, expect, it } from "vitest";
import { initOldIntro, OLD_INTRO_SRC } from "../src/features/audio";
import type { AudioLike } from "../src/features/audio";
import { settle } from "./helpers";

class FakeAudio implements AudioLike {
  volume = 1;
  loop = true;
  playCalls = 0;
  pauseCalls = 0;
  listeners: Record<string, (() => void) | undefined> = {};
  play(): Promise<void> {
    this.playCalls += 1;
    return Promise.resolve();
  }
  pause(): void {
    this.pauseCalls += 1;
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] = listener;
  }
}

function makeButton(): HTMLButtonElement {
  document.body.innerHTML =
    '<button id="old-intro-toggle" aria-pressed="false" data-label-off="Play old intro" data-label-on="Music on · stop">Play old intro</button>';
  const button = document.getElementById("old-intro-toggle");
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
  return button;
}

describe("old intro audio control", () => {
  let created: FakeAudio[];
  let button: HTMLButtonElement;

  beforeEach(() => {
    created = [];
    button = makeButton();
    initOldIntro(button, {
      fadeMs: 0,
      createAudio: (src) => {
        expect(src).toBe(OLD_INTRO_SRC);
        const audio = new FakeAudio();
        created.push(audio);
        return audio;
      },
    });
  });

  it("fetches and plays nothing before the click", () => {
    expect(created).toHaveLength(0);
    expect(button.textContent?.trim()).toBe("Play old intro");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("plays once on click: no loop, faded to 35%, visible stop state", async () => {
    button.click();
    await settle();
    expect(created).toHaveLength(1);
    const audio = created[0];
    expect(audio?.loop).toBe(false);
    expect(audio?.playCalls).toBe(1);
    expect(audio?.volume).toBeCloseTo(0.35);
    expect(button.textContent?.trim()).toBe("Music on · stop");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("second click stops and restores the idle label", async () => {
    button.click();
    await settle();
    button.click();
    expect(created[0]?.pauseCalls).toBe(1);
    expect(button.textContent?.trim()).toBe("Play old intro");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("track end resets the control without looping", async () => {
    button.click();
    await settle();
    created[0]?.listeners["ended"]?.();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent?.trim()).toBe("Play old intro");
  });

  it("hidden tab pauses and forgets the on-state", async () => {
    button.click();
    await settle();
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(created[0]?.pauseCalls).toBe(1);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });
});
