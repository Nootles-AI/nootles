/**
 * Talking to GitHub's REST API.
 *
 * `fetch` and a bearer token, the same as `prs.ts` — there is no client library
 * here and there does not need to be. What this file adds is the reading of
 * failures: a 404 from GitHub means "not there, or not yours, and we won't say
 * which", and a 403 can be a rate limit or an organisation that has not been
 * authorised for this token. Those are the two things that will actually go
 * wrong, and each one has a different thing for the user to do about it, so
 * they are turned into sentences here rather than status codes further up.
 */

import { ConvexError } from "convex/values";

const API = "https://api.github.com";

/**
 * Failures a caller can act on: the message is written to be shown as-is.
 *
 * A `ConvexError` and not a plain one because Convex redacts the message of an
 * ordinary thrown error before it reaches a client — which is right for a stack
 * trace and exactly wrong for "authorise this token for your organisation".
 */
export class GitHubError extends ConvexError<string> {
  constructor(
    readonly status: number,
    message: string,
    /** True when the token itself is the problem, which the account row records. */
    readonly unauthorized = false,
    /** A 403 that is only the rate limit, not a refusal. */
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

type Options = {
  /** Defaults to JSON; the raw media type is how file contents are read. */
  accept?: string;
  query?: Record<string, string | number | undefined>;
  /** 404 answers null instead of throwing — for things that may simply not exist. */
  allowMissing?: boolean;
  /** GET unless said; a body is sent as JSON. */
  method?: "GET" | "POST";
  body?: unknown;
  /** "manual" hands a redirect back as a failure with its status, rather than following it. */
  redirect?: "follow" | "manual";
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
      Authorization: `Bearer ${token}`,
      Accept: options.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.redirect ? { redirect: options.redirect } : {}),
  });
  if (res.ok) return res;
  if (res.status === 404 && options.allowMissing) return null;
  throw await explain(res, kindOf(token));
}

export async function json<T>(
  token: string,
  path: string,
  options: Options = {},
): Promise<T | null> {
  const res = await request(token, path, options);
  return res ? ((await res.json()) as T) : null;
}

export async function text(
  token: string,
  path: string,
  options: Options = {},
): Promise<string | null> {
  const res = await request(token, path, {
    accept: "application/vnd.github.raw",
    ...options,
  });
  return res ? await res.text() : null;
}

/**
 * Whose token a call was made with, read off its prefix — which decides what
 * a refusal means. Only a fine-grained token is refused for a repository it
 * was not given; only an App's is refused for a permission its installation
 * lacks; a personal connection is refused because an organisation holds it
 * back. Telling one the others' remedy sends them looking in the wrong place.
 */
type TokenKind = "fine-grained" | "installation" | "app" | "personal";

function kindOf(token: string): TokenKind {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghs_")) return "installation";
  // The App's own JWT, which only ever mints installation tokens.
  if (token.startsWith("eyJ")) return "app";
  return "personal";
}

/** What went wrong, said in terms of what to do next. */
async function explain(res: Response, kind: TokenKind): Promise<GitHubError> {
  const sso = res.headers.get("x-github-sso");
  if (sso?.includes("required")) {
    const url = /url=([^;,\s]+)/.exec(sso)?.[1];
    return new GitHubError(
      res.status,
      "Your GitHub connection has not been authorised for that organisation's SSO." +
        (url ? ` Authorise it at ${url}, then try again.` : ""),
    );
  }

  if (res.status === 401) {
    return new GitHubError(
      401,
      "GitHub rejected the token. It may have been revoked or expired — " +
        "reconnect with a new one.",
      true,
    );
  }

  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset)
      ? new Date(reset * 1000).toISOString().slice(11, 16) + " UTC"
      : "shortly";
    return new GitHubError(403, `GitHub's rate limit is spent until ${when}.`, false, true);
  }

  if (res.status === 403) return new GitHubError(403, REFUSED[kind]);
  if (res.status === 404) return new GitHubError(404, MISSING[kind]);

  return new GitHubError(res.status, `GitHub responded ${res.status}: ${await detail(res)}`);
}

const REFUSED: Record<TokenKind, string> = {
  "fine-grained":
    "The token is not allowed to do that. A fine-grained token has to list " +
    "the repository, and its organisation has to permit fine-grained tokens.",
  installation:
    "GitHub refused the workspace’s GitHub App: its installation doesn’t have " +
    "permission for that. An admin can review what it was granted on GitHub.",
  app: "GitHub refused the Nootles GitHub App.",
  personal:
    "GitHub refused your connection. If this belongs to an organisation, it may " +
    "restrict third-party apps — an owner of it can approve Nootles on GitHub.",
};

const MISSING: Record<TokenKind, string> = {
  "fine-grained":
    "GitHub has nothing there for this token. Either it does not exist, or " +
    "the token cannot see it — a fine-grained token only sees the " +
    "repositories it was given.",
  installation:
    "GitHub has nothing there that the workspace’s GitHub App can see. Either it " +
    "does not exist, or the App isn’t installed with access to it.",
  app: "GitHub has no such installation of the Nootles GitHub App.",
  personal:
    "GitHub has nothing there that your connection can see. Either it does not " +
    "exist, or your GitHub account has no access to it.",
};

/** GitHub's own message when it sent one, capped — some are a page long. */
async function detail(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return parsed.message.slice(0, 200);
  } catch {
    // Not JSON; the raw body is the best there is.
  }
  return body.slice(0, 200) || res.statusText;
}
