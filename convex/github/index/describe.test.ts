import { describe, expect, test } from "vitest";
import { describeFile, describeStyling } from "./describe";
import { parseFile } from "./parse";

describe("describeFile", () => {
  test("the leading comment's first sentence is the brief", () => {
    const f = parseFile(
      "app/lib/sync/YConvexProvider.ts",
      "/** Syncs a Y.Doc through Convex. Batches updates. */\nexport class YConvexProvider {}\n",
    );
    const d = describeFile(f, "Sync");
    expect(d.brief).toBe("Syncs a Y.Doc through Convex.");
    expect(d.summary).toContain("app/lib/sync/YConvexProvider.ts");
    expect(d.summary).toContain("Exports: YConvexProvider");
    expect(d.summary).toContain("TypeScript, 2 lines, in Sync.");
    expect(d.terms).toContain("y convex provider");
    expect(d.terms).toContain("sync");
  });

  test("without a comment, the exports; without either, the language and concern", () => {
    const three = parseFile("a.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;");
    expect(describeFile(three, "X").brief).toBe("Exports a, b and c");
    const five = parseFile("a.ts", "export const a = 1, b = 2;\nexport { a as d, b as e };\nexport function f() {}\nexport const g = 1;");
    expect(describeFile(five, "X").brief).toMatch(/^Exports \w, \w, \w and \d more$/);
    const one = parseFile("a.ts", "export const only = 1;");
    expect(describeFile(one, "X").brief).toBe("Exports only");
    const bare = parseFile("styles/a.css", "a { color: red; }");
    expect(describeFile(bare, "Styling and components").brief).toBe("CSS file in Styling and components");
    expect(describeFile(bare, "").brief).toBe("CSS file");
  });

  test("stays within its limits", () => {
    const names = Array.from({ length: 40 }, (_, i) => `export const someRatherLongExportName${i} = ${i};`);
    const f = parseFile(
      `${"deeply/nested/".repeat(20)}file.ts`,
      `/** ${"A very long sentence without an end ".repeat(20)} */\n${names.join("\n")}`,
    );
    const d = describeFile(f, "Concern");
    expect(d.brief.length).toBeLessThanOrEqual(140);
    expect(d.summary.length).toBeLessThanOrEqual(900);
    expect(d.terms.length).toBeLessThanOrEqual(6000);
  });
});

