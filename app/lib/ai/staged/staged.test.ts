import { describe, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import { parseDocHtml } from "@/app/lib/ai/html/parse";
import { TOOLS, isClientTool, type ToolName } from "@/app/lib/ai/chat/tools";
import { SCRIPTS } from "./scripts";
import { TAB_SCRIPTS } from "./tab";
import { allMatches, matchScript, stagingOn } from "./stage";
import { resolveStep } from "./model";
import type { StageContext } from "./types";

/**
 * What makes a live demo safe.
 *
 * The canned payloads cannot be wrong at run time, because they are wrong here
 * first: every tool input is parsed by the same Zod the route validates
 * against, every piece of canned markup goes through the real document parser,
 * and every phrasing a presenter might use is asserted to route to one script
 * and one only.
 */

/** The canned markup is parsed by the real parser, which wants a real DOM. */
const parseHtml = (html: string) =>
  new DOMParser().parseFromString(html, "text/html") as unknown as Document;

const ctx = (over: Partial<StageContext> = {}): StageContext => ({
  projectId: "p1",
  pageId: "pg_open",
  said: "",
  results: [],
  pages: [
    { pageId: "pg_open", title: "Program Brief" },
    { pageId: "pg_req", title: "Requirements & Traceability" },
    { pageId: "pg_test", title: "Test & Validation" },
  ],
  ...over,
});

describe("wording — a presenter can vary it", () => {
  for (const script of SCRIPTS) {
    it(`${script.id} answers every way it is asked`, () => {
      for (const said of script.says) {
        expect(matchScript(said)?.id, `"${said}"`).toBe(script.id);
      }
    });
  }

  for (const tab of TAB_SCRIPTS) {
    it(`${tab.id} fires on every ending`, () => {
      for (const typed of tab.types) {
        expect(tab.match.test(typed), `"${typed}"`).toBe(true);
      }
    });
  }
});

describe("separation — he cannot trip the wrong call", () => {
  it("no phrasing fires two scripts", () => {
    const clashes: string[] = [];
    for (const script of SCRIPTS) {
      for (const said of script.says) {
        const hits = allMatches(said).map((s) => s.id);
        if (hits.length !== 1) clashes.push(`"${said}" → ${hits.join(" + ") || "nothing"}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("no script's regex reaches into another's corpus", () => {
    const reach: string[] = [];
    for (const mine of SCRIPTS) {
      for (const theirs of SCRIPTS) {
        if (mine.id === theirs.id) continue;
        for (const said of theirs.says) {
          if (mine.match.test(said) && !mine.not?.test(said)) {
            reach.push(`${mine.id} catches ${theirs.id}: "${said}"`);
          }
        }
      }
    }
    expect(reach).toEqual([]);
  });

  it("the tab lane does not fire on chat wording, or on each other", () => {
    const wrong: string[] = [];
    for (const tab of TAB_SCRIPTS) {
      for (const script of SCRIPTS) {
        for (const said of script.says) {
          if (tab.match.test(said)) wrong.push(`${tab.id} fires on ${script.id}: "${said}"`);
        }
      }
      for (const other of TAB_SCRIPTS) {
        if (other.id === tab.id) continue;
        for (const typed of other.types) {
          if (tab.match.test(typed)) wrong.push(`${tab.id} fires on ${other.id}: "${typed}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("ordinary conversation stays unstaged", () => {
    // Ordinary things to say, and deliberate near-misses: each one sits a word
    // away from a staged call and must still reach the real model.
    const innocent = [
      "hello",
      "hi there",
      "what is this project?",
      "who's on the team?",
      "thanks, that's great",
      "can you make that a bit shorter",
      "what did we decide last week?",
      "summarise this page",
      "explain that again",
      "is this the right approach",
      "can you fix the typo",
      "what's in the BOM?",
      "delete this section",
      "show me the page list",
      "who owns the test plan?",
      // Near-misses, one word away from a staged call:
      "does the firmware actually work?", //      not a conformance check (C-16)
      "how does the watchdog work?", //           a walkthrough, not an audit (C-16)
      "what does this code do", //                ditto
      "tell me about the motor", //               not a margin question (C-18)
      "can we schedule a meeting", //             "schedule" the verb (C-13)
      "what's the plan for next week", //         not a roadmap (C-13)
      "make the text red", //                     not a diagram restyle (C-10)
      "colour me impressed", //                   (C-10)
      "turn that into a bullet list", //          (C-10)
      "two things I wanted to ask", //            not two variants (C-26)
      "do we have options here?", //              (C-26)
      "split the difference", //                  not a page split (C-06)
      "add a paragraph about safety", //          not a diagram node (C-09)
      "add a row to the table", //                (C-09)
      "add a heading here", //                    (C-09)
      "draw me a cat", //                         not an architecture diagram (C-11, C-07)
      "what's the weather",
    ];
    for (const said of innocent) {
      expect(matchScript(said)?.id ?? null, `"${said}"`).toBeNull();
    }
  });
});

describe("the call sheet the CEO is holding", () => {
  /**
   * Verbatim from the reference sheet he presents from. These are the only
   * phrasings we have actually promised somebody, so they are asserted by
   * themselves rather than trusted to the wider corpus: edit a regex and break
   * one of these, and it fails here rather than on stage.
   */
  const SHEET: [string, string][] = [
    ["does the firmware actually do what REQ-015 says?", "C-16"],
    ["draw our firmware architecture from the repo", "C-11"],
    ["diagram the power path", "C-07"],
    ["add a retry branch after the CAN timeout", "C-09"],
    ["colour the safety-critical path red", "C-10"],
    ["roadmap to the 8 Dec demo", "C-13"],
    ["what's the critical path?", "C-14"],
    ["which requirements have no test?", "C-05"],
    ["run an FMEA on the drive system", "C-21"],
    ["does this motor meet REQ-014?", "C-18"],
    ["write the ICD for compute to motor controller", "C-22"],
    ["wireframe the teleop operator screen", "C-12"],
    ["split this into one page per discipline", "C-06"],
    ["give me two chassis layouts", "C-26"],
  ];

  it("every line on it lands on the call it promises", () => {
    for (const [said, id] of SHEET) {
      expect(matchScript(said)?.id, `"${said}"`).toBe(id);
    }
  });

  it("covers all fourteen, one each", () => {
    expect(new Set(SHEET.map(([, id]) => id)).size).toBe(SCRIPTS.length);
  });

  it("the three typed lines fire their tab scripts", () => {
    const typed: [string, string][] = [
      ["The power path from the pack to the wheels looks like this:", "T-10"],
      ["// clamp the commanded current so we never exceed the BMS discharge limit", "T-07"],
      ["The heartbeat timeout lives in ", "T-20"],
    ];
    for (const [text, id] of typed) {
      const hits = TAB_SCRIPTS.filter((t) => t.match.test(text)).map((t) => t.id);
      expect(hits, `"${text}"`).toEqual([id]);
    }
  });
});

describe("payloads — validated by the machinery that will run them", () => {
  const everyCall = SCRIPTS.flatMap((script) =>
    script.steps.flatMap((step, at) =>
      (step.call ?? []).map((call) => ({ script, at, call })),
    ),
  );

  it("every tool named is a tool that exists", () => {
    for (const { script, call } of everyCall) {
      expect(Object.keys(TOOLS), script.id).toContain(call.tool);
    }
  });

  it("no script cans a tool result", () => {
    // Deliberate: a canned result is fiction sitting in the transcript for the
    // real model to believe the moment the presenter goes off script.
    for (const { call } of everyCall) {
      expect(Object.hasOwn(call as object, "output")).toBe(false);
    }
  });

  it("every resolved input parses under its own schema", () => {
    // Resolvers get a context rich enough to succeed: a page read that carries
    // a diagram, five made pages, a linked repo.
    const withEverything = ctx({
      results: [
        { toolName: "read_open_page", output: SCENE_READ },
        // Exactly what create_page returns, titles included — C-06 pairs on them.
        ...["Mechanical", "Power & Electrical", "Firmware", "Software & Fleet"].map((title, i) => ({
          toolName: "create_page",
          output: { pageId: `pg_made_${i}`, title },
        })),
      ],
    });
    for (const { script, at, call } of everyCall) {
      const input =
        typeof call.input === "function"
          ? (call.input as (c: StageContext) => unknown)(withEverything)
          : call.input;
      if (input === null) continue; // a resolver that stood down, tested below
      const schema = TOOLS[call.tool as ToolName].inputSchema;
      const parsed = schema.safeParse(input);
      expect(parsed.success, `${script.id} step ${at} ${call.tool}: ${parsed.error?.message}`).toBe(
        true,
      );
    }
  });

  it("every piece of canned markup parses as a document", () => {
    for (const { script, call } of everyCall) {
      if (call.tool !== "edit_page") continue;
      const input =
        typeof call.input === "function"
          ? (call.input as (c: StageContext) => { html?: string } | null)(
              ctx({ results: [{ toolName: "read_open_page", output: SCENE_READ }] }),
            )
          : (call.input as { html?: string });
      if (!input?.html) continue;
      const nodes = parseDocHtml(input.html, parseHtml);
      expect(nodes.length, `${script.id} produced no blocks`).toBeGreaterThan(0);
    }
  });

  it("C-06 links the four pages it made, and leaves the seeded one alone", () => {
    const script = SCRIPTS.find((s) => s.id === "C-06")!;
    const made = ["Mechanical", "Power & Electrical", "Firmware", "Software & Fleet"];
    expect(script.steps[0].call).toHaveLength(made.length);

    const linking = script.steps[1].call![0];
    const input = (linking.input as (c: StageContext) => { html: string } | null)(
      ctx({
        results: made.map((title, i) => ({
          toolName: "create_page",
          output: { pageId: `pg_${i}`, title },
        })),
      }),
    );
    expect(input?.html).toContain('<nt-ref page="pg_0">Mechanical</nt-ref>');
    expect(input?.html).toContain('<nt-ref page="pg_1">Power &amp; Electrical</nt-ref>');
    expect(input?.html).toContain('<nt-ref page="pg_3">Software &amp; Fleet</nt-ref>');
    // The seed already ships one, so C-06 must not make a second.
    expect(input?.html).not.toContain("Test &amp; Validation");
  });

  it("client tools carry a page id, because the schema demands one", () => {
    for (const { script, call } of everyCall) {
      if (!isClientTool(call.tool)) continue;
      expect(typeof call.input === "function" || call.tool === "read_open_page", script.id).toBe(
        true,
      );
    }
  });
});

describe("degrading — a skipped beat is an ordinary answer", () => {
  const chained = SCRIPTS.filter((s) => s.bail);

  it("a script that needs a diagram stands down when there is none", () => {
    for (const script of chained) {
      const editing = script.steps.findIndex((step) =>
        (step.call ?? []).some((call) => call.tool === "edit_page"),
      );
      if (editing < 0) continue;
      // Empty context: nothing read, no diagram, no repo.
      const step = resolveStep(
        script.steps[editing],
        ctx({ pageId: undefined, pages: [], results: [] }),
        script.bail,
      );
      expect(step.calls, `${script.id} still tried to act`).toEqual([]);
      expect(step.say, `${script.id} said nothing`).toBe(script.bail);
    }
  });

  it("running off the end of a script ends the turn", () => {
    for (const script of SCRIPTS) {
      const step = resolveStep(script.steps[script.steps.length + 1], ctx(), script.bail);
      expect(step.done).toBe(true);
      expect(step.calls).toEqual([]);
    }
  });
});

describe("the gate", () => {
  const env = (demo?: string, users?: string) => {
    process.env.STAGED_DEMO = demo;
    process.env.STAGED_DEMO_USERS = users;
  };
  const restore = () => env(undefined, undefined);

  it("is shut unless the flag is on AND the person is named", () => {
    restore();
    expect(stagingOn("user_demo")).toBe(false); // no flag

    env("1", undefined);
    expect(stagingOn("user_demo")).toBe(false); // flag, no allowlist

    env("1", "");
    expect(stagingOn("user_demo")).toBe(false); // empty allowlist is nobody

    env("1", "user_other");
    expect(stagingOn("user_demo")).toBe(false); // someone else's demo

    env("1", "user_demo");
    expect(stagingOn("user_demo")).toBe(true);

    env("1", "user_a, user_demo ,user_b");
    expect(stagingOn("user_demo")).toBe(true); // spaces and neighbours

    restore();
  });

  it("never stages an anonymous caller", () => {
    env("1", "user_demo");
    expect(stagingOn(null)).toBe(false);
    expect(stagingOn(undefined)).toBe(false);
    expect(stagingOn("")).toBe(false);
    restore();
  });

  it("cannot be opened by a prefix or a lookalike id", () => {
    env("1", "user_demo");
    for (const near of ["user_dem", "user_demo2", "USER_DEMO", " user_demo"]) {
      expect(stagingOn(near), near).toBe(false);
    }
    restore();
  });
});

describe("the tab lane's gate", () => {
  /**
   * Mirrors `StageDirector`'s check. Kept here rather than imported because the
   * component reads `process.env.NEXT_PUBLIC_*` at module load, which Next
   * inlines at build time — so the shape is what is worth asserting, and that
   * it is the SAME shape the server uses.
   */
  const staged = (userId: string | null | undefined, on: boolean, list: string) =>
    on && !!userId && list.split(",").map((s) => s.trim()).filter(Boolean).includes(userId);

  it("paints for the named person and nobody else", () => {
    expect(staged("user_demo", true, "user_demo")).toBe(true);
    expect(staged("user_demo", false, "user_demo")).toBe(false); // flag off
    expect(staged("user_demo", true, "")).toBe(false); // empty is nobody
    expect(staged("user_other", true, "user_demo")).toBe(false);
    expect(staged(null, true, "user_demo")).toBe(false); // signed out
    expect(staged(undefined, true, "user_demo")).toBe(false); // still loading
  });
});

describe("the table itself", () => {
  it("has the fourteen chat calls and the three tab calls, uniquely named", () => {
    expect(SCRIPTS).toHaveLength(14);
    expect(TAB_SCRIPTS).toHaveLength(3);
    const ids = [...SCRIPTS.map((s) => s.id), ...TAB_SCRIPTS.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every script carries a corpus worth trusting", () => {
    for (const script of SCRIPTS) {
      expect(script.says.length, script.id).toBeGreaterThanOrEqual(6);
    }
  });

  it("every chained script can bail", () => {
    // A script that reads before it writes must have somewhere to go when the
    // read comes back empty.
    for (const script of SCRIPTS) {
      const reads = script.steps.some((step) =>
        (step.call ?? []).some((call) => call.tool.startsWith("read_")),
      );
      if (reads) expect(script.bail, `${script.id} reads but cannot bail`).toBeTruthy();
    }
  });
});

/** A page read carrying a diagram, as `read_open_page` returns one. */
const SCENE_READ = `<h1>ICD</h1>
<p>The power path from the pack to the wheels:</p>
<nt-diagram id="blk_canvas" at="blk_canvas" w="1200" h="420" wide>
  <nt-rect id="pp-bus" x="440" y="160" w="130" h="76" style="fill:#dce9dc;stroke:#4a7a4a;stroke-width:2">48 V bus</nt-rect>
  <nt-rect id="pp-drv" x="640" y="230" w="150" h="76" style="fill:#f6e9d8;stroke:#a8702a;stroke-width:2">4× DRV8353</nt-rect>
  <nt-rect id="pp-estop" x="440" y="320" w="130" h="62" style="fill:#f7dede;stroke:#a33;stroke-width:2">E-stop contactor</nt-rect>
  <nt-edge id="pp-e5" from="pp-bus" to="pp-drv">48 V · 48 A pk</nt-edge>
  <nt-edge id="pp-e7" from="pp-bus" to="pp-estop">interrupts</nt-edge>
</nt-diagram>`;
