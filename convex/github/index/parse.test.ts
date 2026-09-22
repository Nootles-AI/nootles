import { describe, expect, test } from "vitest";
import { parseFile } from "./parse";

describe("parseFile: TypeScript", () => {
  const source = `"use client";

/**
 * The page's toolbar: formatting, insert and share.
 * @param props the props
 */
import React, { useState } from "react";
import type { Doc } from "../_generated/dataModel";
import "./toolbar.css";
import * as icons from "@/app/components/Icons";
export { helper } from "./helper";
export * from "./more";
export * as ns from "./ns";
// import { dead } from "./commented";
/* import { alsoDead } from "./block"; */
const lazy = () => import("./Lazy");
const cjs = require("./legacy");
const text = \`import nope from "./template" \${api.inside.template.call}\`;
const re = /import x from "\\.\\/regex"/;
const s = "import fake from './string'";

export function Toolbar() {}
export default function Page() {}
export const LIMIT = 3, other = 4;
export class Store {}
export type Mode = "a" | "b";
export interface Props {}
export enum Kind { A }
export async function load() {}
const a = 1, b = 2;
export { a, b as renamed, type Doc as DocType };

const list = useQuery(api.notion.pages.list);
const run = internal.github.indexer.run;
const not = myapi.foo.bar;
const one = api.single;
`;
  const parsed = parseFile("app/components/Toolbar.tsx", source);

  test("language and lines", () => {
    expect(parsed.language).toBe("tsx");
    expect(parsed.lines).toBe(source.split("\n").length - 1);
  });

  test("imports in order, deduped, commented-out ones ignored", () => {
    expect(parsed.imports).toEqual([
      "react",
      "../_generated/dataModel",
      "./toolbar.css",
      "@/app/components/Icons",
      "./helper",
      "./more",
      "./ns",
      "./Lazy",
      "./legacy",
    ]);
  });

  test("exports", () => {
    expect(parsed.exports).toEqual([
      "helper", "Toolbar", "Page", "LIMIT", "Store", "Mode", "Props", "Kind", "load",
      "a", "renamed", "DocType",
    ]);
    expect(parsed.exports).toContain("helper");
    expect(parsed.exports).not.toContain("default");
  });

  test("convex references", () => {
    expect(parsed.convexRefs).toEqual(["inside.template.call", "notion.pages.list", "github.indexer.run"]);
  });

  test("leading comment skips the directive and drops JSDoc tags", () => {
    expect(parsed.leading).toBe("The page's toolbar: formatting, insert and share.");
  });

  test("no style tokens for script files", () => {
    expect(parsed.cssTokens).toEqual([]);
  });
});

