import { defaultBlockSpecs, type Extension } from "@blocknote/core";
import { describe, expect, test } from "vitest";
import { countWithParens, PAREN_NUMBER } from "./listSafe";

function rulesOf(spec: { extensions?: unknown[] }) {
  return (spec.extensions ?? []).flatMap((extension) => {
    const made = (
      typeof extension === "function" ? extension({ editor: {} }) : extension
    ) as Extension;
    return made.inputRules ?? [];
  });
}

describe("countWithParens", () => {
  const stock = rulesOf(defaultBlockSpecs.numberedListItem);
  const counted = rulesOf(countWithParens(defaultBlockSpecs.numberedListItem));

  test("keeps `1. ` and adds `1) ` beside it", () => {
    expect(counted).toHaveLength(stock.length + 1);
    expect(counted.slice(0, stock.length)).toEqual(stock);
    expect(counted.at(-1)?.find).toBe(PAREN_NUMBER);
  });

  test("`1) ` shares `1. `'s replacement, start number and all", () => {
    const paren = counted.at(-1)!;
    const dot = stock.find((rule) => rule.find.test("1. "))!;
    expect(paren.replace).toBe(dot.replace);
    expect("5) ".match(PAREN_NUMBER)?.[1]).toBe("5");
    expect(PAREN_NUMBER.test("1)\n")).toBe(true);
    expect(PAREN_NUMBER.test("a) ")).toBe(false);
  });

  test("a spec without the rule is returned as it was", () => {
    expect(rulesOf(countWithParens(defaultBlockSpecs.bulletListItem))).toEqual(
      rulesOf(defaultBlockSpecs.bulletListItem),
    );
  });
});
