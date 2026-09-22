import { describe, expect, test } from "vitest";
import { colour, describeLook, leaves, readLook, type Look } from "./look";
import { parseFile } from "./parse";

function look(files: Record<string, string>): Look {
  const texts = new Map(Object.entries(files));
  return readLook([...texts].map(([p, t]) => parseFile(p, t)), texts);
}

const swatch = (l: Look, css: string) => l.colours.find((s) => s.css === css);

describe("colour", () => {
  test("normalises what it can to hex, keeps the rest verbatim", () => {
    expect(colour("#FFF")).toBe("#ffffff");
    expect(colour("#2563EBff")).toBe("#2563eb");
    expect(colour("#00000080")).toBe("rgba(0, 0, 0, 0.5)");
    expect(colour("rgb(37, 99, 235)")).toBe("#2563eb");
    expect(colour("rgb(0 0 0 / 0.1)")).toBe("rgba(0, 0, 0, 0.1)");
    expect(colour("hsl(0 0% 100%)")).toBe("#ffffff");
    expect(colour("hsl(222.2 47.4% 11.2%)")).toBe("#0f172a");
    expect(colour("oklch(0.21 0.006 285.885)")).toBe("oklch(0.21 0.006 285.885)");
    expect(colour("white")).toBe("#ffffff");
    expect(colour("currentColor")).toBeNull();
    expect(colour("12px")).toBeNull();
  });
});

describe("leaves", () => {
  test("literal values by key path; computed ones skipped", () => {
    const body = `
      primary: { main: '#1976d2', "light": "#42a5f5" }, // note
      spacing: 8, fonts: ['Inter', 'sans-serif'], computed: fn(1, 2), ...rest,
      shorthand, method() { return 1 }, after: \`#fff\`,`;
    expect(leaves(body)).toEqual([
      { path: ["primary", "main"], value: "#1976d2", kind: "string" },
      { path: ["primary", "light"], value: "#42a5f5", kind: "string" },
      { path: ["spacing"], value: "8", kind: "number" },
      { path: ["fonts"], value: "Inter, sans-serif", kind: "array" },
      { path: ["after"], value: "#fff", kind: "string" },
    ]);
  });
});

