/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * An uploaded file in the context graph: its extracted text makes it a
 * document everyone on the project can find and read whole, the pack lists it,
 * and removing the file removes the document.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const VIEWER = { subject: "user_viewer" };

test("a file's text becomes a document, and goes with the file", async () => {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  const { projectId, fileId } = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "Rover",
      shareToken: "view",
      createdAt: 1,
    });
    await ctx.db.insert("shareClaims", {
      projectId,
      granteeId: VIEWER.subject,
      role: "viewer",
      createdAt: 1,
    });
    const storageId = await ctx.storage.store(new Blob(["x"]));
    const fileId = await ctx.db.insert("projectFiles", {
      ownerId: OWNER.subject,
      projectId,
      storageId,
      filename: "safety-case.pdf",
      mediaType: "application/pdf",
      size: 1,
      addedAt: 1,
    });
    return { projectId, fileId };
  });

  await t.mutation(internal.files.context.writeText, {
    fileId,
    text: "The rover stops within 300 ms of losing the heartbeat. Everything else follows from that.",
    fullChars: 90,
  });

  const viewer = t.withIdentity(VIEWER);
  const found = await viewer.query(api.context.read.search, { projectId, query: "heartbeat" });
  expect(found.map((f) => [f.kind, f.title, f.from])).toEqual([
    ["document", "safety-case.pdf", "an uploaded file"],
  ]);
  const read = await viewer.query(api.context.read.read, { projectId, id: found[0].id });
  expect(read?.brief).toBe("The rover stops within 300 ms of losing the heartbeat.");
  expect(read && "text" in read ? read.text : "").toContain("Everything else follows");

  const pack = await viewer.query(api.context.read.packInputs, { projectId });
  expect(pack?.documents).toEqual([
    { title: "safety-case.pdf", source: "file", brief: "The rover stops within 300 ms of losing the heartbeat." },
  ]);

  await t.withIdentity(OWNER).mutation(api.files.context.remove, { fileId });
  const left = await t.run(async (ctx) => ({
    nodes: await ctx.db.query("contextNodes").collect(),
    text: await ctx.db.query("contextNodeText").collect(),
  }));
  expect(left).toEqual({ nodes: [], text: [] });
});
