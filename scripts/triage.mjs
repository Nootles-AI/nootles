#!/usr/bin/env node
/**
 * The deterministic half of the nightly triage routine.
 *
 * Everything here is machinery: authenticating, asking the deployment what is
 * eligible, downloading the evidence, writing conclusions back, closing the
 * ledger. The judgment — is this a duplicate, how concrete is it — is the only
 * part left to the model, and it happens between `start` and `apply`.
 *
 * Deliberately no eligibility logic. What may be triaged is decided by
 * `admin:triageQueue` on the server, so neither this script nor the prompt
 * driving it can widen its own remit.
 *
 *   node scripts/triage.mjs start          # → work JSON on stdout
 *   node scripts/triage.mjs apply <file>   # ← [{number, score, notes, duplicateOf?}]
 *   node scripts/triage.mjs finish [file]  # ← {status?, errors?, notes?}
 *
 * Credentials resolve in three steps, so a local run needs no setup at all and
 * a scheduled one needs no Convex CLI: the environment first, then .env.prod
 * for the deployment URL, then `npx convex env get` for the admin pair. Set
 * CONVEX_URL, ADMIN_USER and ADMIN_PASSWORD to skip the fallbacks.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const WORK = path.resolve(".triage");
const STATE = path.join(WORK, "state.json");
const SHOTS = path.join(WORK, "shots");

/** A key out of .env.prod, which holds the deployment this dashboard reads. */
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

/**
 * A deployment env var, via the Convex CLI. Only reachable where someone has
 * logged that CLI in — which is to say locally, never in a scheduled run.
 */
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
  const url =
    process.env.CONVEX_URL || fromEnvFile("NEXT_PUBLIC_CONVEX_URL");
  const user = process.env.ADMIN_USER || fromConvexEnv("ADMIN_USER");
  const password =
    process.env.ADMIN_PASSWORD || fromConvexEnv("ADMIN_PASSWORD");

  const missing = [
    !url && "CONVEX_URL",
    !user && "ADMIN_USER",
    !password && "ADMIN_PASSWORD",
  ].filter(Boolean);
  if (missing.length) {
    console.error(
      `triage: could not resolve ${missing.join(", ")}. Set them in the ` +
        `environment, or run from the nootles repo with the Convex CLI logged in.`,
    );
    process.exit(2);
  }
  cached = { url, user, password };
  return cached;
}

/**
 * Convex's HTTP API. The admin functions take their session token as an
 * ordinary argument rather than an identity, which is what lets a plain POST
 * drive them — no SDK, no deploy key.
 */
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
    console.error("triage: no run in progress — `start` first.");
    process.exit(2);
  }
  return JSON.parse(await readFile(STATE, "utf8"));
}

/** The evidence a report carries, fetched to disk so the model can look. */
async function fetchShot(number, shotUrl) {
  if (!shotUrl) return null;
  try {
    const res = await fetch(shotUrl);
    if (!res.ok) return null;
    const file = path.join(SHOTS, `NT-${number}.png`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    // A screenshot that won't download is not a reason to skip the ticket.
    return null;
  }
}

/**
 * The next batch of work.
 *
 * Called repeatedly to drain the queue, so it reuses an open run rather than
 * starting a new one each time: a drain is one night's work and belongs in the
 * ledger as one row, however many batches it took. A run is only opened when
 * there is something to put in it.
 */
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
  const queue = await query("admin:triageQueue", { token, now });

  if (!queue.enabled) {
    // Not an error. The switch is off, so there is nothing to do tonight.
    if (!open) await mutation("admin:logout", { token });
    console.log(JSON.stringify({ enabled: false, tickets: [] }, null, 2));
    return;
  }

  if (queue.tickets.length === 0) {
    // Drained, or nothing was eligible to begin with. Only the second case has
    // no run to close, so only that one releases the session here.
    if (!open) await mutation("admin:logout", { token });
    console.log(
      JSON.stringify(
        { enabled: true, remaining: 0, tickets: [], digest: [] },
        null,
        2,
      ),
    );
    return;
  }

  const runId =
    open?.runId ??
    (await mutation("admin:runStart", { token, kind: "triage", now }));
  await mkdir(SHOTS, { recursive: true });
  await writeFile(
    STATE,
    JSON.stringify({ ...(open ?? {}), token, runId, startedAt: open?.startedAt ?? now }),
  );

  const digest = await query("admin:ticketDigest", { token, limit: 500 });

  const tickets = [];
  for (const t of queue.tickets) {
    tickets.push({
      number: t.number,
      kind: t.kind,
      category: t.category ?? "general",
      text: t.text,
      createdAt: new Date(t.createdAt).toISOString(),
      env: t.env,
      consoleLog: t.consoleLog ?? null,
      recentOps: t.recentOps ?? null,
      replayUrl: t.replayUrl ?? null,
      screenshot: await fetchShot(t.number, t.screenshotUrl),
    });
  }

  console.log(
    JSON.stringify(
      {
        enabled: true,
        runId,
        rubric: "docs/triage-rubric.md",
        remaining: queue.remaining,
        tickets,
        // Every other ticket, one line each, to recognise repeats against.
        digest: digest.filter((d) => !tickets.some((t) => t.number === d.number)),
      },
      null,
      2,
    ),
  );
}

