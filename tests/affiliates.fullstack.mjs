/**
 * Affiliate links, end to end, the way a visitor meets one (NT-119): a REAL
 * Convex backend (a throwaway convex-local-backend, tests/fullstack-backend.mjs)
 * with `AFFILIATE_CLICK_SECRET` set on it, the REAL `/r/<slug>` route handler
 * (`app/r/[slug]/route.ts`, bundled for Node and served as Next would serve
 * it, with the same secret), and the REAL app root — its providers in
 * `app/layout.tsx`'s order, `AffiliateClaim` among them
 * (tests/affiliates.fullstack.tsx) — on the SAME origin, so the cookie the
 * route sets is the one the app finds. One Playwright context per visitor.
 *
 * - a. Nia, brand new, clicks Nina's link, lands on its destination, signs
 *      up: attributed, the cookie gone, PostHog told once.
 * - b. Eli, who has used Nootles for a while, clicks it: not attributed, the
 *      cookie gone all the same. Ivy, who signed up minutes before her click,
 *      is the control — she counts.
 * - c. Oscar clicks it, then stands in for Sam: nothing is claimed, and his
 *      cookie stays for when he is himself again.
 * - d. Una clicks Nina's link, then an unknown slug, a disabled affiliate's
 *      and a slug that can't be one: each lands on the default destination,
 *      counts nothing and leaves her cookie alone — she is still Nina's.
 * - e. `recordClick` forged over HTTP — no signature, the wrong secret, a
 *      stale one, a visitor that isn't one: nothing counted; the route's own
 *      signature is the positive control.
 * - f. Fay clicks Nina's link, then Ben's: one visitor, and Ben gets her.
 * - g. Gia clicks, then opens a share link before anything else — so her
 *      profile is written first — and still counts.
 * - h. A HEAD, a browser prefetch and Slack's link preview: nothing counted,
 *      no cookie.
 *
 * Two things are done around the app, and only two:
 * - Eli has to have been here more than ten minutes before his click, and
 *   waiting that out is not a test; so his visit is moved eleven minutes
 *   later through the backend's own admin function (the dashboard's field
 *   edit). Ivy's is left alone.
 * - A browser follows a redirect without asking the harness, so the route's
 *   answer reaches it with our sites' address swapped for `/__site` on this
 *   origin, which stands in for them. Everything else in that answer — the
 *   status, the Set-Cookie — is the route's own, and the real location is
 *   what the checks read.
 *
 * Nothing reaches a cloud deployment or a paid API: the AI keys are unset,
 * the backend's outbound fetches are refused (and fail the run), and every
 * browser request outside the page and the backend fails the run, as does
 * any 4xx or 5xx. Screenshots land in tests/.artifacts/affiliates/.
 *
 *   npm run test:affiliates:fullstack
 *
 * Needs a convex-local-backend binary (see tests/fullstack-backend.mjs) and
 * system Chrome (`COMMENTS_BROWSER_CHANNEL=chromium` for Playwright's own).
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { anyApi, makeFunctionReference } from "convex/server";
import { ConvexHttpClient } from "convex/browser";
import { bundleSurfaces, guardedTab, ledger, wait } from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend, signingPair } from "./fullstack-backend.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = path.join(repo, "tests", ".artifacts", "affiliates");

const PEOPLE = {
  nia: { userId: "user_nia", name: "Nia New" },
  eli: { userId: "user_eli", name: "Eli Existing" },
  ivy: { userId: "user_ivy", name: "Ivy Recent" },
  oscar: { userId: "user_oscar", name: "Oscar Operator" },
  sam: { userId: "user_sam", name: "Sam Stood-in-for" },
  fay: { userId: "user_fay", name: "Fay Twice" },
  gia: { userId: "user_gia", name: "Gia Guest" },
  una: { userId: "user_una", name: "Una Unmoved" },
  olive: { userId: "user_olive", name: "Olive Owner" },
};
const NINA = { slug: "nina", name: "Nina Influencer", destination: "https://nootles.com/for/teachers" };
const BEN = { slug: "ben-makes", name: "Ben Makes", destination: "https://app.nootles.com/sign-in" };
const DEE = { slug: "dee", name: "Dee Disabled", destination: "https://www.nootles.com/dee" };
const DEFAULT = "https://nootles.com/";
const WINDOW_S = 30 * 24 * 60 * 60;

/** The sites a link may land on. Never reached: see the server's `/__site`. */
const SITES = /^https:\/\/(www\.|app\.)?nootles\.com\//;

