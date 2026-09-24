/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { claimRole } from "./auth";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import { joinUpdateRows } from "./yshape";
import { decodeNmlDocument, executeNmlCommands, type NmlBlock } from "@/app/lib/nml";
import { threadsOf } from "@/app/lib/comments/types";
import { noChange } from "@/app/lib/comments/updates.fixture";

/**
 * The commenter role (docs/commenting-plan.md §5, PR 3), driven the way a
 * person reaches it: the owner turns a link on with `share.setLink`, a guest
 * opens it and `share.claim` records them, and every question after that is
 * asked of the real gates with the real claim. Nothing here seeds a claim row
 * by hand except where a test is about a row's shape rather than its origin.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const ADA = { subject: "user_ada" };
const BOB = { subject: "user_bob" };
const STRANGER = { subject: "user_stranger" };
/** An operator standing in for Ada: her subject, plus the `act` claim. */
const ADA_STAND_IN = { subject: ADA.subject, act: "operator_1" };
const OWNER_STAND_IN = { subject: OWNER.subject, act: "operator_1" };

type LinkRole = "viewer" | "commenter" | "editor";
type T = TestConvex<typeof schema>;

function harness(): T {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

type World = { projectId: Id<"projects">; pageId: Id<"pages">; docId: string };

/** An owner's project with one page and no links on. */
async function world(t: T): Promise<World> {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "P",
      createdAt: 1,
      updatedAt: 1,
    });
    const docId = crypto.randomUUID();
    const pageId = await ctx.db.insert("pages", {
      ownerId: OWNER.subject,
      projectId,
      title: "Plan",
      order: 0,
      docId,
      createdAt: 1,
      updatedAt: 1,
    });
    for (const [who, name] of [[ADA, "Ada"], [BOB, "Bob"]] as const) {
      await ctx.db.insert("profiles", { ownerId: who.subject, name, status: "skipped", createdAt: 1 });
    }
    return { projectId, pageId, docId };
  });
}

const link = async (t: T, w: World, role: LinkRole, enabled = true) =>
  await t.withIdentity(OWNER).mutation(api.share.setLink, { projectId: w.projectId, role, enabled });

/** Turns a link on and returns its token. */
async function on(t: T, w: World, role: LinkRole): Promise<string> {
  const token = await link(t, w, role);
  if (!token) throw new Error("setLink returned no token");
  return token;
}

const off = (t: T, w: World, role: LinkRole) => link(t, w, role, false);

const claim = (t: T, who: { subject: string }, token: string) =>
  t.withIdentity(who).mutation(api.share.claim, { token });

const roleOf = (t: T, who: { subject: string }, w: World) =>
  t.withIdentity(who).query(api.projects.myRole, { projectId: w.projectId });

const claimRow = (t: T, who: { subject: string }, w: World) =>
  t.run(async (ctx) =>
    ctx.db
      .query("shareClaims")
      .withIndex("by_project_and_grantee", (q) =>
        q.eq("projectId", w.projectId).eq("granteeId", who.subject),
      )
      .unique(),
  );

const listed = async (t: T, w: World) =>
  (await t.withIdentity(OWNER).query(api.share.collaborators, { projectId: w.projectId })).map(
    ({ granteeId, role }) => [granteeId, role],
  );

