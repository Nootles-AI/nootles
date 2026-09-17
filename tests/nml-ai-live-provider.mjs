import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

if (process.env.NML_ALLOW_PAID_AI !== "1") {
  throw new Error("Refusing live providers without NML_ALLOW_PAID_AI=1.");
}

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const output = process.env.NML_AI_LIVE_RESUME_DIR
  ? path.resolve(process.env.NML_AI_LIVE_RESUME_DIR)
  : await mkdtemp(path.join(tmpdir(), "nml-ai-live-"));
await mkdir(output, { recursive: true });
const albumPath = path.join(output, "album-contact-sheet.png");
const sheet = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="900" height="420">
    <rect width="450" height="420" fill="#d96c4b"/>
    <circle cx="225" cy="220" r="115" fill="#f6df9a"/>
    <rect x="450" width="450" height="420" fill="#426b7a"/>
    <path d="M520 330 L675 105 L835 330 Z" fill="#d7e9e5"/>
    <rect x="18" y="18" width="180" height="58" rx="8" fill="white"/>
    <rect x="468" y="18" width="180" height="58" rx="8" fill="white"/>
    <text x="35" y="58" font-family="Arial" font-size="36" font-weight="700">img-a</text>
    <text x="485" y="58" font-family="Arial" font-size="36" font-weight="700">img-b</text>
  </svg>
`);
await sharp(sheet).png().toFile(albumPath);

const outfile = path.join(output, "nml-ai-live-provider.bundle.mjs");
await build({
  absWorkingDir: repo,
  entryPoints: ["tests/nml-ai-live-provider.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile,
  tsconfig: "tsconfig.json",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "warning",
});

process.env.NML_AI_LIVE_ARTIFACT_DIR = output;
process.env.NML_AI_LIVE_ALBUM_PATH = albumPath;
await writeFile(
  path.join(output, "run-envelope.json"),
  JSON.stringify(
    {
      allowPaid: true,
      maximumRequests: 10,
      maximumByHost: {
        "api.mistral.ai": 1,
        "openrouter.ai": 8,
        "external.api.recraft.ai": 1,
      },
      resumeAfter: process.env.NML_AI_LIVE_RESUME_AFTER ?? null,
      previousCounts: JSON.parse(
        process.env.NML_AI_LIVE_PREVIOUS_COUNTS ?? "{}",
      ),
    },
    null,
    2,
  ),
);
await import(pathToFileURL(outfile).href);
