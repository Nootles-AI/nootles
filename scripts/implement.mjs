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
 *
 * The last two commands serve the attended routine (`.claude/skills/ticket`),
 * where a person picked the ticket and is reading the diff as it is written.
 * They are outside the ledger entirely — no run, no session, no recorded
 * attempt — because a session someone sat through is not the machine's night
 * work, and the Agent page should not say it was.
 *
 *   node scripts/implement.mjs show <number>
 *   node scripts/implement.mjs check [number] [body-file]
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const WORK = path.resolve(".implement");
const STATE = path.join(WORK, "state.json");
const SHOTS = path.join(WORK, "shots");

/**
 * Paths the agent may not touch, mirroring docs/agent-allowlist.md — which is
 * the prose; this is the enforcement. Keep them in step.
 *
 * Note what is NOT here: the canvas. Fencing it off was the first draft of this
 * list and it was a mistake — most of the backlog lives there, so the routine
 * spent its budget declining work it could never do. What remains is the code
 * that decides what the agent may do, and the code whose failures a reviewer
 * cannot see in a diff.
 */
const DENY = [
  /^convex\/schema\.ts$/,
  /^convex\/migrations\.ts$/,
  /^convex\/auth\.ts$/,
  /^convex\/admin\.ts$/,
  /^app\/lib\/ai\/apply\.ts$/,
  /^app\/lib\/ai\/review\//,
  /^\.github\//,
  /^\.claude\//,
  /^scripts\//,
  /^docs\/(agent-allowlist|triage-rubric)\.md$/,
  /^instrumentation.*\.ts$/,
  /^proxy\.ts$/,
  /^package(-lock)?\.json$/,
];

/**
 * Canvas files with an invariant nothing checks: `serialize(parse(html))` must
 * equal `html`, because that round-trip is how the AI layer edits diagrams.
 * Allowed, but a change here has to argue for itself in the PR body.
 */