function bytes(update: Uint8Array): ArrayBuffer {
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

function textUpdate(text: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  return bytes(Y.encodeStateAsUpdate(doc));
}

/** Everything the log holds for a doc, as the given identity may load it. */
async function loaded(t: T, who: { subject: string } | null, docId: string): Promise<Y.Doc> {
  const as = who ? t.withIdentity(who) : t;
  const log = await as.query(api.ydoc.load, { docId, afterSeq: 0 });
  const doc = new Y.Doc();
  for (const row of joinUpdateRows(log!.updates)) Y.applyUpdate(doc, new Uint8Array(row.update));
  return doc;
}

describe("setLink and links — the third link", () => {
  test("the owner turns the comment link on, idempotently, and off again", async () => {
    const t = harness();
    const w = await world(t);
    const token = await on(t, w, "commenter");
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await on(t, w, "commenter")).toBe(token);
    expect(await t.withIdentity(OWNER).query(api.share.links, { projectId: w.projectId })).toMatchObject({
      viewer: null,
      commenter: token,
      editor: null,
    });

    expect(await off(t, w, "commenter")).toBeNull();
    expect(await t.withIdentity(OWNER).query(api.share.links, { projectId: w.projectId })).toMatchObject({
      viewer: null,
      commenter: null,
      editor: null,
    });
    // Turning it on again mints a NEW token: the old URL stays dead.
    const again = await on(t, w, "commenter");
    expect(again).not.toBe(token);
    expect(await t.query(api.share.view, { token })).toBeNull();
  });

  test("three links, three distinct capabilities", async () => {
    const t = harness();
    const w = await world(t);
    const tokens = [await on(t, w, "viewer"), await on(t, w, "commenter"), await on(t, w, "editor")];
    expect(new Set(tokens).size).toBe(3);
  });

  test("only the owner may turn it on or off; nobody else learns the links", async () => {
    const t = harness();
    const w = await world(t);
    const token = await on(t, w, "commenter");
    const edit = await on(t, w, "editor");
    await claim(t, ADA, token);
    await claim(t, BOB, edit);
    for (const who of [ADA, BOB, STRANGER]) {
      for (const enabled of [true, false]) {
        await expect(
          t.withIdentity(who).mutation(api.share.setLink, { projectId: w.projectId, role: "commenter", enabled }),
        ).rejects.toThrow("Not found");
      }
      await expect(
        t.withIdentity(who).query(api.share.links, { projectId: w.projectId }),
      ).rejects.toThrow("Not found");
    }
    await expect(
      t.mutation(api.share.setLink, { projectId: w.projectId, role: "commenter", enabled: false }),
    ).rejects.toThrow("Not found");
    // An operator standing in for the owner reads the links but cannot flip one.
    await expect(
      t.withIdentity(OWNER_STAND_IN).mutation(api.share.setLink, { projectId: w.projectId, role: "commenter", enabled: false }),
    ).rejects.toThrow("Read-only");
    expect(
      (await t.withIdentity(OWNER_STAND_IN).query(api.share.links, { projectId: w.projectId })).commenter,
    ).toBe(token);
  });
});

describe("view — the public door", () => {
  test("names the comment link's role, and nothing once it is off or the project is trashed", async () => {
    const t = harness();
    const w = await world(t);
    const token = await on(t, w, "commenter");
    const seen = await t.query(api.share.view, { token });
    expect(seen).toMatchObject({ projectId: w.projectId, role: "commenter", title: "P" });
    expect(seen?.pages?.map((p) => p.docId)).toEqual([w.docId]);

    await t.run(async (ctx) => ctx.db.patch(w.projectId, { deletedAt: 5 }));
    expect(await t.query(api.share.view, { token })).toBeNull();
    await t.run(async (ctx) => ctx.db.patch(w.projectId, { deletedAt: undefined }));

    await off(t, w, "commenter");
    expect(await t.query(api.share.view, { token })).toBeNull();
  });

  test("each link reports its own role", async () => {
    const t = harness();
    const w = await world(t);
    for (const role of ["viewer", "commenter", "editor"] as const) {
      const token = await on(t, w, role);
      expect((await t.query(api.share.view, { token }))?.role).toBe(role);
    }
    expect(await t.query(api.share.view, { token: "" })).toBeNull();
    expect(await t.query(api.share.view, { token: crypto.randomUUID() })).toBeNull();
  });
});

