import { describe, expect, test } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { AUDIT_CSV_COLUMNS, auditCsv, csvField, type AuditCsvRow } from "./csv";

const row = (over: Partial<AuditCsvRow> = {}): AuditCsvRow => ({
  at: Date.UTC(2026, 8, 22, 9, 30, 0, 250),
  action: "comment.create",
  actorId: "user_ada",
  actorKind: "user",
  actorName: "Ada Lovelace",
  subjectKind: "thread",
  subjectId: "t_1",
  pageId: "p_1" as Id<"pages">,
  pageTitle: "Plan",
  meta: null,
  count: null,
  ...over,
});

/** A minimal RFC 4180 reader, so tests assert what a spreadsheet would see. */
function parse(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\r" && csv[i + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i++;
    } else field += c;
  }
  if (field || record.length) throw new Error("unterminated record");
  return records;
}

describe("auditCsv", () => {
  test("an empty log is the header alone, CRLF-terminated", () => {
    expect(auditCsv([])).toBe("at,action,actor,actor id,subject kind,subject id,page,counts\r\n");
    expect(parse(auditCsv([]))).toEqual([[...AUDIT_CSV_COLUMNS]]);
  });

  test("columns in their contracted order, time as ISO-8601 UTC", () => {
    const [, first] = parse(auditCsv([row({ meta: { counts: { mentions: 2, replies: 1 } } })]));
    expect(first).toEqual([
      "2026-09-22T09:30:00.250Z",
      "comment.create",
      "Ada Lovelace",
      "user_ada",
      "thread",
      "t_1",
      "Plan",
      "mentions=2; replies=1",
    ]);
  });

  test("an actor without a name is their id; operators and the system say what they are", () => {
    const records = parse(
      auditCsv([
        row({ actorName: null }),
        row({ actorKind: "operator", actorId: "operator_1", actorName: null }),
        row({ actorKind: "system", actorId: "system", actorName: null }),
      ]),
    );
    expect(records.slice(1).map((r) => [r[2], r[3]])).toEqual([
      ["user_ada", "user_ada"],
      ["operator", "operator_1"],
      ["system", "system"],
    ]);
  });

  test("missing references are empty cells; a page without a title falls back to its id", () => {
    const [, a, b] = parse(
      auditCsv([
        row({ subjectKind: null, subjectId: null, pageId: null, pageTitle: null }),
        row({ pageTitle: null }),
      ]),
    );
    expect([a[4], a[5], a[6]]).toEqual(["", "", ""]);
    expect(b[6]).toBe("p_1");
  });

  test("counts sort by name and include a coalesced event's own count", () => {
    const [, first] = parse(auditCsv([row({ meta: { counts: { zeta: 1, alpha: 3 } }, count: 37 })]));
    expect(first[7]).toBe("alpha=3; count=37; zeta=1");
  });

  test("commas, quotes and line breaks survive the round trip", () => {
    const title = 'Q3 "big" plan, v2\r\nsecond line\nthird';
    const [, first] = parse(auditCsv([row({ pageTitle: title, actorName: "Doe, Jane" })]));
    expect(first[6]).toBe(title);
    expect(first[2]).toBe("Doe, Jane");
  });

  test("unicode is carried through untouched", () => {
    const [, first] = parse(auditCsv([row({ actorName: "Zoë Ångström 李雷 🚀", pageTitle: "Прогноз — ✓" })]));
    expect(first[2]).toBe("Zoë Ångström 李雷 🚀");
    expect(first[6]).toBe("Прогноз — ✓");
  });

  test.each(["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])(
    "a cell starting %j is defused with a leading quote",
    (evil) => {
      const [, first] = parse(auditCsv([row({ pageTitle: evil, actorName: evil })]));
      expect(first[6]).toBe(`'${evil}`);
      expect(first[2]).toBe(`'${evil}`);
    },
  );

  test("a defused cell that also needs quoting is both", () => {
    expect(csvField('=1,"2"')).toBe(`"'=1,""2"""`);
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a = b")).toBe("a = b");
  });
});