describe("describeStyling", () => {
  const texts = new Map<string, string>([
    [
      "app/globals.css",
      [
        '@import "tailwindcss";',
        "@theme {",
        "  --color-ink: oklch(0.21 0.006 285.885);",
        "  --font-sans: \"Inter\", ui-sans-serif, system-ui;",
        "}",
        ":root {",
        "  --foreground: #1f1f1f;",
        "  --background: rgb(255 255 255);",
        "  --radius-md: 6px;",
        "  --space-2: 0.5rem;",
        "  --shadow-card: 0 1px 2px rgb(0 0 0 / 0.08);",
        "  --duration-fast: 120ms;",
        "  --z-menu: 40;",
        "}",
        "code { font-family: \"JetBrains Mono\", monospace; }",
      ].join("\n"),
    ],
    [
      "tailwind.config.ts",
      [
        "export default {",
        "  // brand setup: see docs",
        "  theme: {",
        "    screens: { sm: '640px' },",
        "    extend: {",
        "      colors: { brand: '#ff0000' },",
        "      borderRadius: { xl: '12px' },",
        "      fontFamily: { display: ['Fraunces', 'serif'] },",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    ],
    ["app/components/ui/Button.tsx", "export function Button() {}\nexport const buttonVariants = {};\nexport const API = 1;"],
    ["app/components/ui/Card.tsx", "export function Card() {}\nexport function CardHeader() {}"],
    ["src/components/Badge.vue", "<template><span /></template>"],
  ]);
  const files = [...texts].map(([path, text]) => parseFile(path, text));
  const summary = describeStyling(files, texts);

  test("the product's own palette leads; vendors' and aliases trail", () => {
    const sheet = (path: string, css: string) => [path, css] as const;
    const texts = new Map([
      sheet("src/editor/block.css", ":root { --bn-colors-menu: #fff; --nt-select: #0d99ff; }"),
      sheet("app/globals.css", ":root { --background: #fff; --foreground: #222; --hover: var(--foreground); }"),
    ]);
    const files = [...texts].map(([p, t]) => parseFile(p, t));
    const summary = describeStyling(files, texts);
    const at = (name: string) => {
      expect(summary).toContain(name);
      return summary.indexOf(name);
    };
    expect(at("--background")).toBeLessThan(at("--nt-select"));
    expect(at("--foreground")).toBeLessThan(at("--hover"));
    expect(at("--nt-select")).toBeLessThan(at("--bn-colors-menu"));
  });

  test("a codebase that never rounds says it is square, and flat", () => {
    const texts = new Map([
      ["app/globals.css", ":root { --primary: #000; }"],
      ["app/components/links/links.module.css", ".primaryButton { background: #000; color: #fff; padding: 8px 16px; }"],
    ]);
    const summary = describeStyling([...texts].map(([p, t]) => parseFile(p, t)), texts);
    expect(summary).toMatch(/^Corners: square — no border-radius/m);
    expect(summary).toMatch(/^Shadows: none anywhere/m);
  });

  test("control rules come verbatim, buttons first, motion left out", () => {
    const texts = new Map([
      ["src/card.module.css", ".card { border: 1px solid #ddd; padding: 16px; }"],
      [
        "src/button.module.css",
        ".secondaryButton { border: 1px solid #000; background: transparent; transition: all 0.2s; }" +
          ".primaryButton { background: #000; color: #fff; border-radius: 0; }",
      ],
      ["src/App.tsx", '<button className="rounded-none bg-black px-4 text-white">Go</button>'],
    ]);
    const summary = describeStyling([...texts].map(([p, t]) => parseFile(p, t)), texts);
    const line = summary.split("\n").find((l) => l.startsWith("Component styles:"))!;
    expect(line).toContain(".primaryButton { background: #000; color: #fff; border-radius: 0 }");
    expect(line).toContain(".secondaryButton { border: 1px solid #000; background: transparent }");
    expect(line.indexOf(".secondaryButton")).toBeLessThan(line.indexOf(".card"));
    expect(line).toContain("<button> rounded-none bg-black px-4 text-white");
    expect(line).not.toContain("transition");
    // Radius set to zero, explicitly, is still square.
    expect(summary).toMatch(/^Corners: square/m);
  });

  test("tokens verbatim, grouped", () => {
    expect(summary).toContain("--color-ink: oklch(0.21 0.006 285.885)");
    expect(summary).toContain("--foreground: #1f1f1f");
    expect(summary).toContain("--background: rgb(255 255 255)");
    expect(summary).toMatch(/^Colour tokens: /m);
    expect(summary).toMatch(/^Radius tokens: --radius-md: 6px$/m);
    expect(summary).toMatch(/^Spacing tokens: --space-2: 0.5rem$/m);
    expect(summary).toMatch(/^Shadow tokens: --shadow-card: 0 1px 2px rgb\(0 0 0 \/ 0.08\)$/m);
    expect(summary).toMatch(/^Motion tokens: --duration-fast: 120ms$/m);
    expect(summary).toMatch(/^Other tokens: --z-menu: 40$/m);
  });

  test("fonts, the tailwind theme and components", () => {
    expect(summary).toContain('"Inter", ui-sans-serif, system-ui');
    expect(summary).toContain('"JetBrains Mono", monospace');
    expect(summary).toContain("display: 'Fraunces', 'serif'");
    expect(summary).toContain("v4 @theme in app/globals.css");
    expect(summary).toContain("theme in tailwind.config.ts sets screens");
    expect(summary).toContain("theme in tailwind.config.ts extends colors, borderRadius, fontFamily");
    expect(summary).toMatch(/^Components: Button, Card, CardHeader, Badge$/m);
    expect(summary).not.toContain("buttonVariants");
    expect(summary).not.toContain("API");
  });

  test("colours lead, and the whole stays within 1500 chars", () => {
    expect(summary.split("\n")[0]).toMatch(/^Colour tokens: /);
    const many = Array.from({ length: 200 }, (_, i) => `  --color-shade-${i}: oklch(0.${i} 0.1 200);`);
    const big = new Map([["a.css", `:root {\n${many.join("\n")}\n}`], ...texts]);
    const bigSummary = describeStyling([...big].map(([p, t]) => parseFile(p, t)), big);
    expect(bigSummary.length).toBeLessThanOrEqual(1500);
    expect(bigSummary).toMatch(/\(\+\d+ more\)/);
    expect(bigSummary).toContain("Components: Button");
    expect(bigSummary).toContain("--color-shade-0: oklch(0.0 0.1 200)");
  });

  test("deterministic and empty when there is nothing to say", () => {
    expect(describeStyling([...files].reverse(), texts)).toBe(summary);
    expect(describeStyling([], new Map())).toBe("");
  });
});
