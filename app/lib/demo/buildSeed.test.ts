import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { seedUpdate } from "@/app/lib/onboarding/seed";
import { KESTREL_PAGES, KESTREL_PROJECT } from "./kestrel";

/**
 * Builds the seed, and is the only place that can.
 *
 * `seedUpdate` stands up a headless BlockNote editor to get the Yjs update a
 * document is born from, so the schema — and its React block types — has to be
 * loadable. That is an app module graph, not a Convex one, which is why the
 * payload is built here and handed to the mutation rather than assembled inside
 * it.
 *
 * As a test it asserts every page compiles. With `SEED_OUT` set it also writes
 * the argument file for `npx convex run`:
 *
 *   SEED_OUT=.ntcheck/kestrel.json SEED_OWNER=user_xxx \
 *     npx vitest run app/lib/demo/buildSeed.test.ts
 *   npx convex run --prod demoSeed:seedKestrel "$(cat .ntcheck/kestrel.json)"
 */

describe("the KR-1 seed", () => {
  it("compiles every page to a document", () => {
    for (const page of KESTREL_PAGES) {
      const update = seedUpdate(page.blocks);
      expect(update.byteLength, page.title).toBeGreaterThan(0);
    }
  });

  it("cites lines that actually exist in the seeded source", () => {
    // C-16's table points at watchdog.c:7, :8, :17 and :28, and T-20's
    // completion at :7. Those have to BE those lines, or the demo cites a file
    // that is on screen and disagrees with it.
    const page = KESTREL_PAGES.find((x) => x.title === "Firmware source")!;
    const code = page.blocks.find((b) => b.type === "codeBlock");
    const lines = String((code?.props as { code?: string })?.code ?? "").split("\n");
    expect(lines[6], "watchdog.c:7").toContain("#define HEARTBEAT_TIMEOUT_MS 300");
    expect(lines[7], "watchdog.c:8").toContain("#define WATCHDOG_PERIOD_MS    50");
    expect(lines[16], "watchdog.c:17").toContain(">= HEARTBEAT_TIMEOUT_MS");
    expect(lines[27], "watchdog.c:28").toContain("WATCHDOG_PERIOD_MS");
  });

  it("holds the numbers the staged answers depend on", () => {
    const all = JSON.stringify(KESTREL_PAGES);
    // Each of these is quoted back by a canned answer. If the seed stops
    // saying it, a staged call starts saying something untrue.
    for (const fact of [
      "300 ms", // REQ-015, which C-16 checks the firmware against
      "45 °C", // the derate T-07's completion picks up
      "REQ-014", // C-18's gradeability check
      "0.12 Ω", // the datasheet value C-18 corrects the BOM with
      "12-week", // the lead time C-13 and C-14 call the long pole
      "42 Hz", // the mast mode in the meeting notes
      "HEARTBEAT_TIMEOUT_MS 300", // what C-16 checks REQ-015 against
      "WATCHDOG_PERIOD_MS    50", // the other 50 ms that makes REQ-015 fail
    ]) {
      expect(all, `seed no longer mentions ${fact}`).toContain(fact);
    }
  });

  it("leaves the four uncovered requirements uncovered", () => {
    const tests = JSON.stringify(KESTREL_PAGES.find((p) => p.title === "Test & Validation"));
    // C-05's whole answer is that these have no test. If someone adds one to
    // the seed, that answer becomes a lie.
    for (const orphan of ["REQ-008", "REQ-012", "REQ-018", "REQ-020"]) {
      expect(tests, `${orphan} is now covered by a test`).not.toContain(orphan);
    }
  });

  it("does not ship the discipline pages C-06 creates", () => {
    // They live as sections inside the brief; C-06 is what splits them out.
    // A seeded page of the same name would make C-06 produce a duplicate.
    const titles = KESTREL_PAGES.map((p) => p.title);
    for (const made of ["Mechanical", "Power & Electrical", "Firmware", "Software & Fleet"]) {
      expect(titles, `${made} would be duplicated by C-06`).not.toContain(made);
    }
    // But Test & Validation must exist before C-05 runs, which is long before C-06.
    expect(titles).toContain("Test & Validation");
  });

  it("satisfies every page the scripts go looking for", () => {
    // The two halves are written apart and fail apart: rename a seeded page and
    // C-16 quietly bails to prose on stage. Asserted here instead.
    const titles = KESTREL_PAGES.map((page) => page.title);
    const wanted: [string, RegExp][] = [
      ["C-16 and C-05 read the requirements", /requirement|traceab/i],
      ["C-05 reads the test plan", /test|validat|v&v/i],
      ["C-16 and C-11 read the firmware source", /firmware source|watchdog/i],
    ];
    for (const [who, pattern] of wanted) {
      expect(titles.some((t) => pattern.test(t)), who).toBe(true);
    }
  });

  it("writes the argument file when asked", () => {
    const out = process.env.SEED_OUT;
    const ownerId = process.env.SEED_OWNER;
    if (!out) return;
    if (!ownerId) throw new Error("SEED_OWNER must be the target Clerk user id");

    const payload = {
      ownerId,
      title: KESTREL_PROJECT.title,
      description: KESTREL_PROJECT.description,
      context: KESTREL_PROJECT.context,
      pages: KESTREL_PAGES.map((page) => ({
        title: page.title,
        // Convex's JSON encoding for v.bytes().
        update: { $bytes: Buffer.from(seedUpdate(page.blocks)).toString("base64") },
      })),
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(payload));
    console.log(`seed for ${ownerId} → ${out} (${KESTREL_PAGES.length} pages)`);
  });
});
