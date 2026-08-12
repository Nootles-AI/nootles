#!/usr/bin/env node
/**
 * The deterministic half of the nightly implement routine — and, unlike triage,
 * mostly a set of refusals.
 *
 * This routine writes code unattended against a repository with no test suite,
 * so everything that can be checked mechanically is checked here rather than
 * asked for in a prompt. `file` will not open a pull request unless:
 *
 *   - the ticket was actually handed out by `implementQueue`
 *   - the diff touches nothing on the deny list (docs/agent-allowlist.md)
 *   - the diff is not empty, and not implausibly large
 *   - `tsc --noEmit` passes
 *   - `eslint` passes
 *
 * and the title it opens with is computed here, never supplied. A prompt can
 * drift; a refusal cannot.
 *
 *   node scripts/implement.mjs start
 *   node scripts/implement.mjs name <number> <slug>
 *   node scripts/implement.mjs file <number> <slug> <body-file>
 *   node scripts/implement.mjs decline <number> <reason>
 *   node scripts/implement.mjs fail <number> <reason>
 *   node scripts/implement.mjs finish [file]
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const WORK = path.resolve(".implement");
const STATE = path.join(WORK, "state.json");
const SHOTS = path.join(WORK, "shots");

const REPO = "ahosseini06/nootles";

/**
 * Paths the agent may not touch, mirroring docs/agent-allowlist.md — which is
 * the prose; this is the enforcement. Keep them in step.
 */
const DENY = [
  /^app\/components\/editor\/canvas\//,
  /^convex\/schema\.ts$/,
  /^convex\/migrations\.ts$/,
  /^convex\/auth\.ts$/,
  /^convex\/admin\.ts$/,
  /^app\/lib\/ai\/apply\.ts$/,
  /^app\/lib\/ai\/review\//,
  /^\.github\//,
  /^scripts\//,
  /^instrumentation.*\.ts$/,
  /^proxy\.ts$/,
  /^package(-lock)?\.json$/,
  /^\.claude\//,
  /^docs\/agent-allowlist\.md$/,
];

/** A change touching more files than this is not a ticket fix. */
const MAX_FILES = 12;

// ---- Deployment plumbing ---------------------------------------------------

