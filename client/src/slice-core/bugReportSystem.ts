export const bugReportBodyMinCharacters = 20;
export const bugReportBodyMaxCharacters = 4_000;

export type BugReportCategory =
  | "gameplay"
  | "interface"
  | "connection"
  | "graphics_audio"
  | "other";

export interface BugReportSubmission {
  readonly schema: "successor.bug-report-submission.v1";
  readonly requestId: string;
  readonly category: BugReportCategory;
  readonly body: string;
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

export interface AcceptedBugReport {
  readonly reportId: string;
  readonly receivedAt: number;
}

export type BugReportRejectReason = "invalid_report" | "rate_limited" | "unavailable" | "connection_lost";

export class BugReportSubmissionError extends Error {
  constructor(readonly reasonCode: BugReportRejectReason) {
    super(reasonCode);
    this.name = "BugReportSubmissionError";
  }
}

export function bugReportResultForRequest(
  payload: unknown,
  expectedRequestId: string,
): AcceptedBugReport | BugReportSubmissionError | null {
  if (!isRecord(payload) || payload.schema !== "successor.bug-report-result.v1") return null;
  if (payload.requestId !== expectedRequestId) return null;
  if (
    payload.status === "accepted"
    && typeof payload.reportId === "string"
    && payload.reportId.length >= 8
    && typeof payload.receivedAt === "number"
    && Number.isFinite(payload.receivedAt)
  ) {
    return {
      reportId: payload.reportId.slice(0, 128),
      receivedAt: Math.max(0, Math.trunc(payload.receivedAt)),
    };
  }
  if (
    payload.status === "rejected"
    && ["invalid_report", "rate_limited", "unavailable"].includes(String(payload.reasonCode))
  ) {
    return new BugReportSubmissionError(payload.reasonCode as BugReportRejectReason);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
