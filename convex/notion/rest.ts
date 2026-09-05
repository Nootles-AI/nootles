/**
 * Talking to Notion's REST API.
 *
 * `fetch` and a bearer token, the same shape as `github/rest.ts`. What this
 * file adds is the reading of failures, because Notion's are unusually
 * actionable: a 404 nearly always means "you were never granted this page"
 * rather than "this page does not exist", and saying so is the difference
 * between a user re-granting in ten seconds and filing a bug.
 */

import { ConvexError } from "convex/values";

const API = "https://api.notion.com/v1";
/** Pinned. Notion changes response shapes between versions, silently. */
export const NOTION_VERSION = "2022-06-28";

/**
 * Failures a caller can act on: the message is written to be shown as-is.
 *
 * A `ConvexError` and not a plain one because Convex redacts the message of an
 * ordinary thrown error before it reaches a client — right for a stack trace,
 * exactly wrong for "this page was not shared with Nootles".
 */
export class NotionError extends ConvexError<string> {
  constructor(
    readonly status: number,
    message: string,
    /** True when the token itself is the problem, which the account row records. */
    readonly unauthorized = false,
    /** Seconds Notion asked us to wait, when it said so. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "NotionError";
  }
}

type Options = {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** 404 answers null instead of throwing — for things that may simply not exist. */
  allowMissing?: boolean;
};

export async function request(
  token: string,
  path: string,
  options: Options = {},
): Promise<Response | null> {
  const url = new URL(path.startsWith("http") ? path : `${API}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (res.ok) return res;
  if (res.status === 404 && options.allowMissing) return null;

  throw new NotionError(res.status, await explain(res), res.status === 401, retryAfter(res));
}

export async function json<T>(token: string, path: string, options: Options = {}): Promise<T | null> {
  const res = await request(token, path, options);
  return res ? ((await res.json()) as T) : null;
}

/**
 * Notion's error body into a sentence worth showing.
 *
 * The two that actually happen are 401 (the user revoked the connection) and
 * 404 (the page was never ticked in the consent picker). Both have a fix the
 * user can perform, and neither is obvious from the status code alone.
 */
async function explain(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
  const detail = body?.message ? ` ${body.message}` : "";
  switch (res.status) {
    case 401:
      return "Notion no longer accepts this connection. Reconnect your Notion account.";
    case 404:
      return "Notion cannot see that page. Grant Nootles access to it in Notion, then try again.";
    case 429:
      return "Notion is rate limiting this import. It will continue on its own shortly.";
    default:
      return `Notion answered ${res.status}.${detail}`;
  }
}

/** How long Notion asks us to wait, when it says so. Seconds, as a number. */
function retryAfter(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) ? seconds : undefined;
}
