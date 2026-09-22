import { describe, expect, test } from "vitest";
import { cluster, type Clustering } from "./cluster";
import { coChange } from "./cochange";
import { parseFile } from "./parse";
import { resolveReferences, tsPaths } from "./resolve";

function build(files: Record<string, string>, commits: string[][] = []): Clustering {
  const list = Object.entries(files).map(([path, text]) => ({ path, text }));
  const parsed = list.map((f) => parseFile(f.path, f.text));
  const references = resolveReferences(parsed, tsPaths(list));
  return cluster({
    files: parsed,
    references,
    cochange: coChange(commits, new Set(Object.keys(files))),
  });
}

function concerns(c: Clustering) {
  return c.areas.flatMap((a) => a.concerns);
}

function concernOf(c: Clustering, path: string) {
  return concerns(c).find((x) => x.files.includes(path))!;
}

function areaOf(c: Clustering, path: string) {
  return c.areas.find((a) => a.concerns.some((x) => x.files.includes(path)))!;
}

const imports = (...specs: string[]) => specs.map((s) => `import "${s}";`).join("\n");

/** Two features, each a front end and a Convex back end, over a shared lib and a UI kit. */
function realistic(): { files: Record<string, string>; commits: string[][] } {
  const files: Record<string, string> = {
    "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }',
    "package.json": "{}",
    "README.md": "# Acme\n\nA product.\n",
    "tailwind.config.ts": "export default { theme: { extend: { colors: {} } } };",
    "styles/globals.css": '@import "./tokens.css";\n:root { --foreground: #111; }',
    "styles/tokens.css": ":root { --radius: 6px; }",
    "styles/typography.css": "body { font-family: Inter, sans-serif; }",
    "convex/schema.ts": "export default defineSchema({});",
    "app/layout.tsx": imports("@/styles/globals.css", "@/app/components/ui/Button", "@/app/components/Avatar"),
    "app/page.tsx": imports("@/app/components/ui/Button", "@/app/components/ui/Menu", "@/lib/format", "@/app/components/Avatar"),
    "app/components/Avatar.tsx": "export function Avatar() {}",
  };
  for (const name of ["Button", "Dialog", "Input", "Menu"]) {
    files[`app/components/ui/${name}.tsx`] = `export function ${name}() {}\n${imports("@/lib/strings")}`;
  }
  for (const name of ["format", "dates", "ids", "strings", "errors", "hash"]) {
    files[`lib/${name}.ts`] = `export const ${name} = 1;`;
  }
  for (let i = 0; i < 6; i++) files[`docs/guide-${i}.md`] = `# Guide ${i}\n\nHow to ${i}.\n`;
  for (const name of ["seed", "migrate", "backup"]) files[`scripts/${name}.ts`] = `export const ${name} = 1;`;

  const feature = (slug: string, front: string[], back: string[], extra: string[] = []) => {
    const frontPaths = front.map((n) => `app/components/${slug}/${n}.tsx`);
    const backPaths = back.map((n) => `convex/${slug}/${n}.ts`);
    front.forEach((name, i) => {
      const next = front[(i + 1) % front.length];
      const second = front[(i + 2) % front.length];
      const fn = back[i % back.length];
      files[frontPaths[i]] = [
        `export function ${name}() {}`,
        imports(`./${next}`, `./${second}`, "@/app/components/ui/Button", "@/app/components/ui/Dialog", "@/lib/format", "@/lib/ids"),
        `const q = useQuery(api.${slug}.${fn}.get);`,
        `const m = useMutation(api.${slug}.${back[(i + 1) % back.length]}.set);`,
        ...extra.map((e) => `import "${e}";`),
      ].join("\n");
    });
    back.forEach((name, i) => {
      files[backPaths[i]] = [
        `export const get = query({});`,
        imports("../schema", `./${back[(i + 1) % back.length]}`),
        `const other = internal.${slug}.${back[(i + 2) % back.length]}.get;`,
      ].join("\n");
    });
    return [...frontPaths, ...backPaths];
  };

  const billing = feature(
    "billing",
    ["BillingPage", "PlanPicker", "Invoice", "CheckoutButton", "UsageMeter", "BillingHeader"],
    ["plans", "checkout", "webhooks", "usage"],
  );
  for (const name of ["blocks", "convert", "rich"]) {
    files[`lib/notion/${name}.ts`] = `export const ${name} = 1;\n${imports("./blocks", "./convert", "./rich")}`;
  }
  const notion = feature(
    "notion",
    ["ImportDialog", "PagePicker", "Progress", "Mapping", "NotionHeader", "Preview"],
    ["importer", "pages", "mapping", "oauth"],
    ["@/lib/notion/convert"],
  );
  files["app/billing/page.tsx"] = imports("@/app/components/billing/BillingPage", "@/app/components/Avatar");
  files["app/import/page.tsx"] = imports("@/app/components/notion/ImportDialog");

  const commits: string[][] = [];
  for (let i = 0; i < 6; i++) {
    commits.push([billing[i], billing[(i + 1) % billing.length], billing[6 + (i % 4)]]);
    commits.push([notion[i], notion[(i + 1) % notion.length], notion[6 + (i % 4)], "lib/notion/convert.ts"]);
  }
  return { files, commits };
}

