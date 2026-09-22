/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { NodeInput } from "./github/graphShape";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * The GitHub connector's half of the graph, without GitHub: what the indexer
 * writes lands with its hierarchy, reads back as a map, a pack and search
 * results, is named once and only once, keeps the styling invariant's name,
 * and goes when the repository is unlinked.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const VIEWER = { subject: "user_viewer" };
const FULL = "kestrel/rover";

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

const node = (n: Partial<NodeInput> & Pick<NodeInput, "kind" | "externalId" | "title">): NodeInput => ({
  tier: n.kind === "repo" ? "source" : n.kind === "file" ? "artifact" : "concern",
  brief: "",
  summary: "",
  terms: n.title,
  ...n,
});

async function indexed(t: TestConvex<typeof schema>) {
  const { projectId, repoId } = await t.run(async (ctx) => {
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
    const repoId = await ctx.db.insert("projectRepos", {
      ownerId: OWNER.subject,
      projectId,
      fullName: FULL,
      defaultBranch: "main",
      private: false,
      index: { state: "naming", files: 3, concerns: 2, areas: 2 },
      addedAt: 1,
    });
    return { projectId, repoId };
  });

  const written = await t.mutation(internal.github.graphStore.writeNodes, {
    repoId,
    nodes: [
      node({ kind: "repo", externalId: FULL, title: FULL }),
      node({ kind: "area", externalId: `${FULL}#area:firmware`, parent: FULL, title: "Firmware" }),
      node({ kind: "area", externalId: `${FULL}#area:styling`, parent: FULL, title: "Styling" }),
      node({
        kind: "concern",
        externalId: `${FULL}#concern:firmware/watchdog`,
        parent: `${FULL}#area:firmware`,
        title: "Firmware watchdog",
        brief: "2 files, mostly in src/teleop",
      }),
      node({
        kind: "concern",
        externalId: `${FULL}#concern:styling-and-components`,
        parent: `${FULL}#area:styling`,
        title: "Styling and components",
        summary: "--foreground: oklch(0.25 0.005 90)\nComponents: Button",
        styling: true,
      }),
      node({
        kind: "file",
        externalId: `${FULL}:src/teleop/watchdog.c`,
        parent: `${FULL}#concern:firmware/watchdog`,
        title: "src/teleop/watchdog.c",
        brief: "Stops the rover when the heartbeat is lost.",
        terms: "src teleop watchdog\nHEARTBEAT_TIMEOUT_MS watchdog_task",
        url: `https://github.com/${FULL}/blob/abc/src/teleop/watchdog.c`,
      }),
      node({
        kind: "file",
        externalId: `${FULL}:src/ui/Button.tsx`,
        parent: `${FULL}#concern:styling-and-components`,
        title: "src/ui/Button.tsx",
        terms: "src ui Button",
      }),
    ],
  });
  const id = new Map(written.map((w) => [w.externalId, w.id]));
  await t.mutation(internal.github.graphStore.writeEdges, {
    repoId,
    edges: [
      {
        from: id.get(`${FULL}#concern:firmware/watchdog`)!,
        to: id.get(`${FULL}#concern:styling-and-components`)!,
        family: "references",
        type: "rollup",
        weight: 2.5,
      },
      {
        from: id.get(`${FULL}:src/teleop/watchdog.c`)!,
        to: id.get(`${FULL}:src/ui/Button.tsx`)!,
        family: "references",
        type: "imports",
      },
    ],
  });
  return { projectId, repoId, id };
}

