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
 * Needs CONVEX_URL, ADMIN_USER and ADMIN_PASSWORD. Locally:
 *
 *   export CONVEX_URL=$(grep NEXT_PUBLIC_CONVEX_URL .env.prod | cut -d= -f2)
 *   export ADMIN_USER=$(npx convex env get ADMIN_USER --prod)
 *   export ADMIN_PASSWORD=$(npx convex env get ADMIN_PASSWORD --prod)
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const WORK = path.resolve(".triage");
const STATE = path.join(WORK, "state.json");
const SHOTS = path.join(WORK, "shots");

const url = process.env.CONVEX_URL;
const user = process.env.ADMIN_USER;
const password = process.env.ADMIN_PASSWORD;

function need(name, value) {
  if (!value) {
    console.error(`triage: ${name} is not set — see the header of this file.`);
    process.exit(2);
  }
  return value;
}

/**
 * Convex's HTTP API. The admin functions take their session token as an
 * ordinary argument rather than an identity, which is what lets a plain POST
 * drive them — no SDK, no deploy key.
 */
async function call(kind, name, args) {
  const res = await fetch(`${need("CONVEX_URL", url)}/api/${kind}`, {
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

async function start() {
  const token = await mutation("admin:login", {
    username: need("ADMIN_USER", user),
    password: need("ADMIN_PASSWORD", password),
  });

  const now = Date.now();
  const queue = await query("admin:triageQueue", { token, now });

  if (!queue.enabled) {
    // Not an error. The switch is off, so there is nothing to do tonight.
    await mutation("admin:logout", { token });
    console.log(JSON.stringify({ enabled: false, tickets: [] }, null, 2));
    return;
  }

  const runId = await mutation("admin:runStart", { token, kind: "triage", now });
  await mkdir(SHOTS, { recursive: true });
  await writeFile(STATE, JSON.stringify({ token, runId, startedAt: now }));

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
  const { token, runId } = await readState();
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

  await writeFile(
    STATE,
    JSON.stringify({
      ...(await readState()),
      scored,
      duplicatesLinked,
      errors,
      ticketsRead: results.length,
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
  else if (command === "apply") await apply(need("a results file", arg));
  else if (command === "finish") await finish(arg);
  else {
    console.error("usage: triage.mjs start | apply <file> | finish [file]");
    process.exit(2);
  }
} catch (e) {
  console.error(`triage: ${e.message}`);
  process.exit(1);
}
