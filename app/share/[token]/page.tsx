import type { Metadata } from "next";
import { SharedProject } from "@/app/components/share/SharedProject";

export const metadata: Metadata = {
  title: "Nootles",
  // A share link is an unguessable capability; indexing it would publish it.
  robots: { index: false },
};

/** A project someone shared, read-only — the one route with no sign-in door. */
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SharedProject token={token} />;
}