describe("a repository in the context graph", () => {
  test("its nodes land inside one another, as the indexer wrote them", async () => {
    const t = harness();
    const { id } = await indexed(t);
    const file = await t.run((ctx) => ctx.db.get(id.get(`${FULL}:src/teleop/watchdog.c`)!));
    expect(file?.parentId).toBe(id.get(`${FULL}#concern:firmware/watchdog`));
  });

  test("the graph view gets the map — areas and concerns, never files — and its ties", async () => {
    const t = harness();
    const { projectId } = await indexed(t);
    const graph = await t.withIdentity(VIEWER).query(api.context.read.graph, { projectId });
    expect(graph?.code.repos.map((r) => [r.fullName, r.state])).toEqual([[FULL, "naming"]]);
    expect(graph?.code.areas.map((a) => a.title).sort()).toEqual(["Firmware", "Styling"]);
    expect(graph?.code.concerns.find((c) => c.styling)?.title).toBe("Styling and components");
    expect(graph?.code.rollups).toHaveLength(1);
  });

  test("every pack carries the code map and the styling facts", async () => {
    const t = harness();
    const { projectId } = await indexed(t);
    const pack = await t.withIdentity(OWNER).query(api.context.read.packInputs, { projectId });
    expect(pack?.code).toEqual([
      {
        fullName: FULL,
        files: 3,
        areas: expect.arrayContaining([
          { title: "Firmware", concerns: ["Firmware watchdog"] },
          { title: "Styling", concerns: ["Styling and components"] },
        ]),
        styling: "--foreground: oklch(0.25 0.005 90)\nComponents: Button",
      },
    ]);
  });

  test("search finds a file by what it exports; expand walks from it", async () => {
    const t = harness();
    const { projectId } = await indexed(t);
    const viewer = t.withIdentity(VIEWER);
    const found = await viewer.query(api.context.read.search, {
      projectId,
      query: "HEARTBEAT_TIMEOUT_MS",
    });
    expect(found.map((f) => [f.kind, f.title, f.repo])).toEqual([
      ["file", "src/teleop/watchdog.c", FULL],
    ]);
    const around = await viewer.query(api.context.read.expand, {
      projectId,
      id: `${FULL}:src/teleop/watchdog.c`,
    });
    expect(around?.links.map((l) => [l.relation, l.title])).toEqual([
      ["in concern", "Firmware watchdog"],
      ["imports", "src/ui/Button.tsx"],
    ]);
  });

  test("a concern's panel lists its files and what it works with", async () => {
    const t = harness();
    const { projectId, id } = await indexed(t);
    const detail = await t.withIdentity(VIEWER).query(api.context.read.concern, {
      projectId,
      nodeId: id.get(`${FULL}#concern:firmware/watchdog`)!,
    });
    expect(detail?.files.map((f) => f.path)).toEqual(["src/teleop/watchdog.c"]);
    expect(detail?.related.map((r) => r.title)).toEqual(["Styling and components"]);
  });
});

describe("naming", () => {
  test("is claimed once, renames what it was given, and keeps the styling name", async () => {
    const t = harness();
    const { repoId, id } = await indexed(t);
    const owner = t.withIdentity(OWNER);
    const outline = await owner.mutation(api.github.naming.claim, { repoId });
    expect(outline?.areas.flatMap((a) => a.concerns.map((c) => c.name)).sort()).toEqual([
      "Firmware watchdog",
      "Styling and components",
    ]);
    // A second tab asking at once gets nothing to do.
    expect(await owner.mutation(api.github.naming.claim, { repoId })).toBeNull();

    await owner.mutation(api.github.naming.apply, {
      repoId,
      names: [
        {
          nodeId: id.get(`${FULL}#concern:firmware/watchdog`)!,
          title: "Teleop safety stop",
          brief: "Stops the rover when the operator's link drops.",
        },
        {
          nodeId: id.get(`${FULL}#concern:styling-and-components`)!,
          title: "Visual design",
          brief: "Tokens and shared components.",
        },
      ],
    });
    const after = await t.run(async (ctx) => ({
      watchdog: await ctx.db.get(id.get(`${FULL}#concern:firmware/watchdog`)!),
      styling: await ctx.db.get(id.get(`${FULL}#concern:styling-and-components`)!),
      repo: await ctx.db.get(repoId),
    }));
    expect(after.watchdog?.title).toBe("Teleop safety stop");
    expect(after.styling?.title).toBe("Styling and components");
    expect(after.styling?.brief).toBe("Tokens and shared components.");
    expect(after.repo?.index?.state).toBe("ready");
  });

  test("a viewer cannot claim or name someone else's repository", async () => {
    const t = harness();
    const { repoId } = await indexed(t);
    await expect(
      t.withIdentity(VIEWER).mutation(api.github.naming.claim, { repoId }),
    ).rejects.toThrow();
  });
});

test("unlinking a repository takes its graph with it", async () => {
  vi.useFakeTimers();
  const t = harness();
  const { repoId } = await indexed(t);
  await t.withIdentity(OWNER).mutation(api.github.repos.unlink, { repoId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const left = await t.run(async (ctx) => ({
    nodes: await ctx.db.query("contextNodes").collect(),
    edges: await ctx.db.query("contextEdges").collect(),
    text: await ctx.db.query("contextNodeText").collect(),
  }));
  expect(left).toEqual({ nodes: [], edges: [], text: [] });
  vi.useRealTimers();
});