/** The history router the app's pages move through (as comments-e2e's). */
const NAVIGATION = `
  import { useMemo, useSyncExternalStore } from "react";
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method].bind(history);
    history[method] = (...args) => { original(...args); queueMicrotask(notify); };
  }
  window.addEventListener("popstate", notify);
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const go = (href, replace) => history[replace ? "replaceState" : "pushState"](null, "", href);
  const router = { push: (href) => go(href, false), replace: (href) => go(href, true), prefetch() {}, back: () => history.back(), forward: () => history.forward(), refresh() {} };
  export function useRouter() { return router; }
  export function usePathname() { return useSyncExternalStore(subscribe, () => location.pathname); }
  export function useSearchParams() {
    const search = useSyncExternalStore(subscribe, () => location.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  }
  export function useParams() { return {}; }
  export function redirect(href) { go(href, true); }
  export function notFound() { throw new Error("notFound"); }
`;

/**
 * Clerk, signed in as the runner's person: what `ConvexClientProvider`,
 * `IdentitySync` and `TelemetryProvider` ask of it. The token is the fake
 * issuer's, with `aud: "convex"` as the dashboard's integration sets it.
 */
const CLERK = `
  const who = () => window.__aff.identity;
  const user = () => { const w = who(); return w && { id: w.userId, fullName: w.name, primaryEmailAddress: { emailAddress: w.userId + "@e2e.test" }, imageUrl: "" }; };
  export function useUser() { const u = user(); return { isLoaded: true, isSignedIn: Boolean(u), user: u }; }
  export function useAuth() {
    const w = who();
    return {
      isLoaded: true, isSignedIn: Boolean(w), userId: w ? w.userId : null, sessionId: w ? "sess_" + w.userId : null,
      orgId: null, orgRole: null, sessionClaims: w ? { aud: "convex" } : null,
      getToken: async () => window.__aff.jwt,
    };
  }
  export function useClerk() {
    return {
      isSignedIn: Boolean(who()), user: user(),
      addListener() { return () => {}; },
      openSignIn() {}, signOut: async () => {},
      client: { signIn: { authenticateWithRedirect() {} } },
    };
  }
`;

/** PostHog, loaded as `bootAnalytics` loads it, recording what it is asked. */
const POSTHOG = `
  const calls = (window.__posthog ??= []);
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  export default {
    init: record("init"), identify: record("identify"), setPersonProperties: record("setPersonProperties"),
    capture: record("capture"), startSessionRecording: record("startSessionRecording"), reset: record("reset"),
    register: record("register"),
  };
`;

const { failures, check, finish } = ledger();
let deployment, browser, server, work;
const tabs = {};
const watchdog = setTimeout(async () => {
  console.error("\nwatchdog: no verdict after 8 minutes; tearing down");
  await Promise.race([Promise.all([browser?.close().catch(() => {}), deployment?.close().catch(() => {})]), wait(10_000)]);
  process.exit(2);
}, 8 * 60_000);
watchdog.unref();

