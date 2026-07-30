#!/usr/bin/env node

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const command = args[0]?.startsWith("--") ? "list" : (args.shift() ?? "list");
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(name);
const dbPath = option("--db") ?? process.env.ALPHA_CONTROL_DB_PATH;

if (!dbPath || !existsSync(dbPath)) {
  process.stderr.write("Usage: ALPHA_CONTROL_DB_PATH=/path/control.sqlite pnpm bugreports [list|show REPORT_ID] [--status open] [--limit 20] [--json]\n");
  process.exitCode = 2;
} else {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (command === "show") {
      const reportId = args[0];
      if (!reportId || !/^bug_[A-Za-z0-9]+$/u.test(reportId)) throw new Error("show requires a valid bug report ID");
      const row = db.prepare(`
        SELECT b.*, a.callsign
        FROM bug_reports b
        LEFT JOIN accounts a ON a.account_id = b.account_id
        WHERE b.report_id = ?
      `).get(reportId);
      if (!row) throw new Error(`bug report not found: ${reportId}`);
      const report = printableReport(row);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (command === "list") {
      const status = option("--status") ?? "open";
      if (!["open", "investigating", "resolved", "closed", "all"].includes(status)) {
        throw new Error("status must be open, investigating, resolved, closed, or all");
      }
      const limit = Number(option("--limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500");
      const rows = status === "all"
        ? db.prepare(`
            SELECT b.*, a.callsign
            FROM bug_reports b
            LEFT JOIN accounts a ON a.account_id = b.account_id
            ORDER BY b.created_at DESC
            LIMIT ?
          `).all(limit)
        : db.prepare(`
            SELECT b.*, a.callsign
            FROM bug_reports b
            LEFT JOIN accounts a ON a.account_id = b.account_id
            WHERE b.status = ?
            ORDER BY b.created_at DESC
            LIMIT ?
          `).all(status, limit);
      const reports = rows.map(printableReport);
      if (flag("--json")) {
        process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
      } else if (reports.length === 0) {
        process.stdout.write(`No ${status === "all" ? "" : `${status} `}bug reports.\n`);
      } else {
        for (const report of reports) {
          const identity = report.callsign
            ? `${report.callsign}/${report.characterId}`
            : report.characterId;
          const excerpt = report.body.replace(/\s+/gu, " ").slice(0, 120);
          process.stdout.write(
            `${report.createdAt}  ${report.status.padEnd(13)}  ${report.category.padEnd(14)}  ${report.reportId}  ${identity}  ${JSON.stringify(excerpt)}\n`,
          );
        }
      }
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  } finally {
    db.close();
  }
}

function printableReport(row) {
  let diagnostics = {};
  try {
    diagnostics = JSON.parse(String(row.diagnostics_json));
  } catch {
    diagnostics = { parseError: true };
  }
  return {
    reportId: String(row.report_id),
    status: String(row.status),
    category: String(row.category),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    callsign: row.callsign === null || row.callsign === undefined ? null : String(row.callsign),
    characterId: String(row.character_id),
    shardId: String(row.shard_id),
    clientReleaseId: String(row.client_release_id),
    serverReleaseId: String(row.server_release_id),
    body: String(row.body),
    diagnostics,
    resolutionNote: row.resolution_note === null || row.resolution_note === undefined
      ? null
      : String(row.resolution_note),
  };
}
