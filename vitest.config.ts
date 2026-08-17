import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" so app modules resolve under test.
    alias: { "@": path.dirname(fileURLToPath(import.meta.url)) },
  },
  test: {
    environment: "edge-runtime",
    // Convex functions and the pure canvas-collab layer; UI is verified
    // in-browser.
    include: ["convex/**/*.test.ts", "app/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
