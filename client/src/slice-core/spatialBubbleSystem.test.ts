import { describe, expect, it } from "vitest";
import {
  enqueueSpatialBubble,
  spatialBubblesForActor,
  spatialBubbleTtlMs,
  wrapSpeechBubbleText,
  type SpatialBubbleState,
} from "./spatialBubbleSystem";

const fixedWidth = {
  measureText: (text: string) => ({ width: text.length * 8 }),
};

describe("spatialBubbleSystem", () => {
  it("trims messages, pushes newest first, and enforces max stack", () => {
    const state: SpatialBubbleState = { chatBubbles: [] };

    enqueueSpatialBubble(state, { body: " first ", sender: "Field Observer", own: true });
    enqueueSpatialBubble(state, { body: "second", sender: "Warden", own: false });
    enqueueSpatialBubble(state, { body: "third", sender: "Warden", own: false });
    enqueueSpatialBubble(state, { body: "fourth", sender: "Warden", own: false });
    enqueueSpatialBubble(state, { body: "  ", sender: "Warden", own: false });

    expect(state.chatBubbles.map((bubble) => bubble.body)).toEqual(["fourth", "third", "second"]);
    expect(state.chatBubbles[0]?.ttlMs).toBe(state.chatBubbles[0]?.totalTtlMs);
  });

  it("routes each network speech bubble to its actor without using the local fallback", () => {
    const state: SpatialBubbleState = { chatBubbles: [] };

    enqueueSpatialBubble(state, { body: "Lycaon line", sender: "Lycaon", own: true });
    enqueueSpatialBubble(state, { body: "Oleks line", sender: "Oleks", own: false, actorId: "char_oleks" });

    expect(spatialBubblesForActor(state.chatBubbles, "char_oleks", "char_lycaon").map((bubble) => bubble.body)).toEqual(["Oleks line"]);
    expect(spatialBubblesForActor(state.chatBubbles, "char_lycaon", "char_lycaon").map((bubble) => bubble.body)).toEqual(["Lycaon line"]);
  });

  it("fails closed when an actor-owned bubble has no resolvable actor id", () => {
    const state: SpatialBubbleState = { chatBubbles: [] };

    enqueueSpatialBubble(state, { body: "unresolved remote line", sender: "Oleks", own: false, actorId: undefined });

    expect(spatialBubblesForActor(state.chatBubbles, "char_lycaon", "char_lycaon")).toEqual([]);
    expect(spatialBubblesForActor(state.chatBubbles, "char_oleks", "char_lycaon")).toEqual([]);
  });

  it("clamps ttl for short and long messages", () => {
    expect(spatialBubbleTtlMs("x")).toBe(2200);
    expect(spatialBubbleTtlMs("x".repeat(400))).toBe(7000);
  });

  it("wraps long speech text and truncates extra lines with ellipsis", () => {
    const lines = wrapSpeechBubbleText(
      fixedWidth,
      "one two three four five six seven eight nine ten eleven twelve",
      48,
      3,
    );

    expect(lines).toHaveLength(3);
    expect(lines[2]?.endsWith("...")).toBe(true);
  });
});
