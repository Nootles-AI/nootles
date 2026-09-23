import type { ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { auditCsv, type AuditCsvRow } from "./csv";

/** Rows per round trip: small enough to stay far inside a query's read limits. */
const PAGE = 200;

/** A title made safe to be a file name on every desktop OS. */
function fileStem(title: string): string {
  const clean = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // By code point, so a title cut at the limit never splits an emoji in half.
  const stem = Array.from(clean).slice(0, 60).join("").trim();
  return stem || "Untitled project";
}

/** Every event in a project's log, oldest first, walked page by page. */
export async function readAuditLog(
  convex: Pick<ConvexReactClient, "query">,
  projectId: Id<"projects">,
): Promise<AuditCsvRow[]> {
  const rows: AuditCsvRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: FunctionReturnType<typeof api.audit.forProject> = await convex.query(
      api.audit.forProject,
      { projectId, paginationOpts: { numItems: PAGE, cursor } },
    );
    rows.push(...result.page);
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
}

/**
 * Builds the project's comment activity as CSV in the browser and hands it to
 * the browser as a download. Client-side on purpose: the paginated query
 * already carries the owner's auth, and a server route would need its own.
 */
export async function exportCommentActivity(
  convex: Pick<ConvexReactClient, "query">,
  project: { _id: Id<"projects">; title: string },
): Promise<void> {
  const csv = auditCsv(await readAuditLog(convex, project._id));
  // The byte-order mark is what makes Excel read the file as UTF-8 rather than
  // mangling every name with an accent in it.
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const day = new Date().toISOString().slice(0, 10);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileStem(project.title)} comment activity ${day}.csv`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked a beat later: some browsers start reading the blob after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
