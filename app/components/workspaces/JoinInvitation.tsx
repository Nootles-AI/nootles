"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { homePath } from "@/app/lib/containerPaths";
import { Wordmark } from "../Brand";
import "../settings/settings.css";

/**
 * An invitation, answered: who asked, into what, and the one button that
 * takes the seat. Everything it can say comes from `members.invitation`,
 * which tells an account the invitation is not for only which address it is
 * for, in outline.
 */
export function JoinInvitation({ token }: { token: string }) {
  const router = useRouter();
  const invitation = useQuery(api.members.invitation, { token });
  const accept = useMutation(api.members.acceptInvite);
  const [going, setGoing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const join = async () => {
    setGoing(true);
    setFailure(null);
    try {
      const { slug } = await accept({ token });
      router.replace(homePath(slug));
    } catch (error) {
      setGoing(false);
      setFailure(
        error instanceof ConvexError && typeof error.data === "string"
          ? error.data
          : "That didn’t go through. Try again.",
      );
    }
  };

  return (
    <div className="nt-set-page">
      <header className="nt-set-topbar">
        <Link href="/" aria-label="Nootles">
          <Wordmark height={18} />
        </Link>
        <Link href="/" className="nt-note hover:underline">
          Back to your projects
        </Link>
      </header>
      <main className="nt-set-body" aria-busy={invitation === undefined}>
        {invitation === null && (
          <>
            <h1 className="nt-set-title">This invitation isn’t here</h1>
            <p className="nt-set-note">The link may be mistyped. Ask whoever sent it for a new one.</p>
          </>
        )}
        {invitation?.state === "wrong-account" && (
          <>
            <h1 className="nt-set-title">This invitation is for another account</h1>
            <p className="nt-set-note">It was sent to {invitation.email}. Sign in with that address to accept it.</p>
          </>
        )}
        {invitation && invitation.state !== "wrong-account" && (
          <>
            <h1 className="nt-set-title">{invitation.workspaceName}</h1>
            {invitation.state === "valid" && (
              <>
                <p className="nt-set-note">
                  {invitation.inviterName ?? "Someone"} invited you to join as{" "}
                  {invitation.role === "admin" ? "an admin" : `a ${invitation.role}`}.
                </p>
                <div className="mt-5 flex gap-1">
                  <button
                    onClick={join}
                    disabled={going}
                    className="nt-row nt-solid px-3 font-medium"
                  >
                    {going ? "Joining…" : "Accept"}
                  </button>
                  <Link href="/" className="nt-row px-2.5">
                    Not now
                  </Link>
                </div>
                {failure && (
                  <p role="alert" className="nt-set-problem">
                    {failure}
                  </p>
                )}
              </>
            )}
            {invitation.state === "accepted" && (
              <p className="nt-set-note">
                You’re in.{" "}
                {invitation.slug && (
                  <Link href={homePath(invitation.slug)} className="underline">
                    Open {invitation.workspaceName}
                  </Link>
                )}
              </p>
            )}
            {invitation.state === "expired" && (
              <p className="nt-set-note">This invitation has expired. Ask for a new one.</p>
            )}
            {invitation.state === "revoked" && (
              <p className="nt-set-note">This invitation was withdrawn.</p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
