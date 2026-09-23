import { describe, expect, test } from "vitest";
import { actorName, ago, toCsv, whatParts, whatText, type AuditRow } from "./auditWords";

const row = (over: Partial<AuditRow>): AuditRow => ({
  at: Date.UTC(2026, 8, 20, 12),
  action: "workspace.create",
  actorId: "user_maya",
  actorKind: "user",
  actor: { name: "Maya", email: "maya@acme.com" },
  subjectKind: null,
  subjectId: null,
  subject: null,
  meta: {},
  count: null,
  ...over,
});

describe("the sentence", () => {
  test("a plan given by support names the plan", () => {
    const set = row({
      action: "entitlement.set",
      actorKind: "operator",
      meta: { feature: "plan", value: "team", note: "Internal tester" },
    });
    expect(`${actorName(set, null)} ${whatText(set, "Acme")}`).toBe(
      "Nootles support put this workspace on the Team plan",
    );
    const clear = row({ action: "entitlement.clear", meta: { feature: "plan" } });
    expect(whatText(clear, "Acme")).toBe("took this workspace off the plan it was given");
  });

  test("any other override names the feature, never its key", () => {
    const say = (meta: AuditRow["meta"], action = "entitlement.set") =>
      whatText(row({ action, actorKind: "operator", meta }), "Acme");
    expect(say({ feature: "auditLog", value: true })).toBe(
      "turned on the audit log for this workspace",
    );
    expect(say({ feature: "guestDailyAiUsd", value: 5 })).toBe(
      "set the guests’ daily AI allowance to $5",
    );
    expect(say({ feature: "unmetered" }, "entitlement.clear")).toBe(
      "gave unmetered AI back to what the plan sets",
    );
  });

  test("a subscription's change is named by where it landed", () => {
    const say = (from: string, to: string) =>
      whatText(row({ action: "billing.subscription", meta: { from, to } }), "Acme");
    expect(say("none", "active")).toBe("started the subscription");
    expect(say("active", "past_due")).toBe("marked the subscription past due");
    expect(say("past_due", "canceled")).toBe("ended the subscription");
  });

  test("links and roles are called what the screens that set them call them", () => {
    const link = row({
      action: "share.link.expiry",
      meta: { projectId: "p1", project: "Beacon", role: "editor" },
    });
    expect(whatText(link, "Acme")).toBe("set the editor link for Beacon to never expire");
    const role = row({
      action: "member.role",
      subject: { name: "Tom", email: null },
      meta: { from: "admin", to: "member" },
    });
    expect(whatText(role, "Acme")).toBe("changed Tom’s role from admin to member");
  });

  test("a removal names who went and where from", () => {
    const r = row({
      action: "member.remove",
      subjectKind: "user",
      subjectId: "user_tom",
      subject: { name: "Tom", email: null },
      meta: { role: "member" },
    });
    expect(`${actorName(r, null)} ${whatText(r, "Acme")}`).toBe("Maya removed Tom from Acme");
  });

  test("an edit window names the page and counts its changes", () => {
    const r = row({
      action: "page.edit",
      meta: { projectId: "p1", project: "Launch", page: "Roadmap" },
      count: 37,
    });
    expect(whatParts(r, "Acme")).toEqual([
      "edited “Roadmap” in ",
      { project: "p1", title: "Launch" },
      " · 37 changes",
    ]);
    expect(whatText({ ...r, count: 1 }, "Acme")).toBe("edited “Roadmap” in Launch");
  });

  test("a rename links the project under its new name", () => {
    const r = row({
      action: "project.rename",
      meta: { projectId: "p1", project: "Old", from: "Old", to: "New" },
    });
    expect(whatParts(r, "Acme")).toEqual(["renamed the project “Old” to ", { project: "p1", title: "New" }]);
  });

  test("each setting reads as its own change", () => {
    const off = row({ action: "workspace.settings", meta: { setting: "linkSharing", from: true, to: false } });
    expect(whatText(off, "Acme")).toBe("turned share links off");
    const ttl = row({ action: "workspace.settings", meta: { setting: "linkTtlDays", from: null, to: 30 } });
    expect(whatText(ttl, "Acme")).toBe("set new share links to expire after 30 days");
  });

  test("a move between projects links both, and a folder counts its pages", () => {
    const moved = row({
      action: "page.move",
      subjectKind: "page",
      meta: { projectId: "p1", project: "Launch", page: "Roadmap", toProjectId: "p2", toProject: "Ops" },
    });
    expect(whatParts(moved, "Acme")).toEqual([
      "moved the page “Roadmap” from ",
      { project: "p1", title: "Launch" },
      " to ",
      { project: "p2", title: "Ops" },
    ]);
    const restored = row({
      action: "folder.restore",
      subjectKind: "folder",
      meta: { projectId: "p1", project: "Launch", folder: "Specs", pages: 30 },
    });
    expect(whatText(restored, "Acme")).toBe("restored the folder “Specs” in Launch, with 30 pages");
    expect(whatText({ ...restored, meta: { ...restored.meta, pages: 0 } }, "Acme")).toBe(
      "restored the folder “Specs” in Launch",
    );
  });

  test("an unlink a removal caused says why", () => {
    const meta = { projectId: "p1", project: "Launch", reason: "linked by a member who left" };
    expect(whatText(row({ action: "repo.unlink", meta: { ...meta, repo: "acme/rover" } }), "Acme")).toBe(
      "unlinked acme/rover from Launch, as it was linked by a member who left",
    );
    expect(whatText(row({ action: "notion.unlink", meta: { ...meta, page: "Brief" } }), "Acme")).toBe(
      "unlinked the Notion page “Brief” from Launch, as it was linked by a member who left",
    );
  });

  test("an unknown action is said as itself", () => {
    expect(whatText(row({ action: "something.new" }), "Acme")).toBe("made a change (something.new)");
  });
});