const ROUND_TRIP = [
  /^app\/components\/editor\/canvas\/scene\/(serialize|parse)\.ts$/,
  /^app\/components\/editor\/canvas\/scene\/types\.ts$/,
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
 * `NT-{n}_{slug}` is a convention now, not a key: nothing reads it back, so a
 * branch named some other way costs a reviewer the ticket rather than costing
 * the ticket a link. It is still spelled in exactly one place, because a
 * convention nobody can assemble consistently is not one. The slug is
 * normalised rather than validated: rejecting "Fix the canvas!" helps nobody
 * when `fix_the_canvas` is obviously what was meant.
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

/**
 * The round-trip files, if this change touches any. Not a refusal — the caller
 * requires the PR body to have addressed them, since no test will.
 */
function roundTripFiles(files) {
  return files.filter((f) => ROUND_TRIP.some((re) => re.test(f)));
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

  const files = changedFiles();
  const touched = roundTripFiles(files);
  const unaddressed =
    touched.length > 0 &&
    !/round.?trip/i.test(readFileSync(bodyFile, "utf8"));

  const refusal =
    checkPaths(files) ??
    (unaddressed
      ? `changes the canvas round-trip (${touched.join(", ")}) without the PR body saying how serialize(parse(html)) === html still holds`
      : null) ??
    checkGates();
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

  // The attempt, and nothing else. Nootles used to keep a row per pull request
  // and poll GitHub to age it; it no longer knows GitHub exists, so what gets
  // written back is the one fact this process is the authority on — that it
  // tried, and filed. The URL is reported here, to the operator reading the
  // run, rather than stored.
  await mutation("admin:feedbackRecordAgentAttempt", {
    token: state.token,
    id: await idOf(state.token, n),
    outcome: "filed",
    runId: state.runId,
    now: Date.now(),
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

// ---- The attended commands -------------------------------------------------

/**
 * One named ticket, with everything known about it.
 *
 * The queue's gates — the score threshold, the cooling window, `agentSkip`, a
 * previous attempt — are not applied here. They keep an unattended routine off
 * work it cannot judge, and someone asking for this ticket by name has already
 * made that judgement. They are reported instead, since why the nightly
 * routine passed a ticket over is worth knowing before you take it.
 */
async function show(number) {
  const n = Number(number);
  const { user, password } = credentials();
  const token = await mutation("admin:login", { username: user, password });
  try {
    const t = await query("admin:feedbackByNumber", { token, number: n });
    if (!t) {
      console.error(`implement: NT-${n} does not exist.`);
      process.exit(2);
    }

    let screenshot = null;
    if (t.screenshotUrl) {
      try {
        const res = await fetch(t.screenshotUrl);
        if (res.ok) {
          await mkdir(SHOTS, { recursive: true });
          screenshot = path.join(SHOTS, `NT-${n}.png`);
          await writeFile(screenshot, Buffer.from(await res.arrayBuffer()));
        }
      } catch {
        screenshot = null;
      }
    }

    console.log(
      JSON.stringify(
        {
          number: n,
          name: canonicalName(n, ""),
          status: t.status,
          kind: t.kind,
          category: t.category ?? "general",
          priority: t.priority ?? null,
          text: t.text,
          reporter: t.email ?? t.ownerId,
          filedAt: new Date(t.createdAt).toISOString(),
          triageScore: t.triageScore ?? null,
          triageNotes: t.triageNotes ?? null,
          agentSkip: t.agentSkip ?? false,
          agentOutcome: t.agentOutcome ?? null,
          duplicateOf: t.duplicateOfNumber
            ? canonicalName(t.duplicateOfNumber, "")
            : null,
          duplicates: t.duplicateNumbers.map((d) => canonicalName(d, "")),
          prs: t.prs.map((p) => ({
            title: p.title,
            url: p.url,
            state: p.state,
            agentFiled: p.agentFiled,
          })),
          consoleLog: t.consoleLog ?? null,
          recentOps: t.recentOps ?? null,
          env: t.env,
          screenshot,
        },
        null,
        2,
      ),
    );
  } finally {
    await mutation("admin:logout", { token });
  }
}

/**
 * Everything `file` would refuse over, said out loud instead.
 *
 * The attended routine opens its own pull request, because the person driving
 * it is the review the deny list stands in for at night. What is mechanical
 * stays mechanical though: `tsc` and `eslint` are the floor either way, and the
 * rest — a denied path, a diff too wide to be one ticket, an unargued canvas
 * round-trip — is better heard here than from a reviewer.
 */
function check(number, bodyFile) {
  const files = changedFiles();
  const blocking = [];
  const advisory = [];

  if (files.length === 0) {
    // Both this and the pull request read committed history, so uncommitted
    // work looks identical to no work. Say which one it is.
    const dirty = sh("git", ["status", "--porcelain"]).trim();
    blocking.push(
      dirty
        ? "nothing is committed on this branch — the pull request would be empty"
        : "the branch changes nothing",
    );
  }
  const gates = checkGates();
  if (gates) blocking.push(gates);

  const denied = files.filter((f) => DENY.some((re) => re.test(f)));
  if (denied.length) {
    advisory.push(
      `touches what the nightly routine may not: ${denied.join(", ")} — docs/agent-allowlist.md says why, and the pull request body should answer it`,
    );
  }
  if (files.length > MAX_FILES) {
    advisory.push(
      `changes ${files.length} files, over the ${MAX_FILES} a ticket fix should need`,
    );
  }

  const touched = roundTripFiles(files);
  const body =
    bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, "utf8") : "";
  if (touched.length && !/round.?trip/i.test(body)) {
    advisory.push(
      `changes the canvas round-trip (${touched.join(", ")}) without the body saying how serialize(parse(html)) === html still holds`,
    );
  }

  if (number) {
    const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (!new RegExp(`^NT-${Number(number)}(?:_|$)`, "i").test(branch)) {
      advisory.push(
        `on branch "${branch}", which does not begin "NT-${Number(number)}_" — nothing links a pull request to its ticket automatically any more, so the name is the only thing that says which ticket this is`,
      );
    }
  }

  console.log(JSON.stringify({ files, blocking, advisory }, null, 2));
  if (blocking.length) process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "start") await start();
  else if (command === "name") name(rest[0], rest[1]);
  else if (command === "file") await file(rest[0], rest[1], rest[2]);
  else if (command === "decline") await record(rest[0], "declined", rest[1]);
  else if (command === "fail") await record(rest[0], "failed", rest[1]);
  else if (command === "finish") await finish(rest[0]);
  else if (command === "show") await show(rest[0]);
  else if (command === "check") check(rest[0], rest[1]);
  else {
    console.error(
      "usage: implement.mjs start | name <n> <slug> | file <n> <slug> <body> | decline <n> <why> | fail <n> <why> | finish [file] | show <n> | check [n] [body]",
    );
    process.exit(2);
  }
} catch (e) {
  console.error(`implement: ${e.message}`);
  process.exit(1);
}
