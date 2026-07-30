import { describe, expect, it } from "vitest";

import {
  BugReportSubmissionError,
  bugReportResultForRequest,
} from "./bugReportSystem";

describe("bug report result parser", () => {
  it("accepts only a matching, complete acknowledgement", () => {
    expect(bugReportResultForRequest({
      schema: "successor.bug-report-result.v1",
      requestId: "request-1",
      status: "accepted",
      reportId: "bug_12345678",
      receivedAt: 42.8,
    }, "request-1")).toEqual({
      reportId: "bug_12345678",
      receivedAt: 42,
    });
    expect(bugReportResultForRequest({
      schema: "successor.bug-report-result.v1",
      requestId: "other-request",
      status: "accepted",
      reportId: "bug_12345678",
      receivedAt: 42,
    }, "request-1")).toBeNull();
  });

  it("returns a typed player-safe rejection", () => {
    const result = bugReportResultForRequest({
      schema: "successor.bug-report-result.v1",
      requestId: "request-1",
      status: "rejected",
      reasonCode: "rate_limited",
    }, "request-1");
    expect(result).toBeInstanceOf(BugReportSubmissionError);
    expect((result as BugReportSubmissionError).reasonCode).toBe("rate_limited");
  });
});
