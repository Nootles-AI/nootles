/**
 * The three facts both halves of the Notion OAuth dance need to agree on.
 *
 * `NOTION_REDIRECT_URI` is explicit rather than derived from the incoming
 * request because Notion matches it as an exact string, twice — once on the
 * authorize redirect and again on the token exchange — and behind a proxy
 * `req.url` is the deployment's internal host, not the domain registered with
 * Notion. Deriving it is the single most reliable way to produce an OAuth error
 * that looks like a code bug.
 */
export type NotionOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export const STATE_COOKIE = "notion_oauth_state";
export const RETURN_COOKIE = "notion_oauth_return";
/** Long enough to read a consent screen, short enough that a stale one dies. */
export const STATE_MAX_AGE = 600;

export function oauthConfig(): NotionOAuthConfig | null {
  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  const redirectUri = process.env.NOTION_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function authorizeUrl(config: NotionOAuthConfig, state: string): string {
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  // Required by Notion, and the reason this is a per-user connection rather
  // than a workspace-wide one.
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export type NotionTokenResponse = {
  access_token: string;
  workspace_id: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  bot_id: string;
};

/**
 * Trade the authorization code for an access token.
 *
 * Notion wants the client credentials as HTTP Basic, not in the body — a body
 * that carries them is answered with a 401 that says nothing useful.
 */
export async function exchangeCode(
  config: NotionOAuthConfig,
  code: string,
): Promise<NotionTokenResponse> {
  const credentials = btoa(`${config.clientId}:${config.clientSecret}`);
  const res = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Notion answered ${res.status} to the token exchange.`);
  }
  return (await res.json()) as NotionTokenResponse;
}

/**
 * Why a connection did not happen, as the callback writes it into `?reason=`.
 * Declared here so the sentence the settings page writes for each code and the
 * code the route emits cannot drift apart.
 */
export type FailureReason = "state" | "no_code" | "exchange" | "unconfigured";

/** Only ever bounce back inside this app, whatever the cookie says. */
export function safeReturn(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
