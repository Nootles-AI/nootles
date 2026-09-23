import { useState } from "react";
import { createRoot } from "react-dom/client";
import { getFunctionName } from "convex/server";
import type { ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import type { AuditRow } from "../convex/audit";
import { RowMenu, type Project } from "../app/components/projectParts";
import { StandInProvider } from "../app/components/StandIn";
import { exportCommentActivity } from "../app/lib/audit/exportCsv";

/**
 * The owner's "Export comment activity" action on a project's ⋯ menu — the
 * real `RowMenu`/`ProjectActions` and the real exporter — over a memory
 * stand-in for Convex that answers `audit.forProject` a page at a time, the
 * way the deployment does. The test drives it with real clicks and keys and
 * reads the file the browser saves.
 */

type Call = { name: string; args: { projectId: string; paginationOpts: { numItems: number; cursor: string | null } } };

declare global {
  var ntAudit: {
    calls: Call[];
    failures: string[];
    /** Replaces the log the stand-in serves. */
    setRows: (count: number) => void;
  };
}

const PROJECT_ID = "project_launch" as Id<"projects">;
const PAGE_ID = "page_plan" as Id<"pages">;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

function base(i: number): AuditRow {
  return {
    id: `event_${i}` as Id<"auditEvents">,
    at: T0 + i * 60_000,
    action: i % 3 === 2 ? "comment.resolve" : "comment.create",
    actorId: `user_${i % 4}`,
    actorKind: "user",
    actorName: `Person ${i % 4}`,
    subjectKind: "thread",
    subjectId: `t_${Math.floor(i / 3)}`,
    pageId: PAGE_ID,
    pageTitle: "Plan",
    meta: { ids: { pageId: PAGE_ID }, counts: { mentions: i % 2 } },
    count: null,
  };
}

/** The first rows carry everything a CSV writer gets wrong. */
const SPECIAL: Array<Partial<AuditRow>> = [
  { actorName: "=HYPERLINK(\"http://evil.example\",\"click\")", pageTitle: "Budget, \"final\"" },
  { actorName: "Zoë Ångström 李雷", pageTitle: "Прогноз\r\nQ3" },
  { actorKind: "operator", actorId: "operator_1", actorName: null, action: "entitlement.revoke", subjectKind: "feature", subjectId: "comments", pageId: null, pageTitle: null, meta: null },
  { actorName: null, pageTitle: "@cmd|' /C calc'!A0", meta: { counts: { replies: 2, mentions: 1 } }, count: 5 },
];

let rows: AuditRow[] = [];
function setRows(count: number) {
  rows = Array.from({ length: count }, (_, i) => ({ ...base(i), ...(SPECIAL[i] ?? {}) }));
}
setRows(450);

const convex = {
  query: async (reference: unknown, args: Call["args"]) => {
    const name = getFunctionName(reference as never);
    globalThis.ntAudit.calls.push({ name, args });
    if (name !== "audit:forProject") throw new Error(`fixture backend has no query ${name}`);
    if (args.projectId !== PROJECT_ID) throw new Error("Not found");
    const start = args.paginationOpts.cursor === null ? 0 : Number(args.paginationOpts.cursor);
    const end = Math.min(rows.length, start + args.paginationOpts.numItems);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { page: rows.slice(start, end), isDone: end >= rows.length, continueCursor: String(end) };
  },
} as unknown as Pick<ConvexReactClient, "query">;

const project = {
  _id: PROJECT_ID,
  title: "Launch: Q3/Q4 plan",
  pageCount: 1,
  updatedAt: T0,
} as unknown as Project;

function Fixture() {
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <StandInProvider>
      <main style={{ padding: 24 }}>
        <span>{project.title}</span>
        <RowMenu
          project={project}
          onOpen={() => {}}
          onRename={() => {}}
          onExport={() => {
            exportCommentActivity(convex, project).catch((error: unknown) => {
              globalThis.ntAudit.failures.push(String(error));
              setFailure("The comment activity didn’t export.");
            });
          }}
          onDelete={() => {}}
        />
        {failure && <p role="alert">{failure}</p>}
      </main>
    </StandInProvider>
  );
}

globalThis.ntAudit = { calls: [], failures: [], setRows };
createRoot(document.getElementById("root")!).render(<Fixture />);
