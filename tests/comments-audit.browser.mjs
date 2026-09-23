/**
 * The project owner exports their comment activity as CSV, driven through
 * real Chromium clicks and keys: the ⋯ menu on a project, "Export comment
 * activity", and the file the browser actually saves — read back and checked
 * byte for byte, formula-injection defusing and all. An operator standing in
 * is not offered the action.
 *
 * The real `RowMenu` and exporter run over a memory stand-in for Convex that
 * pages `audit.forProject` the way the deployment does. No app server, no
 * Convex, no API keys; every off-origin request fails the run, and the
 * WebSocket is inert.
 *
 *   node tests/comments-audit.browser.mjs
 *
 * Uses system Chrome (`channel: "chrome"`); `COMMENTS_BROWSER_CHANNEL=chromium`
 * or `COMMENTS_CHROME_PATH` picks another.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./comments-launch.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "comments-audit-"));

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

const FIXTURES = {
  // Only the stand-in banner subscribes, and it has nothing to say here.
  "convex/react": "export function useQuery() { return undefined; }",
  "next/navigation": "export const useRouter = () => ({ push(){}, replace(){}, prefetch(){} });",
  "next/link": `import { createElement } from "react"; export default function Link({ href, children, ...rest }) { return createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children); }`,
};

await build({
  absWorkingDir: repo, entryPoints: ["tests/comments-audit.browser.tsx"], bundle: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  jsx: "automatic",
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  logLevel: "warning",
  plugins: [{
    name: "comments-audit-fixture",
    setup(builder) {
      builder.onResolve({ filter: /^(convex\/react|next\/navigation|next\/link)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: FIXTURES[args.path], loader: "js", resolveDir: repo }));
    },
  }],
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:Arial,sans-serif}
  .nt-menu{background:#fff;border:1px solid #ddd;padding:4px;min-width:200px}
  .nt-menu-item{display:block;width:100%;text-align:left;padding:4px 8px;background:none;border:0}
</style></head><body><div id="root"></div>
  <script type="module" src="/comments-audit.browser.js"></script>
</body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};

const HEADER = "at,action,actor,actor id,subject kind,subject id,page,counts";
const FIRST_RECORDS = [
  HEADER,
  `2026-01-05T12:00:00.000Z,comment.create,"'=HYPERLINK(""http://evil.example"",""click"")",user_0,thread,t_0,"Budget, ""final""",mentions=0`,
  `2026-01-05T12:01:00.000Z,comment.create,Zoë Ångström 李雷,user_1,thread,t_0,"Прогноз\r\nQ3",mentions=1`,
  "2026-01-05T12:02:00.000Z,entitlement.revoke,operator,operator_1,feature,comments,,",
  "2026-01-05T12:03:00.000Z,comment.create,user_3,user_3,thread,t_1,'@cmd|' /C calc'!A0,count=5; mentions=1; replies=2",
  "2026-01-05T12:04:00.000Z,comment.create,Person 0,user_0,thread,t_1,Plan,mentions=0",
].join("\r\n");
const LAST_RECORD = "2026-01-05T19:29:00.000Z,comment.resolve,Person 1,user_1,thread,t_149,Plan,mentions=1\r\n";

let browser;
try {
  browser = await launchBrowser();

  const open = async ({ standIn = false } = {}) => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 900, height: 600 } });
    if (standIn) {
      // A stand-in token is only read for its expiry here; nothing verifies it.
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
      await context.addCookies([{ name: "nt_imp", value: `x.${payload}.y`, url: origin }]);
    }
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") failures.push(`console ${message.type()}: ${message.text()}`);
    });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      failures.push(`request left the fixture: ${url}`);
      return route.abort();
    });
    await page.addInitScript(() => {
      window.WebSocket = class extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0;
        send() { throw new Error("Fixture socket must never send"); }
        close() { this.readyState = 3; }
      };
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.ntAudit);
    return { context, page };
  };

  const menuItems = (page) => page.locator("[role='menuitem']").allTextContents();
  const savedText = async (download) => readFile(await download.path(), "utf8");

  // --- the owner opens the ⋯ menu and exports with the mouse ------------------
  const { context, page } = await open();
  await page.click("button[aria-label='Actions for Launch: Q3/Q4 plan']");
  check("the owner's menu offers the export among the owner's verbs", await menuItems(page),
    ["Open", "Rename", "Export comment activity", "Delete…"]);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10_000 }),
    page.click("[role='menuitem']:has-text('Export comment activity')"),
  ]);
  const day = new Date().toISOString().slice(0, 10);
  check("the file is named for the project, safely, and the day", download.suggestedFilename(),
    `Launch Q3 Q4 plan comment activity ${day}.csv`);
  // Asked of the trigger: without the app's stylesheet the exit animation never
  // ends, so the leaving menu's node outlives the close.
  check("the menu closes behind the action",
    await page.getAttribute("button[aria-label='Actions for Launch: Q3/Q4 plan']", "aria-expanded"), "false");

  const text = await savedText(download);
  check("the file opens with a UTF-8 byte-order mark", text.charCodeAt(0), 0xfeff);
  const csv = text.slice(1);
  check("the header and the first records, escaped and defused, byte for byte", csv.slice(0, FIRST_RECORDS.length), FIRST_RECORDS);
  check("the last record is the log's newest row, CRLF-terminated", csv.endsWith(LAST_RECORD), true);
  const records = csv.split(/\r\n(?=\d{4}-|$)/).filter(Boolean);
  check("every row of the log is in the file, once", records.length, 1 + 450);
  check("no formula reaches a cell unquoted", records.slice(1).every((record) => !/(^|,)[=+\-@]/.test(record)), true);

  const calls = await page.evaluate(() => window.ntAudit.calls);
  check("the exporter walked the paginated query to its end",
    calls.map((call) => [call.name, call.args.projectId, call.args.paginationOpts.cursor]),
    [["audit:forProject", "project_launch", null], ["audit:forProject", "project_launch", "200"], ["audit:forProject", "project_launch", "400"]]);

  // --- and again with the keyboard alone -----------------------------------
  await page.evaluate(() => window.ntAudit.setRows(0));
  await page.focus("button[aria-label='Actions for Launch: Q3/Q4 plan']");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[role='menuitem']");
  const [keyed] = await Promise.all([
    page.waitForEvent("download", { timeout: 10_000 }),
    (async () => {
      for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowDown");
      check("the arrow keys land on the export", await page.evaluate(() => document.activeElement?.textContent), "Export comment activity");
      await page.keyboard.press("Enter");
    })(),
  ]);
  check("an empty log exports as the header alone", await savedText(keyed), `\uFEFF${HEADER}\r\n`);
  check("the exporter reported no failure", await page.evaluate(() => window.ntAudit.failures), []);
  await context.close();

  // --- an operator standing in is not offered it ---------------------------
  const standIn = await open({ standIn: true });
  await standIn.page.waitForSelector(".nt-imp");
  await standIn.page.click("button[aria-label='Actions for Launch: Q3/Q4 plan']");
  check("a stand-in's menu has Open and nothing the server would refuse", await menuItems(standIn.page), ["Open"]);
  check("and nothing asked the log", await standIn.page.evaluate(() => window.ntAudit.calls), []);
  await standIn.page.screenshot({ path: path.join(output, "comments-audit-standin.png") });
  await standIn.context.close();
} finally {
  await browser?.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failure(s):\n${failures.join("\n")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
