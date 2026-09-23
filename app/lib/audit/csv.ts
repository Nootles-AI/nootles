/**
 * A project's audit log as CSV — what its owner downloads.
 *
 * RFC 4180: CRLF between records, a field quoted when it holds a comma, a
 * quote or a line break, and a quote inside one doubled. Every field is also
 * defused against spreadsheet formula injection (OWASP "CSV Injection"): a
 * cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is
 * prefixed with a single quote, so Excel and Sheets show it as text instead
 * of evaluating it. Page titles and profile names are written by people other
 * than the owner opening the file, which is exactly the case that matters.
 */

import type { AuditRow } from "@/convex/audit";

/** The fields of the log's rows this file writes. */
export type AuditCsvRow = Pick<
  AuditRow,
  | "at"
  | "action"
  | "actorId"
  | "actorKind"
  | "actorName"
  | "subjectKind"
  | "subjectId"
  | "pageId"
  | "pageTitle"
  | "meta"
  | "count"
>;

/** The column order is a contract with whoever scripts against the file. */
export const AUDIT_CSV_COLUMNS = [
  "at",
  "action",
  "actor",
  "actor id",
  "subject kind",
  "subject id",
  "page",
  "counts",
] as const;

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One field, defused and quoted as needed. */
export function csvField(value: string): string {
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function actorOf(row: AuditCsvRow): string {
  if (row.actorKind === "user") return row.actorName ?? row.actorId;
  return row.actorKind;
}

/**
 * The counts an event carries, as `name=value` pairs in name order — plus a
 * coalesced event's own `count`, which is a count of the same kind.
 */
function countsOf(row: AuditCsvRow): string {
  const counts: Record<string, number> = { ...row.meta?.counts };
  if (row.count !== null) counts.count = row.count;
  return Object.keys(counts)
    .sort()
    .map((key) => `${key}=${counts[key]}`)
    .join("; ");
}

export function auditCsv(rows: readonly AuditCsvRow[]): string {
  const records = [AUDIT_CSV_COLUMNS.map(csvField).join(",")];
  for (const row of rows) {
    const fields = [
      new Date(row.at).toISOString(),
      row.action,
      actorOf(row),
      row.actorId,
      row.subjectKind ?? "",
      row.subjectId ?? "",
      row.pageTitle ?? row.pageId ?? "",
      countsOf(row),
    ];
    records.push(fields.map(csvField).join(","));
  }
  return `${records.join("\r\n")}\r\n`;
}
