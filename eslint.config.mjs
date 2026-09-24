import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Convex codegen output.
    "convex/_generated/**",
    // Other sessions' git worktrees checked out inside the repo.
    ".claude/worktrees/**",
    // The Heron art scenes (Pro, team joining) are checked by Heron, against its own conventions,
    // through a symlink to the installed tool.
    "scripts/pro-art/heron/**",
    "scripts/pro-art/team.scene.ts",
    "scripts/team-join-art/heron/**",
    "scripts/team-join-art/join.scene.ts",
  ]),
  {
    rules: {
      // Allow `_`-prefixed intentional discards (e.g. destructure-and-drop).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
