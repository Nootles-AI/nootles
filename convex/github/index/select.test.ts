import { describe, expect, test } from "vitest";
import { keep, MAX_FILES, prioritise } from "./select";

describe("keep", () => {
  test("keeps source, styles, markup, config and docs", () => {
    for (const path of [
      "app/page.tsx", "convex/schema.ts", "lib/x.mjs", "server/main.py", "cmd/run.go",
      "src/lib.rs", "App.vue", "Widget.svelte", "app/globals.css", "styles/a.scss",
      "index.html", "README.md", "docs/intro.mdx", "package.json", "ci.yml",
      "Cargo.toml", "db/schema.sql", "schema.graphql", "prisma/schema.prisma", "run.sh",
      "lib/main.dart", "app/src/main/res/values/colors.xml",
      "App/Assets.xcassets/Brand.colorset/Contents.json",
    ]) {
      expect(keep(path, 1000), path).toBe(true);
    }
  });

  test("skips vendored, generated and build output", () => {
    for (const path of [
      "node_modules/react/index.js", "vendor/x.go", "dist/app.js", "build/a.js", "out/b.js",
      ".next/server.js", "coverage/lcov.html", "target/debug/x.rs", ".git/config.json",
      "pkg/__pycache__/a.py", "venv/lib/a.py", ".venv/a.py", "third_party/a.c",
      "convex/_generated/api.ts",
    ]) {
      expect(keep(path, 1000), path).toBe(false);
    }
  });

  test("skips lock files, minified files, maps, binaries and large files", () => {
    for (const path of [
      "package-lock.json", "yarn.lock", "web/pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
      "Gemfile.lock", "go.sum", "a.min.js", "b.min.css", "app.js.map", "logo.png",
      "font.woff2", "clip.mp4", "archive.zip", "doc.pdf", "mod.wasm", "Makefile", ".env",
    ]) {
      expect(keep(path, 1000), path).toBe(false);
    }
    expect(keep("App/Assets.xcassets/Logo.imageset/Contents.json", 1000)).toBe(false);
    expect(keep("App/Assets.xcassets/Contents.json", 1000)).toBe(false);
    expect(keep("ios/Pods/Lib/a.swift", 1000)).toBe(false);
    expect(keep("res/layout/huge.xml", 100_001)).toBe(false);
    expect(keep("big.ts", 300_000)).toBe(true);
    expect(keep("big.ts", 300_001)).toBe(false);
  });
});

describe("prioritise", () => {
  test("under the limit it only sorts", () => {
    expect(prioritise(["b.ts", "a.ts"])).toEqual(["a.ts", "b.ts"]);
  });

  test("over the limit it prefers shallow non-test source, deterministically", () => {
    const source = Array.from({ length: MAX_FILES - 2 }, (_, i) => `src/m${String(i).padStart(4, "0")}.ts`);
    const extra = [
      "src/deep/er/still/x.ts",
      "src/y.ts",
      "src/a.test.ts",
      "tests/b.ts",
      "docs/guide.md",
      "config.json",
    ];
    const input = [...extra, ...source].reverse();
    const chosen = prioritise(input);
    expect(chosen).toHaveLength(MAX_FILES);
    expect(chosen).toContain("src/y.ts");
    expect(chosen).toContain("src/deep/er/still/x.ts");
    expect(chosen).not.toContain("src/a.test.ts");
    expect(chosen).not.toContain("docs/guide.md");
    expect(chosen).not.toContain("config.json");
    expect(chosen).toEqual([...chosen].sort());
    expect(prioritise([...input].reverse())).toEqual(chosen);
  });
});
