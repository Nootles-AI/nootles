/**
 * The facts both halves of the GitHub OAuth dance need to agree on — the same
 * shape as `app/api/notion/oauth.ts`, and for the same reasons.
 *
 * `GITHUB_REDIRECT_URI` is explicit rather than derived from the request: an
 * OAuth App has exactly one callback URL, matched as a string, and behind a
 * proxy `req.url` is the deployment's internal host rather than that URL.
 */
export type GitHubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export const STATE_COOKIE = "github_oauth_state";
export const RETURN_COOKIE = "github_oauth_return";
/** Long enough to read a consent screen, short enough that a stale one dies. */
export const STATE_MAX_AGE = 600;

/**
 * `repo` because it is the only scope that reads a private repository — GitHub
 * offers no read-only one to an OAuth App, so the token could write, and
 * nothing here ever does. `read:org` lets the picker list an organisation's
 * repositories and say which organisations the connection can see.
 */
const SCOPES = "repo read:org";

export function oauthConfig(): GitHubOAuthConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function authorizeUrl(config: GitHubOAuthConfig, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  // Always ask, so connecting a second account is possible from the same browser.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/**
 * Trade the authorization code for an access token. GitHub answers a failed
 * exchange with a 200 and an `error` field, not a status, so both are read.
 */
export async function exchangeCode(config: GitHubOAuthConfig, code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; error?: string }
    | null;
  if (!res.ok || !body?.access_token) {
    throw new Error(body?.error ?? `GitHub answered ${res.status} to the token exchange.`);
  }
  return body.access_token;
}

/** Why a connection did not happen, as the callback writes it into `?reason=`. */
export type FailureReason = "state" | "no_code" | "exchange" | "unconfigured";

/** Only ever bounce back inside this app, whatever the cookie says. */
export function safeReturn(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
