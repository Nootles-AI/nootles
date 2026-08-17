import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // Convex functions and the pure canvas-collab layer; UI is verified
    // in-browser.
    include: ["convex/**/*.test.ts", "app/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
