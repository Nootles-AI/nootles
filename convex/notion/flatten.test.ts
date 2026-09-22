import { describe, expect, test } from "vitest";
import { flattenBlocks, type NotionBlock } from "./flatten";

/** Notion's own block JSON, as `pages.children` hands it over. */
const rt = (text: string) => [
  {
    type: "text",
    text: { content: text, link: null },
    annotations: { bold: false, italic: false, code: false, color: "default" },
    plain_text: text,
    href: null,
  },
];

let id = 0;
function block(type: string, payload: Record<string, unknown>, children?: NotionBlock[]): NotionBlock {
  return {
    object: "block",
    id: `block-${++id}`,
    type,
    has_children: Boolean(children?.length),
    [type]: payload,
    ...(children ? { children } : {}),
  };
}
const text = (type: string, value: string, children?: NotionBlock[]) =>
  block(type, { rich_text: rt(value), color: "default" }, children);
const paragraph = (value: string, children?: NotionBlock[]) => text("paragraph", value, children);
const bullet = (value: string, children?: NotionBlock[]) =>
  text("bulleted_list_item", value, children);
const numbered = (value: string, children?: NotionBlock[]) =>
  text("numbered_list_item", value, children);

describe("flattenBlocks", () => {
  test("headings are lines of their own, and the outline", () => {
    const out = flattenBlocks([
      text("heading_1", "Rover telemetry"),
      paragraph("What the rover reports, and how often."),
      text("heading_2", "Cadence"),
      paragraph("Every 250ms over the radio."),
      text("heading_3", "Fallback"),
    ]);
    expect(out.text).toBe(
      "Rover telemetry\n\nWhat the rover reports, and how often.\n\nCadence\n\nEvery 250ms over the radio.\n\nFallback",
    );
    expect(out.headings).toEqual(["Rover telemetry", "Cadence", "Fallback"]);
  });

  test("rich text runs join into one line", () => {
    const runs = [...rt("Battery "), ...rt("must not"), ...rt(" drop below 20%.")];
    expect(flattenBlocks([block("paragraph", { rich_text: runs })]).text).toBe(
      "Battery must not drop below 20%.",
    );
  });

  test("a run of list items stays together, numbered in order", () => {
    const out = flattenBlocks([
      paragraph("Steps:"),
      numbered("Power on"),
      numbered("Pair the controller"),
      numbered("Calibrate"),
      paragraph("Then:"),
      bullet("Drive"),
      bullet("Return"),
    ]);
    expect(out.text).toBe(
      "Steps:\n\n1. Power on\n2. Pair the controller\n3. Calibrate\n\nThen:\n\n- Drive\n- Return",
    );
  });

  test("to-dos show whether they are done", () => {
    const out = flattenBlocks([
      block("to_do", { rich_text: rt("Order motors"), checked: true }),
      block("to_do", { rich_text: rt("Wire the harness"), checked: false }),
    ]);
    expect(out.text).toBe("[x] Order motors\n[ ] Wire the harness");
  });

  test("list items nest two spaces a level", () => {
    const out = flattenBlocks([
      bullet("Drivetrain", [
        bullet("Motors", [numbered("Left"), numbered("Right")]),
        paragraph("Geared 30:1."),
      ]),
      bullet("Sensors"),
    ]);
    expect(out.text).toBe(
      "- Drivetrain\n  - Motors\n    1. Left\n    2. Right\n  Geared 30:1.\n- Sensors",
    );
  });

  test("quotes and callouts", () => {
    const out = flattenBlocks([
      text("quote", "Ship the boring version.\nThen make it good."),
      block("callout", {
        rich_text: rt("Field test on Friday."),
        icon: { type: "emoji", emoji: "⚠️" },
      }),
      block("callout", { rich_text: rt("No icon here."), icon: null }),
    ]);
    expect(out.text).toBe(
      "> Ship the boring version.\n> Then make it good.\n\n⚠️ Field test on Friday.\n\nNo icon here.",
    );
  });

  test("a toggle reads as its text, then what it hides", () => {
    const out = flattenBlocks([
      text("toggle", "Why 250ms?", [paragraph("The radio's duty cycle."), bullet("Measured")]),
      paragraph("After."),
    ]);
    expect(out.text).toBe("Why 250ms?\nThe radio's duty cycle.\n- Measured\n\nAfter.");
  });

  test("a toggleable heading still counts as a heading", () => {
    const out = flattenBlocks([
      block("heading_2", { rich_text: rt("Open questions"), is_toggleable: true }, [
        paragraph("Which battery?"),
      ]),
    ]);
    expect(out.text).toBe("Open questions\nWhich battery?");
    expect(out.headings).toEqual(["Open questions"]);
  });

  test("code keeps its lines", () => {
    const out = flattenBlocks([
      paragraph("The loop:"),
      block("code", {
        rich_text: rt("while (true) {\n  tick();\n}"),
        language: "typescript",
        caption: [],
      }),
    ]);
    expect(out.text).toBe("The loop:\n\nwhile (true) {\n  tick();\n}");
  });

  test("a table is its rows, cells joined", () => {
    const row = (...cells: string[]) => block("table_row", { cells: cells.map(rt) });
    const out = flattenBlocks([
      block("table", { table_width: 3, has_column_header: true, has_row_header: false }, [
        row("Part", "Qty", "Cost"),
        row("Motor", "4", "$120"),
        row("Battery", "1", "$80"),
      ]),
    ]);
    expect(out.text).toBe("Part | Qty | Cost\nMotor | 4 | $120\nBattery | 1 | $80");
  });

  test("a child page is named, not inlined", () => {
    const out = flattenBlocks([
      block("child_page", { title: "Firmware notes" }),
      block("child_page", { title: "" }),
    ]);
    expect(out.text).toBe("(page: Firmware notes)\n\n(page: Untitled)");
  });

  test("media says its caption, or nothing", () => {
    const out = flattenBlocks([
      block("image", {
        type: "file",
        file: { url: "https://example.com/a.png" },
        caption: rt("The chassis, top down."),
      }),
      block("file", { type: "external", external: { url: "https://x" }, caption: [] }),
      block("pdf", { caption: rt("Datasheet") }),
      block("video", { caption: [] }),
      paragraph("End."),
    ]);
    expect(out.text).toBe("The chassis, top down.\n\nDatasheet\n\nEnd.");
  });

  test("equations are their expression; dividers are nothing", () => {
    const out = flattenBlocks([
      block("equation", { expression: "v = \\omega r" }),
      block("divider", {}),
      paragraph("Below the line."),
    ]);
    expect(out.text).toBe("v = \\omega r\n\nBelow the line.");
  });

  test("columns read as the page around them", () => {
    const out = flattenBlocks([
      block("column_list", {}, [
        block("column", {}, [paragraph("Left side.")]),
        block("column", {}, [paragraph("Right side.")]),
      ]),
    ]);
    expect(out.text).toBe("Left side.\n\nRight side.");
  });

  test("empty blocks leave no gaps", () => {
    const out = flattenBlocks([
      paragraph("One."),
      paragraph(""),
      paragraph(""),
      bullet(""),
      paragraph("Two.\n\n\n\nThree."),
    ]);
    expect(out.text).toBe("One.\n\nTwo.\n\nThree.");
  });

  test("nothing to read is empty", () => {
    expect(flattenBlocks([])).toEqual({ text: "", headings: [] });
    expect(flattenBlocks([block("divider", {})]).text).toBe("");
  });

  test("the same blocks give the same text", () => {
    const blocks = [text("heading_1", "A"), bullet("b", [bullet("c")]), paragraph("d")];
    expect(flattenBlocks(blocks)).toEqual(flattenBlocks(blocks));
  });
});