async function apply(file) {
  const prior = await readState();
  const { token, runId } = prior;
  const results = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(results)) throw new Error("apply: expected a JSON array");

  const now = Date.now();
  let scored = 0;
  let duplicatesLinked = 0;
  const errors = [];

  for (const r of results) {
    try {
      const ticket = await query("admin:feedbackByNumber", {
        token,
        number: r.number,
      });
      if (!ticket) throw new Error(`NT-${r.number} does not exist`);

      // The duplicate link first: a ticket that repeats another still gets its
      // score, so unlinking it later leaves something behind.
      if (r.duplicateOf != null) {
        const target = await query("admin:feedbackByNumber", {
          token,
          number: r.duplicateOf,
        });
        if (!target) throw new Error(`NT-${r.duplicateOf} does not exist`);
        await mutation("admin:feedbackSetDuplicateByAgent", {
          token,
          id: ticket._id,
          duplicateOf: target._id,
        });
        duplicatesLinked += 1;
      }

      await mutation("admin:feedbackSetTriage", {
        token,
        id: ticket._id,
        score: r.score,
        notes: r.notes ?? "",
        rubricVersion: String(r.rubricVersion ?? "1"),
        runId,
        now,
      });
      scored += 1;
    } catch (e) {
      errors.push(`NT-${r.number}: ${e.message}`);
    }
  }

  // Accumulated, not replaced: a drain applies several batches against one run,
  // and the ledger should show the night's work rather than its last slice.
  await writeFile(
    STATE,
    JSON.stringify({
      ...prior,
      scored: (prior.scored ?? 0) + scored,
      duplicatesLinked: (prior.duplicatesLinked ?? 0) + duplicatesLinked,
      ticketsRead: (prior.ticketsRead ?? 0) + results.length,
      errors: [...(prior.errors ?? []), ...errors],
    }),
  );
  console.log(JSON.stringify({ scored, duplicatesLinked, errors }, null, 2));
}

async function finish(file) {
  const state = await readState();
  const extra = file ? JSON.parse(await readFile(file, "utf8")) : {};
  const errors = [...(state.errors ?? []), ...(extra.errors ?? [])];

  await mutation("admin:runFinish", {
    token: state.token,
    id: state.runId,
    status: extra.status ?? (errors.length ? "failed" : "ok"),
    ticketsRead: state.ticketsRead ?? 0,
    duplicatesLinked: state.duplicatesLinked ?? 0,
    scored: state.scored ?? 0,
    prsFiled: 0,
    errors,
    ...(extra.notes ? { notes: extra.notes } : {}),
    now: Date.now(),
  });

  // The session outlives nothing: revoking it is deleting the row.
  await mutation("admin:logout", { token: state.token });
  await rm(WORK, { recursive: true, force: true });
  console.log(JSON.stringify({ finished: true, errors }, null, 2));
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === "start") await start();
  else if (command === "apply") {
    if (!arg) {
      console.error("triage: apply needs a results file");
      process.exit(2);
    }
    await apply(arg);
  }
  else if (command === "finish") await finish(arg);
  else {
    console.error("usage: triage.mjs start | apply <file> | finish [file]");
    process.exit(2);
  }
} catch (e) {
  console.error(`triage: ${e.message}`);
  process.exit(1);
}
