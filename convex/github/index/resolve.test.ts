import { describe, expect, test } from "vitest";
import { parseFile } from "./parse";
import { resolveReferences, tsPaths } from "./resolve";

function repo(files: Record<string, string>) {
  const list = Object.entries(files).map(([path, text]) => ({ path, text }));
  return {
    parsed: list.map((f) => parseFile(f.path, f.text)),
    config: tsPaths(list),
  };
}

describe("tsPaths", () => {
  test("reads JSON with comments and trailing commas", () => {
    const config = tsPaths([
      {
        path: "tsconfig.json",
        text: `{
          // the app
          "compilerOptions": {
            /* strict */ "strict": true,
            "paths": { "@/*": ["./*"], "~lib": ["./lib/index.ts",], },
          },
        }`,
      },
    ]);
    expect(config).toEqual({ baseUrl: ".", paths: { "@/*": ["./*"], "~lib": ["./lib/index.ts"] } });
  });

  test("follows a local extends, falls back to jsconfig, and is null without either", () => {
    expect(
      tsPaths([
        { path: "tsconfig.json", text: '{ "extends": "./tsconfig.base.json" }' },
        { path: "tsconfig.base.json", text: '{ "compilerOptions": { "baseUrl": "src", "paths": { "#/*": ["x/*"] } } }' },
      ]),
    ).toEqual({ baseUrl: "src", paths: { "#/*": ["x/*"] } });
    expect(tsPaths([{ path: "jsconfig.json", text: '{ "compilerOptions": { "baseUrl": "." } }' }])).toEqual({
      baseUrl: ".",
      paths: {},
    });
    expect(tsPaths([{ path: "web/tsconfig.json", text: "{}" }])).toBeNull();
  });

  test("an unreadable config still yields defaults", () => {
    expect(tsPaths([{ path: "tsconfig.json", text: "{ nope" }])).toEqual({ baseUrl: ".", paths: {} });
  });
});

describe("resolveReferences", () => {
  test("relative, alias, index and extension probing; bare packages go nowhere", () => {
    // A bare CSS import is still relative to its sheet, so `base` finds the partial.
    const { parsed, config } = repo({
      "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }',
      "app/page.tsx": [
        'import React from "react";',
        'import { Button } from "@/app/components/ui";',
        'import { util } from "../lib/util";',
        'import { esm } from "./esm.js";',
        'import "./page.css";',
        'import { values } from "convex/values";',
        'import { self } from "./page";',
      ].join("\n"),
      "app/esm.ts": "export const esm = 1;",
      "app/page.css": '@import "./tokens.css";\n@import "base";',
      "app/tokens.css": ":root { --a: 1px; }",
      "app/_base.scss": "",
      "app/components/ui/index.ts": 'export * from "./Button";',
      "app/components/ui/Button.tsx": "export function Button() {}",
      "lib/util.ts": "export const util = 1;",
      "convex/values.ts": "",
    });
    expect(resolveReferences(parsed, config)).toEqual([
      { from: "app/components/ui/index.ts", to: "app/components/ui/Button.tsx", type: "imports" },
      { from: "app/page.css", to: "app/_base.scss", type: "imports" },
      { from: "app/page.css", to: "app/tokens.css", type: "imports" },
      { from: "app/page.tsx", to: "app/components/ui/index.ts", type: "imports" },
      { from: "app/page.tsx", to: "app/esm.ts", type: "imports" },
      { from: "app/page.tsx", to: "app/page.css", type: "imports" },
      { from: "app/page.tsx", to: "lib/util.ts", type: "imports" },
    ]);
  });

  test("scss partials resolve", () => {
    const { parsed, config } = repo({
      "styles/main.scss": '@use "tokens";',
      "styles/_tokens.scss": "$a: 1;",
    });
    expect(resolveReferences(parsed, config)).toEqual([
      { from: "styles/main.scss", to: "styles/_tokens.scss", type: "imports" },
    ]);
  });

  test("an explicit baseUrl resolves bare specifiers into the repo", () => {
    const { parsed, config } = repo({
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": "src" } }',
      "src/app.ts": 'import { x } from "components/x";\nimport "react";',
      "src/components/x.ts": "export const x = 1;",
    });
    expect(resolveReferences(parsed, config)).toEqual([
      { from: "src/app.ts", to: "src/components/x.ts", type: "imports" },
    ]);
  });

  test("the Convex resolver joins a front end to its back end", () => {
    const { parsed, config } = repo({
      "app/Notion.tsx": [
        "const pages = useQuery(api.notion.pages.list);",
        "const go = useAction(api.notion.importer.run);",
        "const missing = useQuery(api.nowhere.fn);",
      ].join("\n"),
      "convex/notion/pages.ts": "export const list = query({});\nconst x = internal.notion.pages.list;",
      "convex/notion/importer/index.ts": "export const run = action({});",
    });
    expect(resolveReferences(parsed, config)).toEqual([
      { from: "app/Notion.tsx", to: "convex/notion/importer/index.ts", type: "convex" },
      { from: "app/Notion.tsx", to: "convex/notion/pages.ts", type: "convex" },
    ]);
  });

  test("the nearest convex/ directory wins in a monorepo", () => {
    const { parsed, config } = repo({
      "apps/web/Page.tsx": "useQuery(api.items.list)",
      "apps/web/convex/items.ts": "",
      "convex/items.ts": "",
    });
    expect(resolveReferences(parsed, config)).toEqual([
      { from: "apps/web/Page.tsx", to: "apps/web/convex/items.ts", type: "convex" },
    ]);
  });

  test("python relative and absolute imports", () => {
    const { parsed, config } = repo({
      "pkg/__init__.py": "",
      "pkg/api/views.py": [
        "from . import serializers",
        "from ..models import User",
        "from pkg.db import session",
        "import pkg",
        "import requests",
      ].join("\n"),
      "pkg/api/serializers.py": "",
      "pkg/models.py": "",
      "pkg/db/__init__.py": "",
    });
    expect(resolveReferences(parsed, config)).toEqual([
      { from: "pkg/api/views.py", to: "pkg/__init__.py", type: "imports" },
      { from: "pkg/api/views.py", to: "pkg/api/serializers.py", type: "imports" },
      { from: "pkg/api/views.py", to: "pkg/db/__init__.py", type: "imports" },
      { from: "pkg/api/views.py", to: "pkg/models.py", type: "imports" },
    ]);
  });

  test("go imports reach every non-test file of the package directory", () => {
    const { parsed, config } = repo({
      "cmd/main.go": 'package main\nimport (\n\t"fmt"\n\t"github.com/acme/app/internal/store"\n)',
      "internal/store/a.go": "package store",
      "internal/store/b.go": "package store",
      "internal/store/a_test.go": "package store",
    });
    expect(resolveReferences(parsed, config)).toEqual([
      { from: "cmd/main.go", to: "internal/store/a.go", type: "imports" },
      { from: "cmd/main.go", to: "internal/store/b.go", type: "imports" },
    ]);
  });

  test("deterministic regardless of input order", () => {
    const files = {
      "a.ts": 'import "./b";\nimport "./c";',
      "b.ts": 'import "./c";',
      "c.ts": 'import "./a";',
    };
    const forward = repo(files);
    const reversed = repo(Object.fromEntries(Object.entries(files).reverse()));
    expect(resolveReferences(reversed.parsed, reversed.config)).toEqual(
      resolveReferences(forward.parsed, forward.config),
    );
  });
});
