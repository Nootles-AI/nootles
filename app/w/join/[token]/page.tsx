import type { Metadata } from "next";
import { Authed } from "@/app/components/Authed";
import {
  JoinFrame,
  JoinInvitation,
  JoinWaiting,
} from "@/app/components/workspaces/JoinInvitation";

export const metadata: Metadata = {
  title: "Join a workspace — Nootles",
  robots: { index: false },
};

/**
 * Where an invitation link lands. Signed out, `proxy.ts` sends the visitor to
 * sign in with this address as the way back (`returnPath`), so accepting is
 * the next thing they see after Google rather than the front door.
 */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <Authed
      fallback={
        <JoinFrame>
          <JoinWaiting />
        </JoinFrame>
      }
    >
      <JoinInvitation token={token} />
    </Authed>
  );
}
