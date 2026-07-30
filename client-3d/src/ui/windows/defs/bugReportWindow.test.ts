// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BugReportSubmissionError } from "@successor/client/src/slice-core/bugReportSystem";
import {
  BUG_REPORT_WINDOW_ID,
  bugReportSlashLine,
  createBugReportWindowDefinition,
} from "./bugReportWindow";

afterEach(() => {
  document.body.textContent = "";
});

describe("bug report window", () => {
  it("opens from the exact slash family and ignores normal chat", () => {
    const open = vi.fn();
    expect(bugReportSlashLine("/bugreport", open)).toBe("BUG REPORT OPEN");
    expect(bugReportSlashLine("/bugreport please", open)).toBe("BUG REPORT OPEN");
    expect(bugReportSlashLine("hello", open)).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("requires useful detail and submits it with the session diagnostics", async () => {
    const submit = vi.fn().mockResolvedValue({
      reportId: "bug_accepted_123",
      receivedAt: 42,
    });
    const definition = createBugReportWindowDefinition({
      submit,
      diagnostics: () => ({
        schema: "successor.bug-report-diagnostics.v1",
        authority: { connected: true },
      }),
      requestId: () => "6e934dfe-e9da-4d15-8da4-e6e32b7d5ab8",
    });
    expect(definition.id).toBe(BUG_REPORT_WINDOW_ID);
    const handle = definition.mount(document.body, {} as never);
    handle.update(0, 0);
    const body = document.querySelector<HTMLTextAreaElement>('[data-ref="body"]')!;
    const send = document.querySelector<HTMLButtonElement>('[data-ref="submit"]')!;
    const detailedReport = "The placed extractor vanished, but F still cranked it nearby.";

    body.value = "too short";
    body.dispatchEvent(new Event("input"));
    expect(send.disabled).toBe(true);
    body.value = detailedReport;
    body.dispatchEvent(new Event("input"));
    expect(send.disabled).toBe(false);
    send.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).toHaveBeenCalledWith({
      schema: "successor.bug-report-submission.v1",
      requestId: "6e934dfe-e9da-4d15-8da4-e6e32b7d5ab8",
      category: "gameplay",
      body: detailedReport,
      diagnostics: {
        schema: "successor.bug-report-diagnostics.v1",
        authority: { connected: true },
      },
    });
    expect(document.querySelector<HTMLElement>('[data-ref="received"]')?.hidden).toBe(false);
    expect(document.querySelector<HTMLFormElement>('[data-ref="form"]')?.hidden).toBe(true);
    expect(document.querySelector('[data-ref="reportId"]')?.textContent).toBe("bug_accepted_123");
    handle.dispose();
  });

  it("pins the flex form to display none while its receipt is visible", () => {
    const css = readFileSync("src/ui/windows/windows.css", "utf8");
    const bugReportSection = css.slice(css.indexOf("Player bug report"));
    expect(bugReportSection).toContain(".scp-bugreport-form[hidden] {\n  display: none;");
    expect(bugReportSection).toContain(".scp-bugreport-received[hidden] {\n  display: none;");
  });

  it("keeps the draft when the queue is unavailable", async () => {
    const submit = vi.fn().mockRejectedValue(new BugReportSubmissionError("unavailable"));
    const definition = createBugReportWindowDefinition({
      submit,
      diagnostics: () => ({ schema: "successor.bug-report-diagnostics.v1" }),
      requestId: () => "6e934dfe-e9da-4d15-8da4-e6e32b7d5ab8",
    });
    const handle = definition.mount(document.body, {} as never);
    const body = document.querySelector<HTMLTextAreaElement>('[data-ref="body"]')!;
    body.value = "My report remains here after the network submission fails.";
    body.dispatchEvent(new Event("input"));
    document.querySelector<HTMLButtonElement>('[data-ref="submit"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(body.value).toContain("remains here");
    expect(document.querySelector('[data-ref="status"]')?.textContent).toContain("YOUR REPORT IS KEPT");
    handle.dispose();
  });
});
