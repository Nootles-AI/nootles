import type { Metadata } from "next";
import { Authed } from "@/app/components/Authed";
import { Consent } from "@/app/components/mcp/Consent";

export const metadata: Metadata = {
  title: "Connect an agent — Nootles",
};

/**
 * Where an MCP client's sign-in lands (`convex/mcp/http.ts` `/oauth/authorize`
 * redirects here) to ask the signed-in person whether the agent may read their
 * pages. Private like every other route, so Clerk signs the person in first and
 * brings them back with the request intact. `request` is the only thing read off
 * the URL: everything shown is the backend's account of that request.
 */
type AuthorizePageProps = {
  searchParams: Promise<{ request?: string | string[] }>;
};

export default async function AuthorizePage({ searchParams }: AuthorizePageProps) {
  const { request } = await searchParams;
  return (
    <Authed>
      <Consent request={typeof request === "string" ? request : null} />
    </Authed>
  );
}
