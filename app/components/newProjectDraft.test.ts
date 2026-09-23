import { expect, test } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { wallOf, type NewProject } from "./newProjectDraft";

const draft = (workspace?: NewProject["workspace"]): NewProject => ({
  title: "Roadmap",
  description: "",
  sources: { repos: [], files: [], pages: [] },
  workspace,
});

test("a project drafted in a workspace meets that workspace's wall", () => {
  const acme = "w1" as Id<"workspaces">;
  expect(wallOf(draft({ workspaceId: acme, slug: "acme", visibility: "workspace" }))).toBe(acme);
});

test("a personal draft, or no draft at all, meets the person's own wall", () => {
  expect(wallOf(draft())).toBeNull();
  expect(wallOf(undefined)).toBeNull();
});
