import { describe, expect, test } from "vitest";
import { requireConvexDeploymentUrl } from "./convexDeploymentUrl";

describe("requireConvexDeploymentUrl", () => {
  test.each([undefined, "", "   "])("rejects a missing build-time URL (%p)", (value) => {
    expect(() => requireConvexDeploymentUrl(value)).toThrowError(
      /NEXT_PUBLIC_CONVEX_URL is required at build time.*CONVEX_DEPLOY_KEY/,
    );
  });

  test("returns the deployment URL without surrounding whitespace", () => {
    expect(requireConvexDeploymentUrl("  https://preview.convex.cloud  ")).toBe(
      "https://preview.convex.cloud",
    );
  });
});
