import { describe, expect, test } from "vitest";
import packageJson from "../package.json";
import vercel from "../vercel.json";

describe("Vercel deployment", () => {
  test("builds through Convex so the deployment URL is injected", () => {
    expect(vercel.buildCommand).toBe("npx convex deploy --cmd 'npm run build'");
  });

  test("uses the same Node major as CI and the installed deployment tooling", () => {
    expect(packageJson.engines.node).toBe("22.x");
  });
});