describe("claim — upgrades, never demotes", () => {
  test("each link claims its own role", async () => {
    for (const role of ["viewer", "commenter", "editor"] as const) {
      const t = harness();
      const w = await world(t);
      await claim(t, ADA, await on(t, w, role));
      expect(await roleOf(t, ADA, w)).toBe(role);
      expect((await claimRow(t, ADA, w))?.role).toBe(role);
    }
  });

  // [first link opened, second link opened, the role that results]
  const orders: Array<[LinkRole, LinkRole, LinkRole]> = [
    ["viewer", "commenter", "commenter"],
    ["commenter", "viewer", "commenter"],
    ["commenter", "editor", "editor"],
    ["editor", "commenter", "editor"],
    ["viewer", "editor", "editor"],
    ["editor", "viewer", "editor"],
    ["commenter", "commenter", "commenter"],
  ];
  test.each(orders)("opening the %s link, then the %s link → %s", async (first, second, result) => {
    const t = harness();
    const w = await world(t);
    const tokens = {
      viewer: await on(t, w, "viewer"),
      commenter: await on(t, w, "commenter"),
      editor: await on(t, w, "editor"),
    };
    await claim(t, ADA, tokens[first]);
    await claim(t, ADA, tokens[second]);
    expect((await claimRow(t, ADA, w))?.role).toBe(result);
    expect(await roleOf(t, ADA, w)).toBe(result);
    // One claim per person, however many links they open.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("shareClaims")
        .withIndex("by_project_and_grantee", (q) => q.eq("projectId", w.projectId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("an editor whose link was turned off becomes a commenter by opening the live comment link", async () => {
    const t = harness();
    const w = await world(t);
    await claim(t, ADA, await on(t, w, "editor"));
    await off(t, w, "editor");
    const token = await on(t, w, "commenter");
    expect(await roleOf(t, ADA, w)).toBe("viewer");

    await claim(t, ADA, token);
    expect((await claimRow(t, ADA, w))?.role).toBe("commenter");
    expect(await roleOf(t, ADA, w)).toBe("commenter");
    await t.withIdentity(ADA).mutation(api.comments.ensureDoc, { pageId: w.pageId });
  });

  test("a claim whose link died is not lowered by opening the viewer link", async () => {
    const t = harness();
    const w = await world(t);
    await claim(t, ADA, await on(t, w, "commenter"));
    await off(t, w, "commenter");
    await claim(t, ADA, await on(t, w, "viewer"));
    // Nothing to gain, so nothing written: a comment link turned back on
    // restores them, as it restores every claimant it demoted.
    expect((await claimRow(t, ADA, w))?.role).toBe("commenter");
    expect(await roleOf(t, ADA, w)).toBe("viewer");
    await on(t, w, "commenter");
    expect(await roleOf(t, ADA, w)).toBe("commenter");
  });

  test("the owner opening their own comment link records nothing", async () => {
    const t = harness();
    const w = await world(t);
    expect(await claim(t, OWNER, await on(t, w, "commenter"))).toBe(w.projectId);
    expect(await claimRow(t, OWNER, w)).toBeNull();
    expect(await roleOf(t, OWNER, w)).toBe("owner");
  });

  test("a dead comment link claims nothing; signed out or standing in, nothing is claimed", async () => {
    const t = harness();
    const w = await world(t);
    const token = await on(t, w, "commenter");
    await expect(t.mutation(api.share.claim, { token })).rejects.toThrow("Not signed in");
    await expect(claim(t, ADA_STAND_IN, token)).rejects.toThrow("Read-only");
    await off(t, w, "commenter");
    await expect(claim(t, ADA, token)).rejects.toThrow("Not found");
    expect(await claimRow(t, ADA, w)).toBeNull();
  });
});

describe("demotion by live-token re-derivation", () => {
  test("revoking the comment link demotes its claimants to viewer while another link is live", async () => {
    const t = harness();
    const w = await world(t);
    await on(t, w, "viewer");
    await claim(t, ADA, await on(t, w, "commenter"));
    expect(await roleOf(t, ADA, w)).toBe("commenter");

    await off(t, w, "commenter");
    expect(await roleOf(t, ADA, w)).toBe("viewer");
    expect(await listed(t, w)).toEqual([[ADA.subject, "viewer"]]);
    // The claim row still says how they came; it is the live token that decides.
    expect((await claimRow(t, ADA, w))?.role).toBe("commenter");

    // A new comment link restores them — the same rule the editor link has.
    await on(t, w, "commenter");
    expect(await roleOf(t, ADA, w)).toBe("commenter");
  });

  test("revoking every link closes the project to a commenter", async () => {
    const t = harness();
    const w = await world(t);
    await on(t, w, "viewer");
    await on(t, w, "editor");
    await claim(t, ADA, await on(t, w, "commenter"));

    await off(t, w, "viewer");
    await off(t, w, "editor");
    expect(await roleOf(t, ADA, w)).toBe("commenter");
    await off(t, w, "commenter");
    expect(await roleOf(t, ADA, w)).toBeNull();
    expect(await listed(t, w)).toEqual([]);
    expect(
      await t.withIdentity(ADA).query(api.projects.get, { projectId: w.projectId }),
    ).toBeNull();
  });

  test("the comment link alone keeps viewer and editor claimants in, as viewers", async () => {
    const t = harness();
    const w = await world(t);
    await claim(t, ADA, await on(t, w, "viewer"));
    await claim(t, BOB, await on(t, w, "editor"));
    await on(t, w, "commenter");
    await off(t, w, "viewer");
    await off(t, w, "editor");
    expect(await roleOf(t, ADA, w)).toBe("viewer");
    // An editor claim does not fall to commenter: the claim cannot say whether
    // they ever held the comment link, so it fails closed.
    expect(await roleOf(t, BOB, w)).toBe("viewer");
  });

  test("an owner-granted editor is unaffected by the comment link", async () => {
    const t = harness();
    const w = await world(t);
    await on(t, w, "viewer");
    await claim(t, ADA, await on(t, w, "commenter"));

    await t.withIdentity(ADA).mutation(api.share.requestEdit, { projectId: w.projectId });
    const [ask] = await t.withIdentity(OWNER).query(api.share.incomingRequests, {});
    expect(ask).toMatchObject({ projectId: w.projectId, name: "Ada" });
    await t.withIdentity(OWNER).mutation(api.share.decideRequest, { requestId: ask.requestId, grant: true });
    expect(await roleOf(t, ADA, w)).toBe("editor");

    await off(t, w, "commenter");
    expect(await roleOf(t, ADA, w)).toBe("editor");
    await off(t, w, "viewer");
    expect(await roleOf(t, ADA, w)).toBeNull();
  });
});

describe("claimRole — every claim, every combination of links", () => {
  const LINK_STATES = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => ({
    shareToken: bits & 1 ? "v" : undefined,
    commentShareToken: bits & 2 ? "c" : undefined,
    editShareToken: bits & 4 ? "e" : undefined,
  }));
  const CLAIMS = [
    { role: "viewer" },
    { role: "commenter" },
    { role: "editor" },
    { role: "viewer", grantedRole: "editor" },
    { role: "commenter", grantedRole: "editor" },
    { role: "editor", grantedRole: "editor" },
  ] as const;

  /** The rule, written out as a table rather than as code. */
  function expected(links: (typeof LINK_STATES)[number], c: (typeof CLAIMS)[number]) {
    if (!links.shareToken && !links.commentShareToken && !links.editShareToken) return null;
    if ("grantedRole" in c) return "editor";
    if (c.role === "editor" && links.editShareToken) return "editor";
    if (c.role === "commenter" && links.commentShareToken) return "commenter";
    return "viewer";
  }

  for (const links of LINK_STATES) {
    for (const c of CLAIMS) {
      test(`${JSON.stringify(links)} × ${JSON.stringify(c)}`, () => {
        const project = { ownerId: OWNER.subject, title: "P", createdAt: 1, ...links } as Doc<"projects">;
        const row = { granteeId: ADA.subject, createdAt: 1, ...c } as Doc<"shareClaims">;
        expect(claimRole(project, row, 1)).toBe(expected(links, c));
      });
    }
  }

  test("the owner's list and each claimant's own session agree in every state", async () => {
    const kinds = CLAIMS.map((c, i) => ({ who: `user_${i}`, ...c }));
    for (const links of LINK_STATES) {
      const t = harness();
      const w = await world(t);
      await t.run(async (ctx) => {
        await ctx.db.patch(w.projectId, links);
        for (const { who, ...row } of kinds) {
          await ctx.db.insert("shareClaims", { projectId: w.projectId, granteeId: who, ...row, createdAt: 1 });
        }
      });
      const mine = [];
      for (const { who } of kinds) {
        const role = await roleOf(t, { subject: who }, w);
        if (role) mine.push([who, role]);
      }
      expect({ links, listed: await listed(t, w) }).toEqual({ links, listed: mine });
    }
  });
});

describe("what a commenter sees of the project", () => {
  test("listed as a commenter, shared with them as one", async () => {
    const t = harness();
    const w = await world(t);
    await claim(t, ADA, await on(t, w, "commenter"));
    await claim(t, BOB, await on(t, w, "viewer"));
    expect(await listed(t, w)).toEqual([
      [ADA.subject, "commenter"],
      [BOB.subject, "viewer"],
    ]);
    const shared = await t.withIdentity(ADA).query(api.projects.sharedWithMe, {});
    expect(shared).toMatchObject([{ _id: w.projectId, role: "commenter" }]);
    // Reads the project and its pages like any role-holder.
    expect(await t.withIdentity(ADA).query(api.projects.get, { projectId: w.projectId })).not.toBeNull();
    expect(
      (await t.withIdentity(ADA).query(api.pages.listByProject, { projectId: w.projectId })).map((p) => p._id),
    ).toEqual([w.pageId]);
  });

  test("an operator standing in for a commenter is told viewer", async () => {
    const t = harness();
    const w = await world(t);
    await claim(t, ADA, await on(t, w, "commenter"));
    expect(await roleOf(t, ADA_STAND_IN, w)).toBe("viewer");
  });

  test("no chat, no turns, no project files: the assistant is the pen's", async () => {
    const t = harness();
    const w = await world(t);
    await claim(t, ADA, await on(t, w, "commenter"));
    expect(await t.withIdentity(ADA).query(api.chat.threads.list, { projectId: w.projectId })).toEqual([]);
    expect(await t.withIdentity(ADA).query(api.chat.turns.unreviewed, { projectId: w.projectId })).toEqual([]);
  });
});

describe("requestEdit — a commenter may ask for the pen", () => {
  test("asks, is declined quietly, stays a commenter, and may ask again", async () => {
    const t = harness();
    const w = await world(t);
    await claim(t, ADA, await on(t, w, "commenter"));
    const id = await t.withIdentity(ADA).mutation(api.share.requestEdit, { projectId: w.projectId });
    expect(id).not.toBeNull();
    expect(await t.withIdentity(ADA).query(api.share.myEditRequest, { projectId: w.projectId })).toEqual({
      status: "pending",
    });
    const [ask] = await t.withIdentity(OWNER).query(api.share.incomingRequests, {});
    await t.withIdentity(OWNER).mutation(api.share.decideRequest, { requestId: ask.requestId, grant: false });
    expect(await roleOf(t, ADA, w)).toBe("commenter");
    expect(await t.withIdentity(ADA).mutation(api.share.requestEdit, { projectId: w.projectId })).toBe(id);
    expect(await t.withIdentity(OWNER).query(api.share.incomingRequests, {})).toHaveLength(1);
  });

  test("a commenter demoted to nothing cannot ask", async () => {
    const t = harness();
    const w = await world(t);
    await claim(t, ADA, await on(t, w, "commenter"));
    await off(t, w, "commenter");
    await expect(
      t.withIdentity(ADA).mutation(api.share.requestEdit, { projectId: w.projectId }),
    ).rejects.toThrow("Not found");
  });
});

describe("the gate, end to end with a real claim", () => {
  /** A project with the comment link on, Ada claimed through it, and the page doc born. */
  async function commented(t: T) {
    const w = await world(t);
    const token = await on(t, w, "commenter");
    await claim(t, ADA, token);
    await t.withIdentity(OWNER).mutation(api.ydoc.init, { docId: w.docId, update: textUpdate("page") });
    return { ...w, token };
  }

  test("a commenter starts a thread in the comments document and the owner reads it", async () => {
    const t = harness();
    const w = await commented(t);
    const docId = await t.withIdentity(ADA).mutation(api.comments.ensureDoc, { pageId: w.pageId });
    expect(await t.withIdentity(ADA).query(api.comments.docFor, { pageId: w.pageId })).toBe(docId);

    const mine = await loaded(t, ADA, docId);
    const sent: Uint8Array[] = [];
    mine.on("update", (update: Uint8Array) => sent.push(update));
    const thread: NmlBlock = {
      id: "t1",
      type: "commentThread",
      props: {
        anchor: { blockId: "p_1", exact: "page", prefix: "", suffix: "", offsetHint: 0 },
        status: "open",
      },
      children: [
        {
          id: "c1",
          type: "comment",
          props: { authorId: ADA.subject, createdAt: 10 },
          content: [{ type: "text", text: "Which page?", marks: [] }],
          children: [],
        },
      ],
    };
    await executeNmlCommands({
      doc: mine,
      documentId: docId,
      commands: [{ type: "insertNodes", parentId: null, nodes: [thread] }],
      origin: { version: 1, transactionId: "tx1", actor: { userId: ADA.subject, kind: "human" }, command: "createThread" },
      idempotencyKey: "tx1",
      authorize: () => true,
    });
    const seq = await t
      .withIdentity(ADA)
      .mutation(api.ydoc.append, { docId, update: bytes(Y.mergeUpdates(sent)) });
    expect(seq).toBe(2);

    const [read] = threadsOf(decodeNmlDocument(await loaded(t, OWNER, docId)));
    expect(read.id).toBe("t1");
    expect(read.comments.map((c) => c.authorId)).toEqual([ADA.subject]);
  });

  test("THE negative test: the same commenter is refused append and init on the page's docId", async () => {
    const t = harness();
    const w = await commented(t);
    const docId = await t.withIdentity(ADA).mutation(api.comments.ensureDoc, { pageId: w.pageId });
    // Admitted on the comments channel...
    await t.withIdentity(ADA).mutation(api.ydoc.append, { docId, update: noChange() });
    // ...and refused on the document channel, whatever the bytes are.
    await expect(
      t.withIdentity(ADA).mutation(api.ydoc.append, { docId: w.docId, update: textUpdate("edit") }),
    ).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(ADA).mutation(api.ydoc.append, { docId: w.docId, chunks: [textUpdate("edit")] }),
    ).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(ADA).mutation(api.ydoc.init, { docId: w.docId, update: textUpdate("edit") }),
    ).rejects.toThrow("Not found");
    // The page's log is exactly what the owner wrote.
    const meta = await t.withIdentity(ADA).query(api.ydoc.meta, { docId: w.docId });
    expect(meta?.seq).toBe(1);
    expect((await loaded(t, OWNER, w.docId)).getText("t").toString()).toBe("page");
  });

  test("a commenter is refused every requireEditable mutation", async () => {
    const t = harness();
    const w = await commented(t);
    const folderId = await t
      .withIdentity(OWNER)
      .mutation(api.folders.create, { projectId: w.projectId, title: "F" });
    const refusals = [
      () => t.withIdentity(ADA).mutation(api.pages.create, { projectId: w.projectId, title: "Mine" }),
      () => t.withIdentity(ADA).mutation(api.pages.rename, { pageId: w.pageId, title: "Renamed" }),
      () => t.withIdentity(ADA).mutation(api.pages.setMode, { pageId: w.pageId, mode: "complete" }),
      () => t.withIdentity(ADA).mutation(api.pages.remove, { pageId: w.pageId }),
      () => t.withIdentity(ADA).mutation(api.pages.duplicate, { pageId: w.pageId }),
      () => t.withIdentity(ADA).mutation(api.folders.create, { projectId: w.projectId, title: "G" }),
      () => t.withIdentity(ADA).mutation(api.folders.rename, { folderId, title: "H" }),
      () => t.withIdentity(ADA).mutation(api.folders.remove, { folderId }),
      () => t.withIdentity(ADA).mutation(api.trash.remove, { pages: [w.pageId] }),
      () => t.withIdentity(ADA).mutation(api.projects.rename, { projectId: w.projectId, title: "Q" }),
      () => t.withIdentity(ADA).mutation(api.share.setLink, { projectId: w.projectId, role: "editor", enabled: true }),
    ];
    for (const attempt of refusals) await expect(attempt()).rejects.toThrow("Not found");
    const page = await t.run(async (ctx) => ctx.db.get(w.pageId));
    expect(page?.title).toBe("Plan");
    expect(page?.deletedAt).toBeUndefined();
    const pages = await t.withIdentity(OWNER).query(api.pages.listByProject, { projectId: w.projectId });
    expect(pages).toHaveLength(1);
  });

  test("an operator standing in for a commenter is refused the comments channel", async () => {
    const t = harness();
    const w = await commented(t);
    const docId = await t.withIdentity(ADA).mutation(api.comments.ensureDoc, { pageId: w.pageId });
    await expect(
      t.withIdentity(ADA_STAND_IN).mutation(api.ydoc.append, { docId, update: textUpdate("x") }),
    ).rejects.toThrow("Read-only");
    await expect(
      t.withIdentity(ADA_STAND_IN).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
    ).rejects.toThrow("Read-only");
    // Still reads, like the viewer it is told it is.
    expect((await t.withIdentity(ADA_STAND_IN).query(api.ydoc.meta, { docId }))?.seq).toBe(1);
  });

  test("a signed-out visitor holding the comment link reads the page and is refused the comments", async () => {
    const t = harness();
    const w = await commented(t);
    const docId = await t.withIdentity(ADA).mutation(api.comments.ensureDoc, { pageId: w.pageId });
    // The only link on is the comment link: it alone opens the page to a guest.
    expect(await t.withIdentity(OWNER).query(api.share.links, { projectId: w.projectId })).toMatchObject({
      viewer: null,
      editor: null,
    });
    const seen = await t.query(api.share.view, { token: w.token });
    expect(seen?.role).toBe("commenter");
    const opened = seen?.pages?.[0];
    if (!opened) throw new Error("The comment link should open the tree.");
    expect((await t.query(api.ydoc.meta, { docId: opened.docId }))?.seq).toBe(1);
    expect((await loaded(t, null, w.docId)).getText("t").toString()).toBe("page");

    await expect(t.query(api.ydoc.meta, { docId })).rejects.toThrow("Not found");
    await expect(t.query(api.ydoc.load, { docId, afterSeq: 0 })).rejects.toThrow("Not found");
    expect(await t.query(api.comments.docFor, { pageId: w.pageId })).toBeNull();
    await expect(t.mutation(api.ydoc.append, { docId, update: textUpdate("x") })).rejects.toThrow("Not found");
    await expect(t.mutation(api.comments.ensureDoc, { pageId: w.pageId })).rejects.toThrow();
  });

  test("demoted by the comment link going off, a former commenter writes no more comments", async () => {
    const t = harness();
    const w = await commented(t);
    await on(t, w, "viewer");
    const docId = await t.withIdentity(ADA).mutation(api.comments.ensureDoc, { pageId: w.pageId });
    await t.withIdentity(ADA).mutation(api.ydoc.append, { docId, update: noChange() });

    await off(t, w, "commenter");
    await expect(
      t.withIdentity(ADA).mutation(api.ydoc.append, { docId, update: textUpdate("b") }),
    ).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(ADA).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
    ).rejects.toThrow("Not found");
    // Reads on, as the viewer they now are.
    expect((await t.withIdentity(ADA).query(api.ydoc.meta, { docId }))?.seq).toBe(2);

    await off(t, w, "viewer");
    await expect(t.withIdentity(ADA).query(api.ydoc.meta, { docId })).rejects.toThrow("Not found");
    await expect(t.withIdentity(ADA).query(api.ydoc.meta, { docId: w.docId })).rejects.toThrow("Not found");
  });

  test("a viewer on the same project is refused the comments channel's writes", async () => {
    const t = harness();
    const w = await commented(t);
    await claim(t, BOB, await on(t, w, "viewer"));
    const docId = await t.withIdentity(ADA).mutation(api.comments.ensureDoc, { pageId: w.pageId });
    await expect(
      t.withIdentity(BOB).mutation(api.ydoc.append, { docId, update: textUpdate("x") }),
    ).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(BOB).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
    ).rejects.toThrow("Not found");
    expect((await t.withIdentity(BOB).query(api.ydoc.meta, { docId }))?.seq).toBe(1);
  });
});