try {
  await mkdir(shots, { recursive: true });
  work = await mkdtemp(path.join(tmpdir(), "affiliates-"));
  const SECRET = randomBytes(32).toString("hex");
  const standInKey = signingPair();
  const operator = { user: "ops-e2e", password: randomBytes(12).toString("hex") };
  deployment = await startBackend({
    name: "affiliates",
    env: {
      AFFILIATE_CLICK_SECRET: SECRET,
      IMPERSONATION_PRIVATE_KEY: standInKey.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      IMPERSONATION_JWKS: JSON.stringify(standInKey.jwks),
      ADMIN_USER: operator.user,
      ADMIN_PASSWORD: operator.password,
    },
  });
  const CONVEX_URL = deployment.url;
  const jwt = Object.fromEntries(Object.entries(PEOPLE).map(([key, who]) => [key, deployment.mint(who.userId, who.name)]));
  const as = (who) => deployment.client(jwt[who]);
  const admin = new ConvexHttpClient(CONVEX_URL);
  admin.setAdminAuth(deployment.adminKey);
  const table = async (name) =>
    (await admin.query(makeFunctionReference("_system/cli/tableData"), { table: name, order: "asc", paginationOpts: { numItems: 1000, cursor: null } })).page;
  const patch = (name, ids, fields) => admin.mutation(makeFunctionReference("_system/frontend/patchDocumentsFields"), { table: name, ids, fields });

  // ── The affiliates, as ops would make them ─────────────────────────────────
  const now = Date.now();
  await admin.mutation(makeFunctionReference("_system/frontend/addDocument"), {
    table: "affiliates",
    documents: [
      { ...NINA, createdAt: now },
      { ...BEN, createdAt: now },
      { ...DEE, createdAt: now, disabledAt: now },
    ],
  });
  const affiliates = Object.fromEntries((await table("affiliates")).map((a) => [a.slug, a]));
  check("three affiliates seeded", Object.keys(affiliates).sort(), [BEN.slug, DEE.slug, NINA.slug].sort());

  /** Everyone who has been here before the story starts: a profile, their identity, a project. */
  async function settled(who) {
    await as(who).mutation(anyApi.profiles.skip, {});
    await as(who).action(anyApi.identity.sync, {});
    for (const id of ["chat", "slash", "write"]) await as(who).mutation(anyApi.profiles.seen, { id });
    await as(who).mutation(anyApi.projects.create, { title: `${PEOPLE[who].name}'s plans` });
  }
  for (const who of ["eli", "olive", "oscar"]) await settled(who);

  // ── The route, bundled for Node as Next compiles it ────────────────────────
  const routeFile = path.join(work, "route.mjs");
  await build({
    absWorkingDir: repo, entryPoints: ["app/r/[slug]/route.ts"], bundle: true, format: "esm", platform: "node",
    outfile: routeFile, tsconfig: "tsconfig.json", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' },
    // Next's own server helpers are CommonJS and reach for these.
    banner: { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));" },
  });
  process.env.NEXT_PUBLIC_CONVEX_URL = CONVEX_URL;
  process.env.AFFILIATE_CLICK_SECRET = SECRET;
  const route = await import(pathToFileURL(routeFile).href);

  // ── The app, bundled from app/ ─────────────────────────────────────────────
  const output = path.join(work, "bundle");
  await bundleSurfaces("tests/affiliates.fullstack.tsx", output, {
    probe: false, fixtures: { clerk: CLERK, navigation: NAVIGATION, posthog: POSTHOG }, aliases: { "posthog-js": "posthog" },
  });

  /** Every `/r` response the route gave, as it went over the wire. */
  const served = [];
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const slug = /^\/r\/([^/]+)\/?$/.exec(url.pathname)?.[1];
      if (slug !== undefined) {
        const method = request.method === "HEAD" ? "HEAD" : "GET";
        const answer = await route[method](
          new Request(`http://${request.headers.host}${request.url}`, { method, headers: request.headers }),
          { params: Promise.resolve({ slug: decodeURIComponent(slug) }) },
        );
        const location = answer.headers.get("location");
        served.push({ path: url.pathname, method, status: answer.status, location, cacheControl: answer.headers.get("cache-control"), setCookie: answer.headers.getSetCookie() });
        // The one change on the way out: our sites are stood in for on this
        // origin, since a browser follows a redirect without asking the
        // harness. The real location is what `served` recorded.
        const headers = [...answer.headers.entries()]
          .filter(([key]) => key !== "set-cookie")
          .map(([key, value]) => [key, key === "location" && SITES.test(value) ? `/__site?to=${encodeURIComponent(value)}` : value])
          .concat(answer.headers.getSetCookie().map((cookie) => ["set-cookie", cookie]));
        response.writeHead(answer.status, headers.flat());
        return void response.end(method === "HEAD" ? undefined : Buffer.from(await answer.arrayBuffer()));
      }
      if (url.pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
      if (url.pathname === "/__site") {
        response.writeHead(200, { "content-type": "text/html" });
        return void response.end("<!doctype html><title>Nootles</title><h1>Plan it all in one place.</h1>");
      }
      const file = url.pathname === "/" || !path.extname(url.pathname) ? "index.html" : path.basename(url.pathname);
      const data = await readFile(path.join(output, file));
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
      response.end(data);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error?.code === "ENOENT" ? 404 : 500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();

  // ── What a visitor's browser is ────────────────────────────────────────────
  /**
   * A visitor's browser, clicking `slug`'s link from somewhere else on the
   * web. The sites a link may land on are answered in the tab, and recorded.
   * Returns the tab once it has landed; it is nobody until `signIn`.
   */
  async function visitor(label, slug) {
    const attributeCalls = [];
    const tab = await guardedTab(browser, {
      origin, allow: [CONVEX_URL], label, failures, path: `/r/${slug}`,
      setup: async (context, page) => {
        context.setDefaultTimeout(20_000);
        context.setDefaultNavigationTimeout(30_000);
        page.on("response", (answer) => {
          if (answer.status() >= 400) failures.push(`[${label}] ${answer.status()} for ${answer.url()}`);
        });
        // Nobody signed in yet, and the app's public env as Next inlines it.
        await page.addInitScript((cfg) => {
          window.__aff ??= { identity: null, jwt: null };
          globalThis.process = { env: { NODE_ENV: "development", NEXT_PUBLIC_CONVEX_URL: cfg.url, NEXT_PUBLIC_POSTHOG_KEY: "phc_fixture" }, browser: true };
        }, { url: CONVEX_URL });
        page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
          if (String(payload).includes('"affiliates:attribute"')) attributeCalls.push(Date.now());
        }));
      },
    });
    tabs[label] = tab;
    // Unfiltered: asked by URL, Playwright hides a Secure cookie from http://127.0.0.1,
    // which Chrome itself treats as secure and sends it to.
    const cookie = async () => (await tab.context.cookies()).find((c) => c.name === "nt_ref") ?? null;
    /** Where the tab landed, as the route sent it. */
    const landed = () => {
      const at = new URL(tab.page.url());
      return at.pathname === "/__site" ? at.searchParams.get("to") : at.href;
    };
    return {
      ...tab, attributeCalls, cookie, landed,
      /** Clicks another link in the same browser. */
      click: (next) => tab.page.goto(`${origin}/r/${next}`, { waitUntil: "domcontentloaded" }),
      /** Signs in as `who` (Clerk's session) and opens the app at `at`. */
      async signIn(who, at = "/") {
        await tab.page.addInitScript((cfg) => { window.__aff = cfg; }, { identity: PEOPLE[who], jwt: jwt[who] });
        await tab.page.goto(origin + at, { waitUntil: "domcontentloaded" });
      },
    };
  }

  const waitFor = async (what, fn, timeout = 15_000) => {
    const until = Date.now() + timeout;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > until) return null;
      await wait(150);
    }
  };
  const attributionOf = async (who) => (await table("affiliateAttributions")).find((a) => a.ownerId === PEOPLE[who].userId) ?? null;
  const visitsOf = async (slug) => (await table("affiliateVisits")).filter((v) => v.affiliateId === affiliates[slug]._id);
  const visit = async (slug, visitorId) => (await visitsOf(slug)).find((v) => v.visitorId === visitorId) ?? null;
  const cookieRef = (c) => {
    const [slug, visitorId, at] = c.value.split(".");
    return { slug, visitorId, clickedAt: Number(at) };
  };
  const posthogCalls = (page, name) => page.evaluate((n) => (window.__posthog ?? []).filter((c) => c[0] === n).map((c) => c.slice(1)), name);
  const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

  // ── a. Nia, brand new ──────────────────────────────────────────────────────
  {
    console.log("\na. Nia, brand new, clicks Nina's link and signs up");
    const tab = await visitor("nia", "nina");
    const response = served.at(-1);
    check("[route] a 307 to Nina's destination, not cached", [response.status, response.location, response.cacheControl], [307, NINA.destination, "no-store"]);
    check("[nia] lands on Nina's destination", tab.landed(), NINA.destination);
    const cookie = await tab.cookie();
    const ref = cookie && cookieRef(cookie);
    check("[nia] the route left nt_ref naming Nina's slug", ref?.slug, NINA.slug);
    check("[nia] …on this host only, for the whole site, readable by the page, Lax, Secure (production)",
      cookie && { domain: cookie.domain, path: cookie.path, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, secure: cookie.secure },
      { domain: "127.0.0.1", path: "/", httpOnly: false, sameSite: "Lax", secure: true });
    check("[nia] …for 30 days", cookie && Math.abs(cookie.expires - (Date.now() / 1000 + WINDOW_S)) < 120, true);
    const counted = await visit(NINA.slug, ref?.visitorId);
    check("[server] her click counted: one visit, first and last at the cookie's click", counted && [counted.clicks, counted.firstAt === counted.lastAt], [1, true]);
    check("[server] …the cookie's click time within a second of the server's", counted && Math.abs(counted.firstAt - ref.clickedAt) < 1000, true);

    await tab.signIn("nia");
    const attributed = await waitFor("attribution", () => attributionOf("nia"));
    check("[server] Nia is attributed to Nina, by link, from her visit", attributed && {
      affiliate: attributed.affiliateId === affiliates[NINA.slug]._id, via: attributed.via, visitorId: attributed.visitorId, clickedAt: attributed.clickedAt,
    }, { affiliate: true, via: "link", visitorId: ref?.visitorId, clickedAt: counted?.lastAt });
    const cleared = await waitFor("cookie cleared", async () => (await tab.cookie()) === null);
    check("[nia] the cookie is gone once it is claimed", cleared, true);
    await tab.page.waitForFunction(() => (window.__posthog ?? []).some((c) => c[0] === "setPersonProperties"), null, { timeout: 15_000 }).catch(() => {});
    check("[nia] PostHog is told once, $set_once: { affiliate }", await posthogCalls(tab.page, "setPersonProperties"), [[null, { affiliate: NINA.slug }]]);
    check("[nia] …the same person the app identified", [...new Set((await posthogCalls(tab.page, "identify")).map((c) => c[0]))], [PEOPLE.nia.userId]);
    check("[nia] the app asked once", tab.attributeCalls.length, 1);
    // She reloads: nothing left to claim.
    await tab.page.reload({ waitUntil: "domcontentloaded" });
    await tab.page.waitForFunction(() => location.pathname === "/welcome", null, { timeout: 15_000 }).catch(() => {});
    await wait(1500);
    check("[nia] a reload asks nothing more", tab.attributeCalls.length, 1);
    check("[nia] the welcome screen, as any new account's", tab.page.url(), `${origin}/welcome`);
    await shot(tab.page, "a-nia-welcome");
    await tab.context.close();
  }

  // ── b. Eli, already here; Ivy, just arrived ────────────────────────────────
  {
    console.log("\nb. Eli, who has used Nootles for a while, clicks it");
    const tab = await visitor("eli", "nina");
    const ref = cookieRef(await tab.cookie());
    const counted = await visit(NINA.slug, ref.visitorId);
    // His click, eleven minutes after everything he had already done here.
    await patch("affiliateVisits", [counted._id], { firstAt: counted.firstAt + 11 * 60_000, lastAt: counted.lastAt + 11 * 60_000 });
    await tab.signIn("eli");
    await tab.page.getByText(`${PEOPLE.eli.name}'s plans`).first().waitFor({ timeout: 20_000 });
    const cleared = await waitFor("cookie cleared", async () => (await tab.cookie()) === null);
    check("[eli] the app asked once", tab.attributeCalls.length, 1);
    check("[server] Eli is not attributed: his account is older than the click", await attributionOf("eli"), null);
    check("[eli] the cookie is gone all the same", cleared, true);
    check("[eli] PostHog is not tagged", await posthogCalls(tab.page, "setPersonProperties"), []);
    await shot(tab.page, "b-eli-projects");
    await tab.context.close();

    console.log("\nb'. Ivy signed up minutes before her click (the control)");
    await settled("ivy");
    const ivy = await visitor("ivy", "nina");
    await ivy.signIn("ivy");
    const hers = await waitFor("attribution", () => attributionOf("ivy"));
    check("[server] Ivy is attributed: within ten minutes of her click counts as new", hers?.affiliateId === affiliates[NINA.slug]._id, true);
    check("[ivy] the cookie is gone", await waitFor("cookie cleared", async () => (await ivy.cookie()) === null), true);
    await ivy.context.close();
  }

  // ── c. An operator standing in ─────────────────────────────────────────────
  {
    console.log("\nc. Oscar clicks it, then stands in for Sam");
    // Sam signed up moments ago: if anything claimed for him, it would count.
    await settled("sam");
    const tab = await visitor("oscar", "nina");
    const before = await tab.cookie();
    const opsToken = await deployment.client(null).mutation(anyApi.admin.login, { username: operator.user, password: operator.password });
    const { token: standIn } = await deployment.client(null).action(anyApi.impersonationMint.start, { token: opsToken, subject: PEOPLE.sam.userId, reason: "affiliates e2e" });
    await tab.context.addCookies([{ name: "nt_imp", value: standIn, url: origin, sameSite: "Strict" }]);
    await tab.signIn("oscar");
    await tab.page.getByText(`${PEOPLE.sam.name}'s plans`).first().waitFor({ timeout: 20_000 });
    await tab.page.locator(".nt-imp").waitFor({ timeout: 10_000 });
    await wait(3000);
    check("[oscar] standing in, the app never asks", tab.attributeCalls.length, 0);
    check("[server] …Sam is not attributed", await attributionOf("sam"), null);
    check("[server] …nor is Oscar", await attributionOf("oscar"), null);
    check("[oscar] his cookie stays, as it was", (await tab.cookie())?.value, before.value);
    const refused = await deployment.client(standIn).mutation(anyApi.affiliates.attribute, { ref: before.value }).then(() => "accepted", (e) => String(e.message));
    check("[server] had it asked, the stand-in's write is refused", /Read-only/.test(refused), true);
    await shot(tab.page, "c-oscar-standing-in");
    await tab.context.close();
  }

  // ── d. Links that go nowhere in particular ─────────────────────────────────
  {
    console.log("\nd. Una clicks Nina's link, then an unknown one, a disabled one, and one that can't be");
    const tab = await visitor("una", "nina");
    const kept = (await tab.cookie())?.value;
    const visitsBefore = (await table("affiliateVisits")).length;
    await tab.click("nobody-here");
    check("[unknown] lands on the default destination", tab.landed(), DEFAULT);
    await tab.click(DEE.slug);
    check("[disabled] Dee's link lands on the default, not her destination", tab.landed(), DEFAULT);
    await tab.click("x");
    check("[junk] a slug that can't be one lands on the default", tab.landed(), DEFAULT);
    check("[route] each redirected, uncached, and set no cookie",
      served.slice(-3).map((s) => [s.status, s.location, s.cacheControl, s.setCookie]),
      [[307, DEFAULT, "no-store", []], [307, DEFAULT, "no-store", []], [307, DEFAULT, "no-store", []]]);
    check("[una] her cookie still names Nina's click", (await tab.cookie())?.value, kept);
    check("[server] none of them counted a visit", (await table("affiliateVisits")).length, visitsBefore);
    check("[server] …nor a day for Dee", (await table("affiliateDays")).filter((d) => d.affiliateId === affiliates[DEE.slug]._id), []);
    // Links that could not count do not take her from the one that did.
    await tab.signIn("una");
    const attributed = await waitFor("attribution", () => attributionOf("una"));
    check("[server] Una is Nina's", attributed?.affiliateId === affiliates[NINA.slug]._id, true);
    check("[una] the cookie is gone", await waitFor("cookie cleared", async () => (await tab.cookie()) === null), true);
    await tab.context.close();
  }

  // ── e. Forged clicks ───────────────────────────────────────────────────────
  {
    console.log("\ne. recordClick called straight over HTTP");
    const anyone = deployment.client(null);
    const sign = (secret, slug, visitorId, signedAt) => createHmac("sha256", secret).update(JSON.stringify([slug, visitorId, signedAt])).digest("hex");
    const attempt = async (name, visitorId, signedAt, signature) => {
      const before = (await visitsOf(NINA.slug)).length;
      const { destination } = await anyone.mutation(anyApi.affiliates.recordClick, { slug: NINA.slug, visitorId, signedAt, signature });
      return { name, destination, counted: (await visitsOf(NINA.slug)).length - before };
    };
    const at = Date.now();
    const results = [
      await attempt("no signature", randomUUID(), at, ""),
      await attempt("zeros", randomUUID(), at, "0".repeat(64)),
      await attempt("the wrong secret", ...((id) => [id, at, sign("not-the-secret", NINA.slug, id, at)])(randomUUID())),
      await attempt("eleven minutes stale", ...((id) => [id, at - 11 * 60_000, sign(SECRET, NINA.slug, id, at - 11 * 60_000)])(randomUUID())),
      await attempt("two minutes ahead", ...((id) => [id, at + 120_000, sign(SECRET, NINA.slug, id, at + 120_000)])(randomUUID())),
      await attempt("a visitor that isn't a UUID", "visitor-1", at, sign(SECRET, NINA.slug, "visitor-1", at)),
      await attempt("another slug's signature", ...((id) => [id, at, sign(SECRET, BEN.slug, id, at)])(randomUUID())),
    ];
    for (const r of results) check(`[forger] ${r.name}: told the destination, nothing counted`, [r.destination, r.counted], [NINA.destination, 0]);
    const control = await attempt("signed as the route signs", ...((id) => [id, at, sign(SECRET, NINA.slug, id, at)])(randomUUID()));
    check("[control] the route's own signature, computed here, counts", control.counted, 1);
  }

  // ── f. Last click wins ─────────────────────────────────────────────────────
  {
    console.log("\nf. Fay clicks Nina's link, then Ben's");
    const tab = await visitor("fay", "nina");
    const first = cookieRef(await tab.cookie());
    await tab.click(BEN.slug);
    check("[fay] lands on Ben's destination", tab.landed(), BEN.destination);
    const second = cookieRef(await tab.cookie());
    check("[fay] the cookie now names Ben, same visitor", [second.slug, second.visitorId], [BEN.slug, first.visitorId]);
    check("[server] one visitor, a visit on each link", [Boolean(await visit(NINA.slug, first.visitorId)), Boolean(await visit(BEN.slug, first.visitorId))], [true, true]);
    await tab.signIn("fay");
    const attributed = await waitFor("attribution", () => attributionOf("fay"));
    check("[server] Fay is Ben's", attributed && [attributed.affiliateId === affiliates[BEN.slug]._id, attributed.visitorId], [true, first.visitorId]);
    await tab.page.waitForFunction(() => (window.__posthog ?? []).some((c) => c[0] === "setPersonProperties"), null, { timeout: 15_000 }).catch(() => {});
    check("[fay] PostHog tags her Ben's", await posthogCalls(tab.page, "setPersonProperties"), [[null, { affiliate: BEN.slug }]]);
    check("[fay] the cookie is gone", await waitFor("cookie cleared", async () => (await tab.cookie()) === null), true);
    await tab.context.close();
  }

  // ── g. A share link first ──────────────────────────────────────────────────
  {
    console.log("\ng. Gia clicks, then opens a share link before anything else");
    const projectId = await as("olive").mutation(anyApi.projects.create, { title: "Shared plan" });
    const token = await as("olive").mutation(anyApi.share.setLink, { projectId, role: "viewer", enabled: true, expiresInDays: null });
    const tab = await visitor("gia", "nina");
    // The share route claims first — it writes her profile — then the app loads.
    await as("gia").mutation(anyApi.share.claim, { token });
    const profile = (await table("profiles")).find((p) => p.ownerId === PEOPLE.gia.userId);
    check("[server] the share claim wrote Gia's profile first", Boolean(profile), true);
    await tab.signIn("gia", `/share/${token}`);
    const attributed = await waitFor("attribution", () => attributionOf("gia"));
    check("[server] Gia is Nina's all the same", attributed?.affiliateId === affiliates[NINA.slug]._id, true);
    check("[server] …her profile older than the attribution", profile && attributed && profile._creationTime < attributed.attributedAt, true);
    check("[gia] the cookie is gone", await waitFor("cookie cleared", async () => (await tab.cookie()) === null), true);
    await shot(tab.page, "g-gia-shared");
    await tab.context.close();
  }

  // ── h. Not clicks ──────────────────────────────────────────────────────────
  {
    console.log("\nh. a HEAD, a browser prefetch and a chat app's link preview");
    const dayOf = async () => (await table("affiliateDays")).filter((d) => d.affiliateId === affiliates[NINA.slug]._id).reduce((n, d) => n + d.clicks, 0);
    const before = await dayOf();
    const head = await fetch(`${origin}/r/${NINA.slug}`, { method: "HEAD", redirect: "manual" });
    check("[unfurler] HEAD is told where the link goes, with no cookie", [head.status, served.at(-1).method, served.at(-1).location, head.headers.getSetCookie()], [307, "HEAD", NINA.destination, []]);
    const prefetch = await fetch(`${origin}/r/${NINA.slug}`, { redirect: "manual", headers: { "Sec-Purpose": "prefetch" } });
    check("[prefetch] turned away, uncached, with no cookie", [prefetch.status, prefetch.headers.get("cache-control"), prefetch.headers.getSetCookie()], [503, "no-store", []]);
    const preview = await fetch(`${origin}/r/${NINA.slug}`, { redirect: "manual", headers: { "User-Agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" } });
    check("[preview] Slack's unfurl is told where the link goes, with no cookie", [preview.status, served.at(-1).location, preview.headers.getSetCookie()], [307, NINA.destination, []]);
    check("[server] none of them counted a click", await dayOf(), before);
  }

  // ── The books ──────────────────────────────────────────────────────────────
  {
    console.log("\nthe books");
    const visits = await table("affiliateVisits");
    const days = await table("affiliateDays");
    for (const slug of [NINA.slug, BEN.slug]) {
      const mine = visits.filter((v) => v.affiliateId === affiliates[slug]._id);
      const day = days.filter((d) => d.affiliateId === affiliates[slug]._id);
      check(`[server] ${slug}: the day's clicks and visitors are its visits'`, [day.reduce((n, d) => n + d.clicks, 0), day.reduce((n, d) => n + d.visitors, 0)], [mine.reduce((n, v) => n + v.clicks, 0), mine.length]);
    }
    const attributions = await table("affiliateAttributions");
    check("[server] exactly the five new accounts are attributed", attributions.map((a) => a.ownerId).sort(), ["user_fay", "user_gia", "user_ivy", "user_nia", "user_una"]);
  }

  check("the backend reached nothing outside it", deployment.outbound, []);
} catch (error) {
  failures.push(`run aborted: ${error.stack ?? error}`);
  console.error(error);
  for (const [label, tab] of Object.entries(tabs)) await tab.page.screenshot({ path: path.join(shots, `failed-${label}.png`) }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  server?.close();
  server?.closeAllConnections?.();
  await Promise.race([deployment?.close(), wait(5000)]);
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
}
finish();
