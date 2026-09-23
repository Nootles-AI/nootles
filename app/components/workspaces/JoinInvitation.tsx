"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useClerk, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { homePath } from "@/app/lib/containerPaths";
import { Wordmark } from "../Brand";
import { Mail } from "../Icons";
import { refusal } from "./refusal";
import "../settings/settings.css";
import "./workspaces.css";

/** By code point, so a name that starts with an emoji keeps it whole. */
const initial = (name: string) => (Array.from(name.trim())[0] ?? "?").toUpperCase();

const an = (role: string) => (role === "admin" ? "an admin" : `a ${role}`);

/**
 * An invitation, answered: who asked, into what, and the one button that
 * takes the seat. Everything it can say comes from `members.invitation`,
 * which tells an account the invitation is not for only which address it is
 * for, in outline — so that state offers the one useful move, signing out to
 * come back as the right account, with this page as the way back.
 */
export function JoinInvitation({ token }: { token: string }) {
  const router = useRouter();
  const { user } = useUser();
  const { signOut } = useClerk();
  const invitation = useQuery(api.members.invitation, { token });
  const accept = useMutation(api.members.acceptInvite);
  const [going, setGoing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const join = async () => {
    setGoing(true);
    setFailure(null);
    try {
      const { slug } = await accept({ token });
      // Left going: the workspace's home replaces this page.
      router.replace(homePath(slug));
    } catch (error) {
      setGoing(false);
      setFailure(refusal(error, "That didn’t go through. Try again in a moment."));
    }
  };

  const switchAccount = () =>
    void signOut({
      redirectUrl: `/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`,
    });

  const home = (
    <Link href="/" className="nt-row px-2.5">
      Back to your projects
    </Link>
  );

  let card: ReactNode = null;
  if (invitation === null) {
    card = (
      <Card title="This invitation isn’t here" tile={<Envelope />} actions={home}>
        The link may be mistyped, or replaced by a newer one. Ask whoever sent it for
        another.
      </Card>
    );
  } else if (invitation?.state === "wrong-account") {
    card = (
      <Card
        title="This invitation is for another account"
        tile={<Envelope />}
        actions={
          <>
            <button
              type="button"
              onClick={switchAccount}
              className="nt-row nt-solid px-3 font-medium"
            >
              Sign out to switch
            </button>
            <Link href="/" className="nt-row px-2.5">
              Not now
            </Link>
          </>
        }
      >
        It was sent to <span className="nt-ws-join-mail">{invitation.email}</span>
        {user?.primaryEmailAddress && (
          <>
            , and you’re signed in as{" "}
            <span className="nt-ws-join-mail">{user.primaryEmailAddress.emailAddress}</span>
          </>
        )}
        . Sign in with that address to accept it.
      </Card>
    );
  } else if (invitation) {
    const { workspaceName: name, inviterName: inviter } = invitation;
    const tile = <Tile name={name} />;
    if (invitation.state === "valid") {
      card = (
        <Card
          title={name}
          tile={tile}
          actions={
            <>
              <button
                type="button"
                onClick={() => void join()}
                disabled={going}
                className="nt-row nt-solid px-3 font-medium"
              >
                {going ? "Joining…" : "Accept"}
              </button>
              <Link href="/" className="nt-row px-2.5">
                Not now
              </Link>
            </>
          }
          problem={failure}
        >
          {inviter ?? "Someone"} invited you to join as {an(invitation.role)}.
        </Card>
      );
    } else if (invitation.state === "accepted") {
      card = invitation.slug ? (
        <Card
          title={name}
          tile={tile}
          actions={
            <Link href={homePath(invitation.slug)} className="nt-row nt-solid px-3 font-medium">
              Open {name}
            </Link>
          }
        >
          You’re in.
        </Card>
      ) : (
        <Card title={name} tile={tile} actions={home}>
          This invitation has already been used.
        </Card>
      );
    } else if (invitation.state === "expired") {
      card = (
        <Card title={name} tile={tile} actions={home}>
          This invitation has expired. Ask {inviter ?? "whoever sent it"} for a new one.
        </Card>
      );
    } else {
      card = (
        <Card title={name} tile={tile} actions={home}>
          This invitation was withdrawn. If you still need to join, ask someone in {name}.
        </Card>
      );
    }
  }

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
      <main className="nt-ws-join-body" aria-busy={invitation === undefined}>
        {card}
      </main>
    </div>
  );
}

/** One answer: what it is about, what it says, and what you can do next. */
function Card({
  title,
  tile,
  children,
  actions,
  problem,
}: {
  title: string;
  tile: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  problem?: string | null;
}) {
  return (
    <section className="nt-ws-join" aria-labelledby="nt-ws-join-title">
      {tile}
      <h1 id="nt-ws-join-title" className="nt-ws-join-title">
        {title}
      </h1>
      <p className="nt-ws-join-note">{children}</p>
      <div className="nt-ws-join-actions">{actions}</div>
      {problem && (
        <p role="alert" className="nt-set-problem">
          {problem}
        </p>
      )}
    </section>
  );
}

/** The workspace's token, as the switcher draws it: its initial, in a square. */
function Tile({ name }: { name: string }) {
  return (
    <span className="nt-monogram nt-ws-tile is-square nt-ws-join-tile" aria-hidden="true">
      {initial(name)}
    </span>
  );
}

/** For an invitation that names nothing this account may see. */
function Envelope() {
  return (
    <span className="nt-monogram nt-ws-join-tile" aria-hidden="true">
      <Mail width={20} height={20} />
    </span>
  );
}
