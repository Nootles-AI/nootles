import * as Sentry from "@sentry/nextjs";

/**
 * A small in-memory record of what just happened in this tab: recent console
 * output and recent applied ops. Two consumers — Sentry breadcrumbs, and the
 * feedback panel, which attaches a dump so a report arrives with its own
 * context instead of "it broke".
 */

type ConsoleEntry = { level: "log" | "warn" | "error"; message: string; at: number };

/** Which feature produced an AI op — the `aiCalls` vocabulary, so a ticket can
 *  be lined up against the cost ledger. */
export type OpFeature = "fim" | "reformat" | "diagram" | "chat";

export type OpEntry = {
  source: "human" | "ai";
  feature?: OpFeature;
  op: unknown;
  at: number;
};

const CONSOLE_MAX = 100;
const MESSAGE_CAP = 500;

/**
 * Human and AI ops are kept in separate rings, and merged only when dumped.
 *
 * One shared ring would be the obvious thing and the wrong one: a person types
 * far more ops than the AI does, so a burst of editing would evict exactly the
 * AI ops that explain the bug being reported. Separate capacities mean neither
 * can crowd the other out, and merging by timestamp at the end keeps the
 * interleaving — "the AI wrote this, then I typed over it" — which is usually
 * the whole story.
 */
const AI_MAX = 30;
const HUMAN_MAX = 50;

const consoleRing: ConsoleEntry[] = [];
const aiRing: OpEntry[] = [];
const humanRing: OpEntry[] = [];

function asMessage(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, MESSAGE_CAP);
}

let installed = false;

/** Patches console once, at boot. The originals still run untouched. */
export function installConsoleTap() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      consoleRing.push({ level, message: asMessage(args), at: Date.now() });
      if (consoleRing.length > CONSOLE_MAX) consoleRing.shift();
      original(...args);
    };
  }
}

function push(ring: OpEntry[], max: number, entry: OpEntry) {
  ring.push(entry);
  if (ring.length > max) ring.shift();
  try {
    Sentry.addBreadcrumb({
      category: entry.source === "ai" ? "ops.ai" : "ops.human",
      message:
        typeof entry.op === "object" && entry.op !== null
          ? JSON.stringify(entry.op).slice(0, 300)
          : String(entry.op),
      level: "info",
    });
  } catch {
    // Telemetry never breaks the app.
  }
}

/** Every op the AI applies, from whichever feature asked for it. */
export function pushAiOp(op: unknown, feature?: OpFeature) {
  push(aiRing, AI_MAX, {
    source: "ai",
    ...(feature ? { feature } : {}),
    op,
    at: Date.now(),
  });
}

/**
 * Every op a person applies. Callers are expected to have coalesced already —
 * one entry per undoable action, not one per keystroke.
 */
export function pushHumanOp(op: unknown) {
  push(humanRing, HUMAN_MAX, { source: "human", op, at: Date.now() });
}

/**
 * True while an AI batch is being applied, so the editor's own transaction
 * listener doesn't log the AI's work a second time as the user's.
 *
 * A flag rather than transaction metadata because `applyBatch` is synchronous:
 * nothing else can run between setting and clearing it.
 */
let applyingAi = false;

export function duringAiApply<T>(run: () => T): T {
  const was = applyingAi;
  applyingAi = true;
  try {
    return run();
  } finally {
    applyingAi = was;
  }
}

export function isApplyingAi(): boolean {
  return applyingAi;
}

export function dump(): { console: ConsoleEntry[]; ops: OpEntry[] } {
  return {
    console: [...consoleRing],
    ops: [...aiRing, ...humanRing].sort((a, b) => a.at - b.at),
  };
}
