import { describe, expect, it } from "vitest";

import {
  bugReportSubmissionSchema,
  redactBugReportDiagnostics,
} from "./bugReports.js";

describe("bug report support boundary", () => {
  it("accepts a bounded detailed report and rejects unknown or oversized fields", () => {
    const report = {
      schema: "successor.bug-report-submission.v1",
      requestId: "6e934dfe-e9da-4d15-8da4-e6e32b7d5ab8",
      category: "gameplay",
      body: "The extractor vanished immediately after I placed it.",
      diagnostics: { schema: "successor.bug-report-diagnostics.v1" },
    };
    expect(bugReportSubmissionSchema.safeParse(report).success).toBe(true);
    expect(bugReportSubmissionSchema.safeParse({ ...report, accountId: "claim-not-authority" }).success)
      .toBe(false);
    expect(bugReportSubmissionSchema.safeParse({
      ...report,
      diagnostics: { dump: "x".repeat(25 * 1_024) },
    }).success).toBe(false);
  });

  it("redacts secret-shaped keys and values recursively", () => {
    expect(redactBugReportDiagnostics({
      authorization: "Bearer should-not-survive",
      nested: {
        gameTicket: "should-not-survive",
        path: "/play?chatTicket=should-not-survive&mode=game",
        message: "request failed with Bearer abcdefghijklmnopqrstuvwxyz",
      },
    })).toEqual({
      authorization: "[redacted]",
      nested: {
        gameTicket: "[redacted]",
        path: "/play?chatTicket=[redacted]&mode=game",
        message: "request failed with Bearer [redacted]",
      },
    });
  });
});