describe("a stand-in", () => {
  test("names whose account, and never an operator's reason", () => {
    const r = row({
      action: "operator.standIn",
      actorKind: "operator",
      actorId: "s1",
      actor: null,
      subjectKind: "user",
      subjectId: "user_tom",
      subject: { name: "Tom", email: null },
      meta: { sessionId: "j1", reason: "Acme reports a billing bug" },
    });
    expect(whatText(r, "Acme")).toBe("viewed the workspace as Tom");
    expect(toCsv([r], "Acme")).not.toContain("billing bug");
  });
});

describe("who acted", () => {
  test("you, a system by its name, an operator as support", () => {
    expect(actorName(row({}), "user_maya")).toBe("You");
    expect(actorName(row({ actorKind: "system", actorId: "stripe", actor: null }), null)).toBe("Stripe");
    expect(actorName(row({ actorKind: "operator", actorId: "s1", actor: null }), null)).toBe(
      "Nootles support",
    );
    expect(actorName(row({ actor: null }), null)).toBe("Someone");
  });
});

describe("when", () => {
  const now = Date.UTC(2026, 8, 23, 12);
  test("short within a week, a date after", () => {
    expect(ago(now - 20_000, now)).toBe("now");
    expect(ago(now - 5 * 60_000, now)).toBe("5m");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2d");
    // In the reader's own locale, as every other date in settings is.
    const day = { day: "numeric", month: "short" } as const;
    const aug = Date.UTC(2026, 7, 1, 12);
    const lastAug = Date.UTC(2025, 7, 1, 12);
    expect(ago(aug, now)).toBe(new Intl.DateTimeFormat(undefined, day).format(aug));
    expect(ago(lastAug, now)).toBe(
      new Intl.DateTimeFormat(undefined, { ...day, year: "numeric" }).format(lastAug),
    );
  });
});

describe("the file", () => {
  test("a header, one line per event, quoted and defused where it must be", () => {
    const csv = toCsv(
      [
        row({
          action: "project.create",
          meta: { projectId: "p1", project: '=HYPERLINK("x"), "a"' },
        }),
      ],
      "Acme",
    );
    const [head, line, end] = csv.split("\r\n");
    expect(head).toBe(
      "time,actor,actor_email,actor_kind,action,description,subject_kind,subject_id,project_id,count",
    );
    expect(line).toBe(
      '2026-09-20T12:00:00.000Z,Maya,maya@acme.com,user,project.create,' +
        '"Maya created the project =HYPERLINK(""x""), ""a""",,,p1,',
    );
    expect(end).toBe("");
  });

  test("a field that opens like a formula is prefixed so a spreadsheet reads text", () => {
    const hostile = row({
      actor: { name: '=cmd|"/c calc"!A1', email: "+1@x.io" },
    });
    const line = toCsv([hostile], "Acme").split("\r\n")[1];
    const fields = line.split(",");
    expect(fields[1]).toBe(`"'=cmd|""/c calc""!A1"`);
    expect(fields[2]).toBe("'+1@x.io");
    expect(fields[5].startsWith(`"'=cmd`)).toBe(true);

    const [dash, at, plain] = [
      { name: "-2+3", email: "@home" },
      { name: "@SUM(A1)", email: "maya@acme.com" },
      { name: "Maya", email: "maya@acme.com" },
    ].map((actor) => toCsv([row({ actor })], "Acme").split("\r\n")[1].split(","));
    expect(dash.slice(1, 3)).toEqual(["'-2+3", "'@home"]);
    expect(at[1]).toBe("'@SUM(A1)");
    expect(plain.slice(1, 3)).toEqual(["Maya", "maya@acme.com"]);
  });
});