describe("readLook: Tailwind", () => {
  /** The failing case: a Next.js + Tailwind v4 app whose tokens say only background and foreground. */
  const nextApp = {
    "package.json": '{ "dependencies": { "next": "16.0.0" }, "devDependencies": { "tailwindcss": "^4", "@tailwindcss/postcss": "^4" } }',
    "app/globals.css": [
      '@import "tailwindcss";',
      ":root { --background: #ffffff; --foreground: #171717; }",
      "@theme inline { --color-background: var(--background); --color-foreground: var(--foreground); }",
      "body { background: var(--background); color: var(--foreground); font-family: Arial, Helvetica, sans-serif; }",
    ].join("\n"),
    "app/layout.tsx": 'import { Geist } from "next/font/google";\nexport default function Layout() {}',
    "app/page.tsx": [
      "export default function Page() {",
      "  return (",
      '    <main className="bg-background text-foreground dark:bg-slate-950 p-8">',
      '      <h1 className="text-gray-900 text-2xl font-semibold">Welcome</h1>',
      '      <p className="text-gray-600 text-sm">One</p>',
      '      <p className="text-gray-600 text-sm">Two</p>',
      '      <button className="bg-blue-600 text-white rounded-lg px-4 py-2 font-semibold hover:bg-blue-700">Save</button>',
      '      <button className="bg-blue-600 text-white rounded-lg px-4 py-2 font-semibold hover:bg-blue-700">Send</button>',
      '      <div className="bg-[#28A8EA] rounded-full p-4" />',
      '      <div className={cn("border border-gray-200 rounded-lg shadow-sm", active && "bg-blue-600/50")} />',
      "    </main>",
      "  );",
      "}",
    ].join("\n"),
    "app/settings/page.tsx": '<h1 className="text-gray-900 text-2xl font-semibold">Settings</h1>',
  };
  const l = look(nextApp);

  test("the palette the screens use, as hex, with counts and roles", () => {
    expect(swatch(l, "#2563eb")).toEqual({ css: "#2563eb", name: "bg-blue-600", role: "background", count: 2 });
    expect(swatch(l, "#111827")).toEqual({ css: "#111827", name: "text-gray-900", role: "text", count: 2 });
    expect(swatch(l, "#4b5563")).toEqual({ css: "#4b5563", name: "text-gray-600", role: "text", count: 2 });
    expect(swatch(l, "#28a8ea")).toEqual({ css: "#28a8ea", name: "bg-[#28A8EA]", role: "background", count: 1 });
    expect(swatch(l, "#e5e7eb")).toMatchObject({ name: "border-gray-200", role: "border" });
    expect(swatch(l, "rgba(37, 99, 235, 0.5)")).toMatchObject({ name: "bg-blue-600/50" });
    // The name shown is one used in the role shown.
    expect(swatch(l, "#ffffff")).toEqual({ css: "#ffffff", name: "--background", role: "background", count: 4 });
    // v4 theme colours resolve through the token they alias.
    expect(swatch(l, "#171717")!.count).toBe(2);
    // Hover states count; dark mode is another look.
    expect(swatch(l, "#1d4ed8")).toMatchObject({ name: "bg-blue-700" });
    expect(swatch(l, "#020617")).toBeUndefined();
    expect(l.platforms).toEqual(["tailwind", "css"]);
  });

  test("corners, shadows, type, fonts and spacing in px and CSS", () => {
    expect(l.radii[0]).toEqual({ css: "8px", name: "rounded-lg", count: 3 });
    expect(l.radii).toContainEqual({ css: "9999px", name: "rounded-full", count: 1 });
    expect(l.shadows).toEqual([{ css: "0 1px 2px 0 rgb(0 0 0 / 0.05)", name: "shadow-sm", count: 1 }]);
    expect(l.type).toContainEqual({ css: "font-weight: 600", name: "font-semibold", count: 4 });
    expect(l.type).toContainEqual({ css: "24px", name: "text-2xl", count: 2 });
    expect(l.type).toContainEqual({ css: "14px", name: "text-sm", count: 2 });
    expect(l.fonts.map((f) => f.css)).toEqual(expect.arrayContaining(["Arial, Helvetica, sans-serif", "Geist"]));
    expect(l.spacing).toContainEqual({ css: "16px", name: "px-4", count: 3 });
    expect(l.spacing).toContainEqual({ css: "32px", name: "p-8", count: 1 });
  });

  test("a button's classes become one CSS rule", () => {
    expect(l.components).toEqual([
      "button { background: #2563eb; color: #ffffff; border-radius: 8px; padding: 8px 16px; font-weight: 600 }",
    ]);
  });

  test("described: the palette leads, in CSS", () => {
    const text = describeLook(l, 1400);
    expect(text).toMatch(/^Palette: .*#2563eb \(bg-blue-600, 2× background\)/m);
    expect(text).toMatch(/^Palette: .*#111827 \(text-gray-900, 2× text\)/m);
    expect(text).toMatch(/^Palette: .*#28a8ea \(bg-\[#28A8EA\], 1× background\)/m);
    expect(text).toMatch(/^Corners: 8px \(rounded-lg, 3×\)/m);
    expect(text).toMatch(/^Component styles: button \{ background: #2563eb;/m);
    expect(text).not.toMatch(/^Platform:/m);
  });

  test("v4 @theme colours resolve custom classes", () => {
    const l = look({
      "app/globals.css": '@import "tailwindcss";\n@theme { --color-brand: #ff5a1f; --color-ink-900: oklch(0.2 0.01 250); --radius-card: 14px; }',
      "app/page.tsx": '<a className="bg-brand text-ink-900 rounded-card px-3 py-1.5">Go</a><div className="bg-brand/50" />',
    });
    expect(swatch(l, "#ff5a1f")).toEqual({ css: "#ff5a1f", name: "bg-brand", role: "background", count: 1 });
    expect(swatch(l, "oklch(0.2 0.01 250)")).toMatchObject({ name: "text-ink-900", role: "text" });
    expect(swatch(l, "rgba(255, 90, 31, 0.5)")).toMatchObject({ name: "bg-brand/50" });
    expect(l.radii).toEqual([{ css: "14px", name: "rounded-card", count: 1 }]);
    expect(l.components).toEqual([
      "a { background: #ff5a1f; color: oklch(0.2 0.01 250); border-radius: 14px; padding: 6px 12px }",
    ]);
  });

  test("v3 config colours and radii resolve custom classes", () => {
    const l = look({
      "tailwind.config.js": [
        "module.exports = {",
        "  theme: { extend: {",
        "    colors: { brand: { DEFAULT: '#123456', 500: '#abcdef' }, primary: 'hsl(var(--primary))' },",
        "    borderRadius: { lg: 'var(--radius)' },",
        "    fontFamily: { display: ['Fraunces', 'serif'] },",
        "  } },",
        "};",
      ].join("\n"),
      "src/index.css": "@tailwind base;\n:root { --primary: 222.2 47.4% 11.2%; --radius: 0.5rem; }",
      "src/App.jsx": '<div className="bg-brand text-brand-500 bg-primary rounded-lg font-display" />',
    });
    expect(swatch(l, "#123456")).toMatchObject({ name: "bg-brand" });
    expect(swatch(l, "#abcdef")).toMatchObject({ name: "text-brand-500" });
    expect(swatch(l, "#0f172a")).toMatchObject({ name: "bg-primary" });
    expect(l.radii).toEqual([{ css: "8px", name: "rounded-lg", count: 1 }]);
    expect(l.fonts).toEqual([{ css: "Fraunces, serif", name: "font-display", count: 1 }]);
  });

  test("a cva button: the default and each variant, as rules", () => {
    const l = look({
      "package.json": '{ "dependencies": { "tailwindcss": "^3.4.0" } }',
      "components/ui/button.tsx": [
        "const buttonVariants = cva(",
        '  "inline-flex items-center rounded-md text-sm font-medium",',
        "  {",
        "    variants: {",
        "      variant: {",
        '        default: "bg-zinc-900 text-white",',
        '        outline: "border border-zinc-200 bg-white text-zinc-900",',
        "      },",
        '      size: { default: "h-10 px-4 py-2", sm: "h-9 px-3" },',
        "    },",
        '    defaultVariants: { variant: "default", size: "default" },',
        "  },",
        ");",
      ].join("\n"),
    });
    expect(l.components).toEqual([
      "button { background: #18181b; color: #ffffff; border-radius: 6px; padding: 8px 16px; height: 40px; font-size: 14px; font-weight: 500 }",
      "button.outline { background: #ffffff; color: #18181b; border: 1px solid #e4e4e7; border-radius: 6px; padding: 8px 16px; height: 40px; font-size: 14px; font-weight: 500 }",
    ]);
  });

  test("class names alone are not Tailwind: a Bootstrap app's p-3 is not 12px", () => {
    const l = look({ "index.html": '<div class="p-3 bg-primary rounded shadow-sm">x</div>' });
    expect(l.platforms).toEqual([]);
    expect(l.radii).toEqual([]);
    expect(l.spacing).toEqual([]);
  });
});

describe("readLook: native platforms, in CSS", () => {
  test("SwiftUI with an asset catalog colour", () => {
    const l = look({
      "App/Assets.xcassets/BrandBlue.colorset/Contents.json": JSON.stringify({
        colors: [
          { color: { "color-space": "srgb", components: { red: "0.157", green: "0.659", blue: "0.918", alpha: "1.000" } }, idiom: "universal" },
          { appearances: [{ appearance: "luminosity", value: "dark" }], color: { components: { red: "0x10", green: "0x20", blue: "0x30", alpha: "1.000" } }, idiom: "universal" },
        ],
      }),
      "App/Theme.swift": [
        "import SwiftUI",
        "extension Color {",
        "  static let ink = Color(red: 17/255, green: 24/255, blue: 39/255)",
        "}",
      ].join("\n"),
      "App/ContentView.swift": [
        "import SwiftUI",
        "struct ContentView: View {",
        "  var body: some View {",
        '    Text("Hello")',
        '      .font(.custom("Urbanist-SemiBold", size: 16))',
        '      .foregroundColor(Color("BrandBlue"))',
        "      .padding(16)",
        "      .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))",
        "      .shadow(color: .black.opacity(0.1), radius: 8, x: 0, y: 4)",
        '    Text("Title").font(.system(size: 28, weight: .bold))',
        "  }",
        "}",
      ].join("\n"),
    });
    expect(swatch(l, "#28a8ea")).toMatchObject({ name: "BrandBlue", count: 2 });
    expect(swatch(l, "#101f30")).toBeUndefined();
    expect(swatch(l, "#111827")).toMatchObject({ name: "ink", count: 1 });
    expect(swatch(l, "#ffffff")).toMatchObject({ role: "background" });
    expect(l.radii).toEqual([{ css: "12px", name: "cornerRadius", count: 1 }]);
    expect(l.fonts.map((f) => f.css)).toEqual(expect.arrayContaining(["Urbanist", "system-ui, -apple-system, sans-serif"]));
    expect(l.type).toEqual(expect.arrayContaining([
      expect.objectContaining({ css: "16px" }),
      expect.objectContaining({ css: "28px" }),
      expect.objectContaining({ css: "font-weight: 700" }),
    ]));
    expect(l.shadows).toEqual([{ css: "0px 4px 8px rgba(0, 0, 0, 0.1)", name: ".shadow", count: 1 }]);
    expect(l.spacing).toEqual([{ css: "16px", name: ".padding", count: 1 }]);
    expect(l.platforms).toEqual(["swiftui"]);
    expect(describeLook(l, 1400)).toMatch(/^Platform: SwiftUI \(translated to CSS\)\nPalette: /);
  });

  test("Android XML resources and Jetpack Compose", () => {
    const l = look({
      "app/src/main/res/values/colors.xml": [
        "<resources>",
        '  <color name="purple_500">#FF6200EE</color>',
        '  <color name="teal_200">#FF03DAC5</color>',
        '  <color name="scrim">#80000000</color>',
        "</resources>",
      ].join("\n"),
      "app/src/main/res/values-night/colors.xml": '<resources><color name="purple_500">#FF000000</color></resources>',
      "app/src/main/res/values/themes.xml": '<resources><style name="Theme.App"><item name="colorPrimary">@color/purple_500</item></style></resources>',
      "app/src/main/res/values/dimens.xml": '<resources><dimen name="card_corner_radius">12dp</dimen></resources>',
      "app/src/main/res/layout/activity_main.xml": [
        '<com.google.android.material.card.MaterialCardView xmlns:android="http://schemas.android.com/apk/res/android"',
        '  app:cardCornerRadius="@dimen/card_corner_radius" android:background="@color/teal_200">',
        '  <TextView android:textSize="16sp" android:fontFamily="@font/urbanist_semibold" android:padding="16dp" />',
        "</com.google.android.material.card.MaterialCardView>",
      ].join("\n"),
      "app/src/main/java/com/acme/ui/theme/Color.kt": "package com.acme.ui.theme\nimport androidx.compose.ui.graphics.Color\nval Purple80 = Color(0xFFD0BCFF)\n",
      "app/src/main/java/com/acme/ui/theme/Theme.kt": [
        "import androidx.compose.material3.lightColorScheme",
        "private val Scheme = lightColorScheme(primary = Purple80)",
      ].join("\n"),
      "app/src/main/java/com/acme/Card.kt": [
        "import androidx.compose.foundation.shape.RoundedCornerShape",
        "val shape = RoundedCornerShape(8.dp)",
        "val style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily(Font(R.font.urbanist_regular)))",
        "Modifier.padding(16.dp)",
      ].join("\n"),
    });
    expect(swatch(l, "#6200ee")).toMatchObject({ name: "colorPrimary", count: 2 });
    expect(swatch(l, "#000000")).toBeUndefined();
    expect(swatch(l, "rgba(0, 0, 0, 0.5)")).toMatchObject({ name: "scrim" });
    expect(swatch(l, "#03dac5")).toMatchObject({ name: "teal_200", count: 2 });
    expect(swatch(l, "#d0bcff")).toMatchObject({ count: 2 });
    expect(l.radii.map((r) => r.css)).toEqual(["12px", "8px"]);
    expect(l.fonts).toEqual([expect.objectContaining({ css: "Urbanist", count: 2 })]);
    expect(l.type.map((t) => t.css)).toEqual(expect.arrayContaining(["16px", "14px", "font-weight: 600"]));
    expect(l.spacing[0]).toMatchObject({ css: "16px", count: 2 });
    expect(l.platforms).toEqual(["android-xml", "compose"]);
    expect(describeLook(l, 1400)).toMatch(/^Platform: Android XML, Jetpack Compose \(translated to CSS\)$/m);
  });

  test("Flutter", () => {
    const l = look({
      "pubspec.yaml": "flutter:\n  fonts:\n    - family: Urbanist\n      fonts:\n        - asset: fonts/Urbanist.ttf\n",
      "lib/theme.dart": [
        "import 'package:flutter/material.dart';",
        "const brand = Color(0xFF28A8EA);",
        "final theme = ThemeData(",
        "  primaryColor: brand,",
        "  colorScheme: ColorScheme.fromSeed(seedColor: Color(0xFF28A8EA)),",
        "  scaffoldBackgroundColor: Colors.white,",
        ");",
      ].join("\n"),
      "lib/card.dart": [
        "import 'package:flutter/material.dart';",
        "final box = BoxDecoration(",
        "  color: Colors.blue,",
        "  borderRadius: BorderRadius.circular(12),",
        "  boxShadow: [BoxShadow(color: Color(0x1A000000), blurRadius: 8, offset: Offset(0, 4))],",
        ");",
        "const label = TextStyle(fontFamily: 'Urbanist', fontSize: 16, fontWeight: FontWeight.w600);",
        "const pad = EdgeInsets.symmetric(horizontal: 24, vertical: 12);",
        "const all = EdgeInsets.all(16);",
      ].join("\n"),
    });
    expect(swatch(l, "#28a8ea")).toMatchObject({ count: 2 });
    expect(swatch(l, "#ffffff")).toMatchObject({ name: "scaffoldBackgroundColor", role: "background" });
    expect(swatch(l, "#2196f3")).toMatchObject({ name: "Colors.blue" });
    expect(l.radii).toEqual([{ css: "12px", name: "BorderRadius.circular", count: 1 }]);
    expect(l.fonts).toEqual([expect.objectContaining({ css: "Urbanist", count: 2 })]);
    expect(l.type.map((t) => t.css)).toEqual(["16px", "font-weight: 600"]);
    expect(l.shadows).toEqual([{ css: "0px 4px 8px rgba(0, 0, 0, 0.1)", name: "BoxShadow", count: 1 }]);
    expect(l.spacing.map((s) => s.css)).toEqual(["12px", "16px", "24px"]);
    expect(l.platforms).toEqual(["flutter"]);
  });

  test("React Native StyleSheet and inline styles", () => {
    const l = look({
      "src/Home.tsx": [
        "import { StyleSheet, View, Text } from 'react-native';",
        "export function Home() { return <View style={{ borderColor: '#E5E7EB', borderWidth: 1 }} />; }",
        "const styles = StyleSheet.create({",
        "  container: { flex: 1, backgroundColor: '#F8FAFC', padding: 16 },",
        "  button: {",
        "    backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 12,",
        "    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4,",
        "  },",
        "  card: { elevation: 4 },",
        "  label: { color: 'white', fontSize: 16, fontWeight: '600', fontFamily: 'Inter' },",
        "});",
      ].join("\n"),
    });
    expect(swatch(l, "#f8fafc")).toEqual({ css: "#f8fafc", name: "container", role: "background", count: 1 });
    expect(swatch(l, "#2563eb")).toMatchObject({ name: "button", role: "background" });
    expect(swatch(l, "#ffffff")).toMatchObject({ name: "label", role: "text" });
    expect(swatch(l, "#e5e7eb")).toMatchObject({ role: "border" });
    expect(l.radii).toEqual([{ css: "12px", name: "button", count: 1 }]);
    expect(l.shadows.map((s) => s.css)).toEqual(["0 2px 4px rgba(0, 0, 0, 0.2)", "0px 2px 4px rgba(0, 0, 0, 0.25)"]);
    expect(l.fonts).toEqual([{ css: "Inter", name: "label", count: 1 }]);
    expect(l.type.map((t) => t.css)).toEqual(["16px", "font-weight: 600"]);
    expect(l.spacing.map((s) => s.css)).toEqual(["12px", "16px"]);
    expect(l.platforms).toEqual(["react-native"]);
  });

  test("design token files and JS theme objects", () => {
    const l = look({
      "design/tokens.json": JSON.stringify({
        color: { brand: { $value: "#ff0000", $type: "color" }, text: { $value: "{color.brand}", $type: "color" } },
        radius: { md: { $value: "6px", $type: "dimension" } },
        font: { body: { $value: ["Inter", "sans-serif"], $type: "fontFamily" } },
      }),
      "src/theme.ts": [
        "export const theme = createTheme({",
        "  palette: { primary: { main: '#1976d2' }, background: { default: '#fafafa' } },",
        "  shape: { borderRadius: 4 },",
        "  typography: { fontFamily: 'Roboto, sans-serif' },",
        "});",
        "export const darkTheme = { palette: { primary: { main: '#000000' } } };",
      ].join("\n"),
      "server/tokens.json": JSON.stringify({ color: { secret: { $value: "#123123", $type: "color" } } }),
    });
    expect(swatch(l, "#ff0000")).toMatchObject({ count: 2 });
    expect(swatch(l, "#1976d2")).toMatchObject({ name: "theme.palette.primary.main", role: "accent" });
    expect(swatch(l, "#fafafa")).toMatchObject({ role: "background" });
    expect(swatch(l, "#000000")).toBeUndefined();
    expect(swatch(l, "#123123")).toBeUndefined();
    expect(l.radii.map((r) => r.css)).toEqual(["4px", "6px"]);
    expect(l.fonts.map((f) => f.css)).toEqual(expect.arrayContaining(["Inter, sans-serif", "Roboto, sans-serif"]));
    expect(l.platforms).toEqual(["tokens"]);
  });
});

describe("describeLook", () => {
  const big: Look = {
    colours: Array.from({ length: 30 }, (_, i) => ({ css: `#0000${String(i).padStart(2, "0")}`, name: `bg-c-${i}`, role: "background" as const, count: 60 - i })),
    radii: [{ css: "8px", name: "rounded-lg", count: 9 }, { css: "0px", name: "rounded-none", count: 2 }],
    shadows: [],
    fonts: [{ css: "Inter, sans-serif", count: 3 }, { css: "ui-monospace, monospace", count: 1 }],
    type: Array.from({ length: 10 }, (_, i) => ({ css: `${10 + i}px`, count: 10 - i })),
    spacing: Array.from({ length: 10 }, (_, i) => ({ css: `${4 * i + 4}px`, count: 10 - i })),
    components: Array.from({ length: 12 }, (_, i) => `button.v${i} { background: #000000; color: #ffffff; padding: 8px 16px }`),
    platforms: ["tailwind", "css"],
  };

  test("stays within budget, dropping the least useful first", () => {
    const roomy = describeLook(big, 5000);
    expect(roomy.split("\n").map((l) => l.split(":")[0])).toEqual([
      "Palette", "Corners", "Shadows", "Fonts", "Type", "Spacing", "Component styles",
    ]);
    expect(roomy).toContain("Shadows: none anywhere — draw flat");
    for (const budget of [1200, 600, 300, 200]) {
      const text = describeLook(big, budget);
      expect(text.length, String(budget)).toBeLessThanOrEqual(budget);
      expect(text).toMatch(/^Palette: #000000 \(bg-c-0, 60× background\)/m);
      expect(text).toMatch(/^Corners: 8px/m);
      expect(text).toMatch(/^Fonts: Inter, sans-serif/m);
    }
    expect(describeLook(big, 300)).not.toContain("Spacing:");
  });

  test("square and flat are said outright; nothing at all says nothing", () => {
    const flat = describeLook({ ...big, radii: [{ css: "0px", name: "rounded-none", count: 1 }] }, 2000);
    expect(flat).toMatch(/^Corners: square — no border-radius/m);
    const native = describeLook({ ...big, radii: [], platforms: ["flutter"] }, 2000);
    expect(native).toMatch(/^Platform: Flutter \(translated to CSS\)$/m);
    expect(native).toMatch(/^Corners: square — no corner radius anywhere/m);
    const empty: Look = { colours: [], radii: [], shadows: [], fonts: [], type: [], spacing: [], components: [], platforms: [] };
    expect(describeLook(empty, 2000)).toBe("");
  });
});

describe("readLook: determinism", () => {
  test("the same files in any order read the same", () => {
    const files: Record<string, string> = {
      "package.json": '{ "devDependencies": { "tailwindcss": "^3" } }',
      "a/Button.tsx": '<button className="bg-blue-600 text-white rounded-lg px-4 py-2">A</button>',
      "b/Link.tsx": '<a className="text-blue-600 underline rounded-md px-2">B</a><button className="bg-red-600 text-white rounded-md px-4">C</button>',
      "c/site.css": ".card { background: #fff; border-radius: 12px; box-shadow: 0 1px 2px #0002; }",
      "lib/theme.dart": "import 'package:flutter/material.dart';\nconst c = Color(0xFF112233);",
    };
    const forward = look(files);
    const backward = look(Object.fromEntries(Object.entries(files).reverse()));
    expect(backward).toEqual(forward);
    expect(describeLook(backward, 1400)).toBe(describeLook(forward, 1400));
  });
});
