import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { auditMeta } from "./schema";

/**
 * The one writer of `auditEvents`. A helper rather than a mutation: an event
 * is recorded by the mutation that did the thing, inside its transaction, so
 * the record and the act land or fail together and no client can forge one.
 *
 * The shape is enforced here, not merely typed: an action is a dotted verb, and
 * every id is id-shaped — no spaces, bounded — so a comment body cannot ride
 * into the log through a field named like an identifier. What the log answers
 * is who touched what, and when; never what they said.
 */

export type AuditMeta = Infer<typeof auditMeta>;

export type AuditEvent = {
  projectId?: Id<"projects">;
  workspaceId?: string;
  actorId: string;
  actorKind: Doc<"auditEvents">["actorKind"];
  action: string;
  subjectKind?: string;
  subjectId?: string;
  meta?: AuditMeta;
};

const ACTION = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/;
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;

function assertId(value: string, what: string): void {
  if (!ID.test(value)) throw new Error(`Audit ${what} is not an identifier.`);
}

export async function recordAudit(
  ctx: MutationCtx,
  event: AuditEvent,
): Promise<Id<"auditEvents">> {
  if (!ACTION.test(event.action)) throw new Error("Audit action is not a dotted verb.");
  assertId(event.actorId, "actor");
  if (event.workspaceId !== undefined) assertId(event.workspaceId, "workspace");
  if (event.subjectKind !== undefined && !KEY.test(event.subjectKind)) {
    throw new Error("Audit subject kind is not a name.");
  }
  if (event.subjectId !== undefined) assertId(event.subjectId, "subject");
  for (const [key, value] of Object.entries(event.meta?.ids ?? {})) {
    if (!KEY.test(key)) throw new Error("Audit meta key is not a name.");
    assertId(value, `meta id "${key}"`);
  }
  for (const [key, value] of Object.entries(event.meta?.counts ?? {})) {
    if (!KEY.test(key)) throw new Error("Audit meta key is not a name.");
    if (!Number.isFinite(value)) throw new Error(`Audit meta count "${key}" is not a number.`);
  }
  return await ctx.db.insert("auditEvents", { ...event, at: Date.now() });
}
