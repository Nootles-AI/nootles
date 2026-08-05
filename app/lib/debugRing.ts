import * as Sentry from "@sentry/nextjs";

/**
 * A small in-memory record of what just happened in this tab: recent console
 * output and recent applied ops. Two consumers — Sentry breadcrumbs, and the
 * feedback panel, which attaches a dump so a report arrives with its own
 * context instead of "it broke".
 */

type ConsoleEntry = { level: "log" | "warn" | "error"; message: string; at: number };

const CONSOLE_MAX = 100;
const OPS_MAX = 30;
const MESSAGE_CAP = 500;

const consoleRing: ConsoleEntry[] = [];
const opsRing: unknown[] = [];

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

/** Every applied op batch passes through here — text, canvas, human or AI. */
export function pushOp(op: unknown) {
  opsRing.push(op);
  if (opsRing.length > OPS_MAX) opsRing.shift();
  try {
    Sentry.addBreadcrumb({
      category: "ops",
      message: typeof op === "object" && op !== null ? JSON.stringify(op).slice(0, 300) : String(op),
      level: "info",
    });
  } catch {
    // Telemetry never breaks the app.
  }
}

export function dump(): { console: ConsoleEntry[]; ops: unknown[] } {
  return { console: [...consoleRing], ops: [...opsRing] };
}
