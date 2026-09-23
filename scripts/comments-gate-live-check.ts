import type { ConvexHttpClient } from "convex/browser";
import { AI } from "@/app/lib/ai/aiConfig";
import { commentsGate, type GateInput } from "@/app/lib/ai/commentsGate";

/**
 * The comments gate against the real vendor, once, on purpose.
 *
 * SPENDS A PAID KEY. Never run it without the operator's approval for that
 * specific run — CLAUDE.md's hard rule. It refuses to start unless
 * `COMMENTS_GATE_LIVE_CHECK=I_HAVE_APPROVAL`, and it cannot make more than
 * `MAX_CALLS` requests however the vendor answers: `fetch` is wrapped with a
 * counter that refuses the next one (a refusal the gate reads as "no"), and
 * refuses any host but the lane's own. Retries count.
 *
 * Nothing is written to Convex: the ledger client is a stand-in that prints
 * the row the route would have recorded.
 *
 *   COMMENTS_GATE_LIVE_CHECK=I_HAVE_APPROVAL node scripts/comments-gate-live-check.mjs
 */

const MAX_CALLS = 5;
const HOSTS = new Set(["generativelanguage.googleapis.com", "openrouter.ai"]);

if (process.env.COMMENTS_GATE_LIVE_CHECK !== "I_HAVE_APPROVAL") {
  throw new Error(
    "Refusing to call a paid model without COMMENTS_GATE_LIVE_CHECK=I_HAVE_APPROVAL.",
  );
}

const snippets = [
  '"ship it by Friday" — "Can we say Monday? QA needs the weekend."',
  '"the launch plan" — "This section is too vague to act on."',
];

const SAMPLES: { expect: boolean; input: GateInput }[] = [
  {
    expect: true,
    input: { message: "Redraft the launch paragraph, taking Sam's notes into account.", openThreads: 2, snippets },
  },
  {
    expect: false,
    input: { message: "Add a table of the rover's four motors under the wiring heading.", openThreads: 2, snippets },
  },
  {
    expect: true,
    input: { message: "What do people think about the Friday deadline?", openThreads: 2, snippets },
  },
  {
    expect: false,
    input: { message: "Make the page title bold.", openThreads: 2, snippets },
  },
  {
    expect: true,
    input: { message: "Resolve whatever comments you can address, and fix the text they point at.", openThreads: 2, snippets },
  },
];

let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!HOSTS.has(url.hostname)) throw new Error(`live check refuses ${url.hostname}`);
  if (calls >= MAX_CALLS) throw new Error(`live check refuses call ${calls + 1} of at most ${MAX_CALLS}`);
  calls++;
  return realFetch(input, init);
}) as typeof fetch;

const rows: unknown[] = [];
const ledger = {
  mutation: async (_ref: unknown, row: unknown) => {
    rows.push(row);
  },
} as unknown as ConvexHttpClient;

console.log(
  `comments gate live check: ${AI.commentsGate.model} via ${process.env.USE_OPENROUTER === "true" ? "OpenRouter" : "direct"}, ` +
    `timeout ${AI.commentsGate.timeoutMs}ms, at most ${MAX_CALLS} calls`,
);
let agreed = 0;
for (const [i, sample] of SAMPLES.entries()) {
  const before = rows.length;
  const got = await commentsGate(ledger, sample.input, new AbortController().signal);
  // The ledger write is fire-and-forget; give it its tick.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (got === sample.expect) agreed++;
  console.log(
    `${i + 1}. ${got === sample.expect ? "agree" : "DISAGREE"} expected=${sample.expect} got=${got} ` +
      `message=${JSON.stringify(sample.input.message)}`,
  );
  console.log(`   ledger row: ${JSON.stringify(rows[before] ?? null)}`);
}
console.log(`${agreed}/${SAMPLES.length} agreed; ${calls} vendor calls made.`);
