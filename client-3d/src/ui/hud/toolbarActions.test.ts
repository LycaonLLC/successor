import { describe, expect, it } from "vitest";
import { toolbarActionById } from "./toolbarActions";
import type { ToolbarActionContext } from "./toolbarActions";

describe("toolbar resource actions", () => {
  it("labels hand sampling as universal and full surveying as trained tool work", () => {
    const sample = toolbarActionById("sample");
    const survey = toolbarActionById("survey");

    expect(sample?.label).toBe("Hand sample");
    expect(sample?.description).toContain("No profession or tool required");
    expect(survey?.label).toBe("Tool survey");
    expect(survey?.description).toContain("Requires Craftsman training");
    expect(survey?.description).toContain("matching survey tool");
  });

  it("opens the family picker on first use instead of requiring prior sample context", () => {
    const opened: string[] = [];
    const context = {
      openWindow: (id: string) => opened.push(id),
    } as unknown as ToolbarActionContext;

    expect(toolbarActionById("sample")?.execute(context)).toEqual({
      ok: true,
      receipt: "RESOURCE TARGETING",
    });
    expect(toolbarActionById("survey")?.execute(context)).toEqual({
      ok: true,
      receipt: "RESOURCE TARGETING",
    });
    expect(opened).toEqual(["surveyTool", "surveyTool"]);
  });
});
