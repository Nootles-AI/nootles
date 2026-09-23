import { describe, expect, test } from "vitest";
import type { Listed } from "@/convex/github/repos";
import { mergeRepos } from "./github";

const row = (fullName: string, pushedAt: string, installationId?: number): Listed => ({
  fullName,
  defaultBranch: "main",
  private: true,
  pushedAt,
  ...(installationId !== undefined ? { installationId } : {}),
});

describe("mergeRepos", () => {
  test("one row per repository, the App's where both reach it, most recently pushed first", () => {
    const merged = mergeRepos(
      [row("acme/api", "2026-08-02", 42), row("acme/web", "2026-08-01", 42)],
      [row("Acme/API", "2026-08-09"), row("octo/notes", "2026-08-05")],
    );
    expect(merged.map((r) => [r.fullName, r.installationId])).toEqual([
      ["octo/notes", undefined],
      ["acme/api", 42],
      ["acme/web", 42],
    ]);
  });
});
