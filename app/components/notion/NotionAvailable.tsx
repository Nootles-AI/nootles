"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Whether this deployment can import from Notion at all.
 *
 * Two halves have to be configured, on two different machines: Next holds the
 * OAuth client (NOTION_CLIENT_ID, NOTION_CLIENT_SECRET, NOTION_REDIRECT_URI)
 * and Convex holds the key the token is sealed under (NOTION_TOKEN_KEY). A
 * deployment with neither is not a broken one, it is one where the feature
 * does not exist yet — and a button that opens onto "set this env var" is the
 * feature announcing itself to someone who cannot act on it.
 *
 * The Next half is known on the server and handed down once from the root
 * layout; the Convex half is asked for only where a surface would show an
 * entry point, and only when the Next half is there.
 */
const OAuthConfigured = createContext(false);

export function NotionConfigProvider({
  oauth,
  children,
}: {
  oauth: boolean;
  children: ReactNode;
}) {
  return <OAuthConfigured.Provider value={oauth}>{children}</OAuthConfigured.Provider>;
}

/**
 * `true` when both halves are set, `false` when either is missing, and
 * `undefined` while the Convex half is still being asked — so a surface can
 * hold its entry point back rather than flash one that then disappears.
 */
export function useNotionAvailable(): boolean | undefined {
  const oauth = useContext(OAuthConfigured);
  const status = useQuery(api.notion.account.status, oauth ? {} : "skip");
  if (!oauth) return false;
  return status ? status.ready : undefined;
}