function fromEnvFile(key) {
  try {
    const line = readFileSync(".env.prod", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim() || null;
  } catch {
    return null;
  }
}

function fromConvexEnv(name) {
  try {
    return (
      execFileSync("npx", ["convex", "env", "get", name, "--prod"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n")
        .pop() || null
    );
  } catch {
    return null;
  }
}

let cached = null;
function credentials() {
  if (cached) return cached;
  const url = process.env.CONVEX_URL || fromEnvFile("NEXT_PUBLIC_CONVEX_URL");
  const user = process.env.ADMIN_USER || fromConvexEnv("ADMIN_USER");
  const password =
    process.env.ADMIN_PASSWORD || fromConvexEnv("ADMIN_PASSWORD");
  const missing = [
    !url && "CONVEX_URL",
    !user && "ADMIN_USER",
    !password && "ADMIN_PASSWORD",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`implement: could not resolve ${missing.join(", ")}.`);
    process.exit(2);
  }
  cached = { url, user, password };
  return cached;
}

async function call(kind, name, args) {
  const res = await fetch(`${credentials().url}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: name, args, format: "json" }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== "success") {
    throw new Error(`${name}: ${body.errorMessage ?? "failed"}`);
  }
  return body.value;
}

const query = (name, args) => call("query", name, args);
const mutation = (name, args) => call("mutation", name, args);

async function readState() {
  if (!existsSync(STATE)) {
    console.error("implement: no run in progress — `start` first.");
    process.exit(2);
  }
  return JSON.parse(await readFile(STATE, "utf8"));
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

// ---- Naming ----------------------------------------------------------------

/**
 * The one place a branch or pull-request title is spelled.
 *
 * `NT-{n}_{slug}` is what the poller matches on, so a title assembled by hand
 * somewhere else is a link silently not made. The slug is normalised rather
 * than validated: rejecting "Fix the canvas!" helps nobody when
 * `fix_the_canvas` is obviously what was meant.
 */
function canonicalName(number, slug) {
  const clean = String(slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`not a ticket number: ${number}`);
  }
  return `NT-${number}${clean ? `_${clean}` : ""}`;
}

// ---- The refusals ----------------------------------------------------------

/** Files this branch changes against main, as repo-relative paths. */
function changedFiles() {
  const base = sh("git", ["merge-base", "HEAD", "origin/main"]).trim();
  return sh("git", ["diff", "--name-only", base, "HEAD"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function checkPaths(files) {
  const blocked = files.filter((f) => DENY.some((re) => re.test(f)));
  if (blocked.length) {
    return `touches paths the agent may not change: ${blocked.join(", ")}`;
  }
  if (files.length === 0) return "the branch changes nothing";
  if (files.length > MAX_FILES) {
    return `changes ${files.length} files, over the ${MAX_FILES} a ticket fix should need`;
  }
  return null;
}

function checkGates() {
  for (const [label, cmd, args] of [
    ["tsc --noEmit", "npx", ["tsc", "--noEmit"]],
    ["eslint", "npm", ["run", "lint"]],
  ]) {
    try {
      sh(cmd, args);
    } catch (e) {
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().split("\n");
      return `${label} failed: ${out.slice(0, 6).join(" | ")}`;
    }
  }
  return null;
}

// ---- Commands --------------------------------------------------------------

async function start() {
  const open = existsSync(STATE)
    ? JSON.parse(await readFile(STATE, "utf8"))
    : null;

  let token = open?.token;
  if (!token) {
    const { user, password } = credentials();
    token = await mutation("admin:login", { username: user, password });
  }

  const now = Date.now();
  const queue = await query("admin:implementQueue", { token, now });

  if (!queue.enabled) {
    if (!open) await mutation("admin:logout", { token });
    console.log(
      JSON.stringify(
        {
          enabled: false,
          tickets: [],
          why: "the agent is off, or implementing is off, in the dashboard",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (queue.tickets.length === 0) {
    if (!open) await mutation("admin:logout", { token });
    console.log(JSON.stringify({ enabled: true, tickets: [] }, null, 2));
    return;
  }

  const runId =
    open?.runId ??
    (await mutation("admin:runStart", { token, kind: "implement", now }));
  await mkdir(SHOTS, { recursive: true });
  await writeFile(
    STATE,
    JSON.stringify({
      ...(open ?? {}),
      token,
      runId,
      startedAt: open?.startedAt ?? now,
      // Only these may be filed against this run.
      offered: [
        ...(open?.offered ?? []),
        ...queue.tickets.map((t) => t.number),
      ],
    }),
  );

  const tickets = [];
  for (const t of queue.tickets) {
    let screenshot = null;
    if (t.screenshotUrl) {
      try {
        const res = await fetch(t.screenshotUrl);
        if (res.ok) {
          screenshot = path.join(SHOTS, `NT-${t.number}.png`);
          await writeFile(screenshot, Buffer.from(await res.arrayBuffer()));
        }
      } catch {
        screenshot = null;
      }
    }
    tickets.push({
      number: t.number,
      name: canonicalName(t.number, ""),
      kind: t.kind,
      category: t.category ?? "general",
      text: t.text,
      triageScore: t.triageScore,
      triageNotes: t.triageNotes,
      consoleLog: t.consoleLog ?? null,
      recentOps: t.recentOps ?? null,
      screenshot,
    });
  }

  console.log(
    JSON.stringify(
      { enabled: true, runId, allowlist: "docs/agent-allowlist.md", tickets },
      null,
      2,
    ),
  );
}

/** The canonical branch and title, so nothing else has to spell them. */
function name(number, slug) {
  console.log(canonicalName(Number(number), slug));
}

/**
 * Open the pull request — after every check, or not at all.
 *
 * The refusal path deliberately records `failed` on the ticket: a change that
 * cannot pass its own gates is an attempt that happened, and leaving it
 * unrecorded would have the routine try it again tomorrow, identically.
 */
async function file(number, slug, bodyFile) {
  const state = await readState();
  const n = Number(number);

  if (!state.offered?.includes(n)) {
    console.error(
      `implement: NT-${n} was not handed out by implementQueue this run.`,
    );
    process.exit(2);
  }

  const title = canonicalName(n, slug);
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== title) {
    console.error(
      `implement: on branch "${branch}" but this ticket's branch is "${title}".`,
    );
    process.exit(2);
  }

  const refusal = checkPaths(changedFiles()) ?? checkGates();
  if (refusal) {
    await mutation("admin:feedbackRecordAgentAttempt", {
      token: state.token,
      id: await idOf(state.token, n),
      outcome: "failed",
      runId: state.runId,
      now: Date.now(),
    });
    await bump(state, { failed: 1, errors: [`NT-${n}: ${refusal}`] });
    console.error(`implement: refusing to file NT-${n} — ${refusal}`);
    process.exit(1);
  }

  sh("git", ["push", "-u", "origin", branch]);
  const url = sh("gh", [
    "pr",
    "create",
    "--title",
    title,
    "--body-file",
    bodyFile,
  ]).trim();
  const prNumber = Number(url.split("/").pop());

  const now = Date.now();
  const id = await idOf(state.token, n);
  await mutation("admin:feedbackAttachAgentPr", {
    token: state.token,
    id,
    repo: REPO,
    prNumber,
    title,
    url,
    now,
  });
  await mutation("admin:feedbackRecordAgentAttempt", {
    token: state.token,
    id,
    outcome: "filed",
    runId: state.runId,
    now,
  });
  await bump(state, { filed: 1 });
  console.log(JSON.stringify({ filed: true, title, url }, null, 2));
}

async function idOf(token, number) {
  const ticket = await query("admin:feedbackByNumber", { token, number });
  if (!ticket) throw new Error(`NT-${number} does not exist`);
  return ticket._id;
}

async function bump(state, { filed = 0, failed = 0, declined = 0, errors = [] }) {
  const now = JSON.parse(await readFile(STATE, "utf8"));
  await writeFile(
    STATE,
    JSON.stringify({
      ...now,
      filed: (now.filed ?? 0) + filed,
      failed: (now.failed ?? 0) + failed,
      declined: (now.declined ?? 0) + declined,
      attempted: (now.attempted ?? 0) + filed + failed + declined,
      errors: [...(now.errors ?? []), ...errors],
    }),
  );
}

/** Judged not worth attempting — a good outcome, and recorded as one. */
async function record(number, outcome, reason) {
  const state = await readState();
  const n = Number(number);
  await mutation("admin:feedbackRecordAgentAttempt", {
    token: state.token,
    id: await idOf(state.token, n),
    outcome,
    runId: state.runId,
    now: Date.now(),
  });
  await bump(state, {
    [outcome === "declined" ? "declined" : "failed"]: 1,
    errors: outcome === "failed" ? [`NT-${n}: ${reason ?? "failed"}`] : [],
  });
  console.log(JSON.stringify({ [outcome]: n, reason: reason ?? null }, null, 2));
}

async function finish(file) {
  const state = await readState();
  const extra = file ? JSON.parse(await readFile(file, "utf8")) : {};
  const errors = [...(state.errors ?? []), ...(extra.errors ?? [])];

  await mutation("admin:runFinish", {
    token: state.token,
    id: state.runId,
    status: extra.status ?? (errors.length ? "failed" : "ok"),
    ticketsRead: state.attempted ?? 0,
    duplicatesLinked: 0,
    scored: 0,
    prsFiled: state.filed ?? 0,
    errors,
    ...(extra.notes ? { notes: extra.notes } : {}),
    now: Date.now(),
  });
  await mutation("admin:logout", { token: state.token });
  await rm(WORK, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      { finished: true, filed: state.filed ?? 0, errors },
      null,
      2,
    ),
  );
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "start") await start();
  else if (command === "name") name(rest[0], rest[1]);
  else if (command === "file") await file(rest[0], rest[1], rest[2]);
  else if (command === "decline") await record(rest[0], "declined", rest[1]);
  else if (command === "fail") await record(rest[0], "failed", rest[1]);
  else if (command === "finish") await finish(rest[0]);
  else {
    console.error(
      "usage: implement.mjs start | name <n> <slug> | file <n> <slug> <body> | decline <n> <why> | fail <n> <why> | finish [file]",
    );
    process.exit(2);
  }
} catch (e) {
  console.error(`implement: ${e.message}`);
  process.exit(1);
}
