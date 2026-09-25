import { describe, expect, it } from "vitest";
import { fenceLanguage } from "./languages";

describe("fenceLanguage", () => {
  it("takes our own ids, in any case", () => {
    expect(fenceLanguage("python")).toBe("python");
    expect(fenceLanguage("TSX")).toBe("tsx");
  });

  it("takes the short names fences are written with", () => {
    expect(fenceLanguage("ts")).toBe("typescript");
    expect(fenceLanguage("js")).toBe("javascript");
    expect(fenceLanguage("py")).toBe("python");
    expect(fenceLanguage("txt")).toBe("plaintext");
  });

  it("is plain text for a language we have no grammar for", () => {
    expect(fenceLanguage("cobol")).toBe("plaintext");
  });
});
