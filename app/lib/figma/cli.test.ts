// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseCliArgs, runCli } from "../../../figma-extractor/src/cli";

describe("Figma extractor CLI arguments", () => {
  it("keeps networking off and renders selected nodes by default", () => {
    const config = parseCliArgs([
      "--file-key", "abc",
      "--version", "123",
      "--output", "out",
      "--nodes", "2:2,1:1",
      "--cache", "cache",
    ]);
    expect(config.allowNetwork).toBe(false);
    expect(config.extraction).toMatchObject({
      fileKey: "abc",
      version: "123",
      nodeIds: ["2:2", "1:1"],
      renders: { nodeIds: ["2:2", "1:1"], format: "png", scale: 1 },
    });
  });

  it("requires an exact version and rejects unknown flags", () => {
    expect(() => parseCliArgs(["--file-key", "abc", "--version", "latest", "--output", "out"]))
      .toThrow(/exact Figma version/);
    expect(() => parseCliArgs(["--wat"])).toThrow(/Unknown option/);
  });

  it("refuses an uncached extraction before any network-capable path is created", async () => {
    await expect(runCli(["--file-key", "abc", "--version", "123", "--output", "out"]))
      .rejects.toThrow("Network is disabled and no --cache directory was provided.");
  });
});