describe("cluster: a realistic repo", () => {
  const { files, commits } = realistic();
  const result = build(files, commits);

  test("is around sixty files", () => {
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(55);
  });

  test("the two features land in different concerns", () => {
    const billing = concernOf(result, "app/components/billing/BillingPage.tsx");
    const notion = concernOf(result, "app/components/notion/ImportDialog.tsx");
    expect(billing.id).not.toBe(notion.id);
    expect(billing.files).toContain("app/components/billing/PlanPicker.tsx");
    expect(notion.files).toContain("app/components/notion/PagePicker.tsx");
    expect(billing.files.some((f) => f.includes("notion"))).toBe(false);
    expect(notion.files.some((f) => f.includes("billing"))).toBe(false);
  });

  test("a feature's front and back end share an area", () => {
    expect(areaOf(result, "convex/billing/plans.ts").id).toBe(
      areaOf(result, "app/components/billing/BillingPage.tsx").id,
    );
    expect(areaOf(result, "convex/notion/importer.ts").id).toBe(
      areaOf(result, "app/components/notion/ImportDialog.tsx").id,
    );
  });

  test("every file appears in exactly one concern", () => {
    const all = concerns(result).flatMap((c) => c.files);
    expect([...all].sort()).toEqual(Object.keys(files).sort());
    expect(new Set(all).size).toBe(all.length);
  });

  test("styling holds the sheets, the tailwind config and the shared UI kit", () => {
    const styling = concerns(result).filter((c) => c.styling);
    expect(styling).toHaveLength(1);
    expect(styling[0]).toMatchObject({ id: "concern:styling-and-components", name: "Styling and components" });
    expect(areaOf(result, "styles/globals.css")).toMatchObject({ id: "area:styling", name: "Styling" });
    expect(styling[0].files).toEqual([
      "app/components/Avatar.tsx",
      "app/components/ui/Button.tsx",
      "app/components/ui/Dialog.tsx",
      "styles/globals.css",
      "styles/tokens.css",
      "styles/typography.css",
      "tailwind.config.ts",
    ]);
  });

  test("names are readable and unique, ids stable and unique", () => {
    const names = concerns(result).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][^/]*$/);
    expect(concernOf(result, "app/components/billing/BillingPage.tsx").name).toMatch(/Billing/);
    const ids = [...result.areas.map((a) => a.id), ...concerns(result).map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const area of result.areas) {
      expect(area.id).toMatch(/^area:[a-z0-9-]+$/);
      for (const c of area.concerns) {
        if (!c.styling) expect(c.id.startsWith(`concern:${area.id.slice(5)}/`)).toBe(true);
      }
    }
  });

  test("areas, concerns and files are sorted", () => {
    const areaNames = result.areas.map((a) => a.name);
    expect(areaNames).toEqual([...areaNames].sort());
    for (const area of result.areas) {
      const names = area.concerns.map((c) => c.name);
      expect(names).toEqual([...names].sort());
      for (const c of area.concerns) expect(c.files).toEqual([...c.files].sort());
    }
  });

  test("rollups join distinct concerns, heaviest first", () => {
    const ids = new Set(concerns(result).map((c) => c.id));
    expect(result.rollups.length).toBeGreaterThan(0);
    for (const r of result.rollups) {
      expect(ids.has(r.from) && ids.has(r.to)).toBe(true);
      expect(r.from < r.to).toBe(true);
      expect(r.weight).toBeGreaterThan(0);
    }
    const weights = result.rollups.map((r) => r.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  test("deterministic: the same input, in any order, clusters identically", () => {
    expect(build(files, commits)).toEqual(result);
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(build(reversed, [...commits].reverse())).toEqual(result);
  });
});

describe("cluster: invariants", () => {
  test("a repo with no GUI has no styling concern", () => {
    const result = build({
      "pkg/a.py": "from . import b",
      "pkg/b.py": "",
      "pkg/c.py": "from . import a",
      "README.md": "# x",
    });
    expect(concerns(result).some((c) => c.styling)).toBe(false);
    expect(result.areas.some((a) => a.id === "area:styling")).toBe(false);
  });

  test("any GUI file brings exactly one styling concern", () => {
    for (const gui of ["index.html", "src/App.tsx", "src/app.css", "src/Widget.svelte"]) {
      const result = build({ "server/main.py": "", [gui]: "" });
      const styling = concerns(result).filter((c) => c.styling);
      expect(styling, gui).toHaveLength(1);
      expect(styling[0].id).toBe("concern:styling-and-components");
    }
  });

  test("a backend's token and theme files stay out of Styling; the UI's go in", () => {
    const result = build({
      "src/App.tsx": imports("./theme"),
      "src/theme.ts": "export const ink = '#222';",
      "src/tokens.json": "{}",
      "convex/github/tokens.ts": "export const seal = () => {};",
      "server/theme.ts": "export const theme = 'dark';",
    });
    const styling = concerns(result).find((c) => c.styling)!;
    expect(styling.files).toEqual(expect.arrayContaining(["src/theme.ts", "src/tokens.json"]));
    expect(styling.files).not.toContain("convex/github/tokens.ts");
    expect(styling.files).not.toContain("server/theme.ts");
  });

  test("an empty repo has no areas", () => {
    expect(cluster({ files: [], references: [], cochange: [] })).toEqual({ areas: [], rollups: [] });
  });

  test("oversized concerns split by directory, then into runs", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`svc/core/alpha/m${String(i).padStart(2, "0")}.py`] = "";
    for (let i = 0; i < 40; i++) files[`svc/core/beta/m${String(i).padStart(2, "0")}.py`] = "";
    for (let i = 0; i < 130; i++) files[`data/rows/r${String(i).padStart(3, "0")}.py`] = "";
    const result = build(files);
    for (const c of concerns(result)) expect(c.files.length).toBeLessThanOrEqual(60);
    const alpha = concernOf(result, "svc/core/alpha/m00.py");
    expect(alpha.files.every((f) => f.startsWith("svc/core/alpha/"))).toBe(true);
    expect(concerns(result).filter((c) => c.files[0].startsWith("data/rows/"))).toHaveLength(3);
  });

  test("an oversized connected cluster splits too", () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (const dir of ["a", "b", "c"]) {
      for (let i = 0; i < 30; i++) paths.push(`big/${dir}/f${String(i).padStart(2, "0")}.ts`);
    }
    // One ring of imports through all ninety files, plus co-change everywhere.
    paths.forEach((p, i) => {
      const next = paths[(i + 1) % paths.length];
      files[p] = `import "@/${next.replace(/\.ts$/, "")}";`;
    });
    files["tsconfig.json"] = '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }';
    const commits = Array.from({ length: 30 }, (_, i) => [paths[i], paths[i + 30], paths[i + 60]]);
    const result = build(files, [...commits, ...commits]);
    for (const c of concerns(result)) expect(c.files.length).toBeLessThanOrEqual(60);
    expect(concerns(result).flatMap((c) => c.files).length).toBe(91);
  });

  test("names come from directories, generic segments stripped, duplicates disambiguated", () => {
    const files: Record<string, string> = {};
    for (const f of ["Stage", "Grips", "Frame"]) files[`app/components/editor/canvas/${f}.tsx`] = "";
    for (const f of ["a", "b", "c"]) {
      files[`one/feature/utils/${f}.py`] = "";
      files[`two/feature/utils/${f}.py`] = "";
    }
    const result = build(files);
    expect(concernOf(result, "app/components/editor/canvas/Stage.tsx").name).toBe("Editor canvas");
    expect(concernOf(result, "one/feature/utils/a.py").name).toBe("One feature utils");
    expect(concernOf(result, "two/feature/utils/a.py").name).toBe("Two feature utils");
  });

  test("tiny concerns fold into their nearest neighbour", () => {
    const files: Record<string, string> = {
      "tools/x/a.py": "",
      "tools/x/b.py": "",
      "tools/x/c.py": "",
      "tools/y/lonely.py": "",
    };
    const result = build(files);
    expect(concerns(result)).toHaveLength(1);
  });
});