describe("parseFile: other languages", () => {
  test("line comments at the top, past a license header", () => {
    const parsed = parseFile(
      "lib/x.ts",
      "// Copyright 2026 Acme. MIT License.\n\n// Turns a tree into\n// a flat list.\nexport const x = 1;\n",
    );
    expect(parsed.leading).toBe("Turns a tree into a flat list.");
  });

  test("python", () => {
    const parsed = parseFile(
      "pkg/service/api.py",
      [
        "#!/usr/bin/env python",
        '"""Service entry points.',
        "",
        'More detail here."""',
        "import os, sys as system",
        "import pkg.models",
        "from pkg.db import session",
        "from . import utils, helpers as h",
        "from ..core import config",
        "from .sibling import (a,",
        "    b)",
        "# import commented",
        "x = 'import fake'",
        "def handler(): pass",
        "async def fetch(): pass",
        "def _private(): pass",
        "class Service:",
        "    def method(self): pass",
        "",
      ].join("\n"),
    );
    expect(parsed.language).toBe("py");
    expect(parsed.imports).toEqual([
      "os", "sys", "pkg.models", "pkg.db", ".utils", ".helpers", "..core", ".sibling",
    ]);
    expect(parsed.exports).toEqual(["handler", "fetch", "Service"]);
    expect(parsed.leading).toBe("Service entry points. More detail here.");
  });

  test("go", () => {
    const parsed = parseFile(
      "internal/server/server.go",
      [
        "// Package server serves the API.",
        "package server",
        "",
        "import (",
        '\t"fmt"',
        '\tlog "github.com/acme/app/internal/log"',
        '\t// "github.com/acme/app/dead"',
        ")",
        'import "github.com/acme/app/pkg/util"',
        "",
        "func Start() {}",
        "func stop() {}",
        "func (s *Server) Method() {}",
        "type Server struct{}",
        "type config struct{}",
        "var raw = `import \"nope\"`",
        "",
      ].join("\n"),
    );
    expect(parsed.imports).toEqual(["fmt", "github.com/acme/app/internal/log", "github.com/acme/app/pkg/util"]);
    expect(parsed.exports).toEqual(["Start", "Server"]);
    expect(parsed.leading).toBe("Package server serves the API.");
  });

  test("rust", () => {
    const parsed = parseFile(
      "src/lib.rs",
      [
        "//! The crate root.",
        "use crate::models::{User, Team};",
        "use std::collections::HashMap;",
        "// use crate::dead;",
        "mod models;",
        "pub mod api;",
        "pub fn run<'a>(x: &'a str) {}",
        "fn private() {}",
        "pub struct Config;",
        "pub(crate) struct Hidden;",
        "pub enum Mode {}",
        "pub trait Store {}",
        "",
      ].join("\n"),
    );
    expect(parsed.imports).toEqual([
      "crate::models::{User, Team}", "std::collections::HashMap", "mod models", "mod api",
    ]);
    expect(parsed.exports).toEqual(["run", "Config", "Mode", "Store"]);
    expect(parsed.leading).toBe("The crate root.");
  });

  test("css tokens and imports", () => {
    const parsed = parseFile(
      "app/globals.css",
      [
        "/* Global styles and the design tokens. */",
        '@import "tailwindcss";',
        '@import url("./fonts.css");',
        "/* @import './dead.css'; */",
        ":root {",
        "  --foreground: oklch(0.2 0 0);",
        "  --radius:  6px ;",
        "  --font-sans: Inter, system-ui, sans-serif;",
        "}",
        ".dark { --foreground: white; }",
        "a { color: var(--foreground); }",
        "",
      ].join("\n"),
    );
    expect(parsed.imports).toEqual(["tailwindcss", "./fonts.css"]);
    expect(parsed.cssTokens).toEqual([
      { name: "--foreground", value: "oklch(0.2 0 0)" },
      { name: "--radius", value: "6px" },
      { name: "--font-sans", value: "Inter, system-ui, sans-serif" },
    ]);
    expect(parsed.leading).toBe("Global styles and the design tokens.");
  });

  test("scss use and line comments", () => {
    const parsed = parseFile(
      "styles/main.scss",
      '@use "sass:math";\n@use "./tokens";\n// @import "dead";\n.a { background: url(http://x.test/a.png); }\n',
    );
    expect(parsed.imports).toEqual(["sass:math", "./tokens"]);
  });

  test("vue reads its script blocks", () => {
    const parsed = parseFile(
      "src/components/Button.vue",
      '<template><p>Don\'t import "./nope"</p></template>\n<script setup lang="ts">\nimport { ref } from "vue";\nimport Icon from "./Icon.vue";\n</script>\n',
    );
    expect(parsed.language).toBe("vue");
    expect(parsed.imports).toEqual(["vue", "./Icon.vue"]);
  });

  test("swift, kotlin and dart imports name their UI toolkit", () => {
    const swift = parseFile("App/ContentView.swift", "// The home screen.\nimport SwiftUI\n@testable import Core\nimport struct Foundation.URL\n");
    expect(swift).toMatchObject({ language: "swift", imports: ["SwiftUI", "Core", "Foundation.URL"], leading: "The home screen." });
    const kt = parseFile("app/Theme.kt", "package a\nimport androidx.compose.material3.MaterialTheme\n// import android.widget.Button\n");
    expect(kt).toMatchObject({ language: "kt", imports: ["androidx.compose.material3.MaterialTheme"] });
    const dart = parseFile("lib/main.dart", "import 'package:flutter/material.dart';\nexport \"src/a.dart\";\n");
    expect(dart).toMatchObject({ language: "dart", imports: ["package:flutter/material.dart", "src/a.dart"] });
    expect(parseFile("res/values/colors.xml", "<resources/>").language).toBe("xml");
  });

  test("markdown opening paragraph", () => {
    const parsed = parseFile("README.md", "# Title\n\nA planning tool for *teams*.\n\n## More\n");
    expect(parsed.leading).toBe("A planning tool for teams.");
  });

  test("unknown and empty", () => {
    const parsed = parseFile("data.xyz", "");
    expect(parsed).toEqual({
      path: "data.xyz",
      language: "other",
      lines: 0,
      imports: [],
      exports: [],
      leading: "",
      convexRefs: [],
      cssTokens: [],
    });
  });

  test("exports are capped at 40 and the leading comment at 300 chars", () => {
    const many = Array.from({ length: 50 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const parsed = parseFile("a.ts", `/** ${"word ".repeat(100)} */\n${many}`);
    expect(parsed.exports).toHaveLength(40);
    expect(parsed.leading.length).toBeLessThanOrEqual(300);
  });
});
