import { z } from "zod";

export const bugReportCategories = [
  "gameplay",
  "interface",
  "connection",
  "graphics_audio",
  "other",
] as const;

export type BugReportCategory = (typeof bugReportCategories)[number];

const diagnosticsSchema = z.record(z.string().min(1).max(64), z.unknown()).refine(
  (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 24 * 1_024,
  { message: "bug report diagnostics are too large" },
);

export const bugReportSubmissionSchema = z.object({
  schema: z.literal("successor.bug-report-submission.v1"),
  requestId: z.string().uuid(),
  category: z.enum(bugReportCategories),
  body: z.string().trim().min(20).max(4_000),
  diagnostics: diagnosticsSchema,
}).strict().refine(
  (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 48 * 1_024,
  { message: "bug report payload is too large" },
);

export type BugReportSubmission = z.infer<typeof bugReportSubmissionSchema>;

export interface PersistBugReportInput {
  readonly requestId: string;
  readonly accountId?: string;
  readonly ownerRef: string;
  readonly characterId: string;
  readonly launchId?: string;
  readonly shardId: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly category: BugReportCategory;
  readonly body: string;
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

export interface PersistedBugReport {
  readonly reportId: string;
  readonly createdAt: number;
}

export interface BugReportWriter {
  createBugReport(input: PersistBugReportInput): PersistedBugReport;
}

const sensitiveKeyPattern = /(?:authorization|cookie|credential|csrf|password|secret|ticket|token)/iu;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~-]{16,}/giu;
const querySecretPattern = /([?&](?:chatTicket|csrf(?:Token)?|gameTicket|ticket|token)=)[^&\s]+/giu;

export function redactBugReportDiagnostics(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return redactRecord(value, 0);
}

function redactRecord(value: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
  if (depth > 5) return {};
  const entries = Object.entries(value).slice(0, 128).map(([key, entry]) => {
    if (sensitiveKeyPattern.test(key)) return [key, "[redacted]"] as const;
    return [key, redactValue(entry, depth + 1)] as const;
  });
  return Object.fromEntries(entries);
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value
      .slice(0, 2_000)
      .replace(bearerPattern, "Bearer [redacted]")
      .replace(querySecretPattern, "$1[redacted]");
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return depth > 5 ? [] : value.slice(0, 128).map((entry) => redactValue(entry, depth + 1));
  if (typeof value === "object" && value !== null) {
    return redactRecord(value as Readonly<Record<string, unknown>>, depth);
  }
  return null;
}
