/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import { leavingOf } from "./http";

/**
 * Hanging up a presence row (NT-137): over the websocket while the page lives,
 * by beacon to `POST /presence/leave` as it goes. A refreshed tab keeps its
 * session id, so a goodbye that names its `clientId` takes down only the
 * incarnation that left — never the reloaded page that already announced
 * itself under the same id.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

type T = ReturnType<typeof harness>;

async function row(t: T, docId: string, sessionId: string, clientId: number) {
  await t.run((ctx) =>
    ctx.db.insert("presence", {
      docId,
      sessionId,
      clientId,
      user: { name: "Alice", color: "#cc3300" },
      state: new ArrayBuffer(1),
      updatedAt: Date.now(),
    }),
  );
}

const sessions = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query("presence").collect()).map((r) => `${r.docId}/${r.sessionId}/${r.clientId}`),
  );

const beacon = (t: T, body: unknown) =>
  t.fetch("/presence/leave", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("presence.leave", () => {
  test("hangs up the named session, and only it", async () => {
    const t = harness();
    await row(t, "d1", "s1", 1);
    await row(t, "d1", "s2", 2);
    await row(t, "d2", "s1", 1);
    expect(await t.mutation(api.presence.leave, { docId: "d1", sessionId: "s1" })).toBeNull();
    expect(await sessions(t)).toEqual(["d1/s2/2", "d2/s1/1"]);
  });

  test("with a clientId, takes down only that incarnation", async () => {
    const t = harness();
    await row(t, "d1", "s1", 2);
    await t.mutation(api.presence.leave, { docId: "d1", sessionId: "s1", clientId: 1 });
    expect(await sessions(t)).toEqual(["d1/s1/2"]);
    await t.mutation(api.presence.leave, { docId: "d1", sessionId: "s1", clientId: 2 });
    expect(await sessions(t)).toEqual([]);
  });

  test("leaving a session that has no row is a no-op", async () => {
    const t = harness();
    expect(await t.mutation(api.presence.leave, { docId: "d1", sessionId: "gone", clientId: 3 })).toBeNull();
  });
});

describe("POST /presence/leave", () => {
  test("a beacon hangs up the session it names, with no auth", async () => {
    const t = harness();
    await row(t, "d1", "s1", 1);
    await row(t, "d1", "s2", 2);
    const answer = await beacon(t, { docId: "d1", sessionId: "s1", clientId: 1 });
    expect(answer.status).toBe(204);
    expect(await sessions(t)).toEqual(["d1/s2/2"]);
  });

  test("a late beacon leaves the reloaded page's row alone", async () => {
    const t = harness();
    // The refresh reused session s1; its new page announced itself as client 9
    // before the old page's goodbye (client 1) arrived.
    await row(t, "d1", "s1", 9);
    expect((await beacon(t, { docId: "d1", sessionId: "s1", clientId: 1 })).status).toBe(204);
    expect(await sessions(t)).toEqual(["d1/s1/9"]);
  });

  test("anything that is not a well-formed goodbye is refused and deletes nothing", async () => {
    const t = harness();
    await row(t, "d1", "s1", 1);
    for (const body of [
      "",
      "not json",
      "null",
      "[]",
      { docId: "d1" },
      { sessionId: "s1" },
      { docId: 1, sessionId: "s1" },
      { docId: "d1", sessionId: "" },
      { docId: "d1", sessionId: "s1", clientId: "1" },
      { docId: "d1", sessionId: "s1", clientId: 1.5 },
      { docId: "d1", sessionId: "x".repeat(2000) },
    ]) {
      expect((await beacon(t, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await sessions(t)).toEqual(["d1/s1/1"]);
  });

  test("only POST is routed", async () => {
    const t = harness();
    expect((await t.fetch("/presence/leave", { method: "GET" })).status).toBe(404);
  });
});

describe("leavingOf", () => {
  test("keeps exactly the three fields", () => {
    expect(leavingOf(JSON.stringify({ docId: "d", sessionId: "s", clientId: 4, extra: true }))).toEqual({
      docId: "d",
      sessionId: "s",
      clientId: 4,
    });
    expect(leavingOf(JSON.stringify({ docId: "d", sessionId: "s" }))).toEqual({ docId: "d", sessionId: "s" });
  });
});
