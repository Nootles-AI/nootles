"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { homePath, WHOLE_ROUTE } from "@/app/lib/containerPaths";
import { rememberWorkspace } from "@/app/lib/projectsCache";
import { Wordmark } from "../Brand";
import { useConfirmedEmail, useIdentityCheck } from "../IdentitySync";
import { Check, Mail } from "../Icons";
import { drawsItself, RowIcon, type RowIconValue } from "../rowIcon";
import { initial } from "./people";
import { refusal } from "./refusal";
import { ROLE_OFFER } from "./seats";
import "../settings/settings.css";
import "./workspaces.css";

const an = (role: string) => (role === "admin" ? "an admin" : `a ${role}`);
/** How long the tile's tick is seen before the new home replaces the card. */
const LANDED_MS = 400;

/**
 * An invitation, answered: who asked, into what, what the seat lets you do,
 * and the one button that takes it — "Join", the switcher's word for it. Everything it can say comes from `members.invitation`,
 * which tells an account the invitation is not for only which address it is
 * for, in outline — so that state offers the one useful move, signing out to
 * come back as the right account, with this page as the way back. A sign-in
 * that told Nootles no address at all is not called the wrong account: it
 * may be the right one, so it is asked to sign in again instead — or, when
 * the check itself went unanswered, simply to try it again.
 */
export function JoinInvitation({ token }: { token: string }) {
  const router = useRouter();
  const { user } = useUser();
  const { userId } = useAuth();
  const { signOut } = useClerk();
  const live = useQuery(api.members.invitation, { token });
  const confirmed = useConfirmedEmail();
  const { answered, checking, recheck } = useIdentityCheck();
  // On a first visit the server is still confirming the address with Clerk,
  // and until it has, "no address" and "someone else's" are not yet answers.
  // An address it did confirm is waited on until the query has caught up.
  const settling =
    (live?.state === "unconfirmed" && confirmed !== null) ||
    (live?.state === "wrong-account" && confirmed === undefined);
  // The invitation as it was when Join was pressed. Joining answers the query
  // "accepted" before the home it goes to has replaced this page, and the card
  // would otherwise turn into "You’re in" under the pointer on its way out.
  const [held, setHeld] = useState<typeof live>(undefined);
  const invitation = held ?? (settling ? undefined : live);
  const accept = useMutation(api.members.acceptInvite);
  const [going, setGoing] = useState(false);
  const [joined, setJoined] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const join = async () => {
    setHeld(live);
    setGoing(true);
    setFailure(null);
    try {
      const done = await accept({ token });
      // Told to the cache first, so the home draws at once rather than
      // waiting to learn what its address is. Left going: it replaces this page,
      // a beat after the tile has said you are in.
      if (userId) rememberWorkspace(userId, done.slug, { kind: "workspace", ...done });
      router.prefetch(homePath(done.slug), WHOLE_ROUTE);
      setJoined(true);
      setTimeout(() => router.replace(homePath(done.slug)), LANDED_MS);
    } catch (error) {
      setHeld(undefined);
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
  if (invitation?.state === "unconfirmed") {
    const tryAgain = (
      <button
        type="button"
        onClick={recheck}
        disabled={checking}
        className={`nt-row px-3 font-medium${answered ? "" : " nt-solid"}`}
      >
        {checking ? "Checking…" : "Try again"}
      </button>
    );
    const signInAgain = (
      <button
        type="button"
        onClick={switchAccount}
        className={`nt-row px-3 font-medium${answered ? " nt-solid" : ""}`}
      >
        Sign in again
      </button>
    );
    card = (
      <Card
        title={
          answered
            ? "We couldn’t confirm your email address"
            : "We couldn’t check your email address"
        }
        tile={<Envelope />}
        actions={
          <>
            {answered ? signInAgain : tryAgain}
            {answered ? tryAgain : signInAgain}
            <Link href="/" className="nt-row px-2.5">
              Not now
            </Link>
          </>
        }
      >
        {answered
          ? "This invitation opens only for the address it was sent to, and your sign-in didn’t tell us yours. Signing in again brings you back here."
          : "This invitation opens only for the address it was sent to, and we couldn’t reach our sign-in service to check yours just now. Try again in a moment."}
      </Card>
    );
  } else if (invitation === null) {
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
    const { workspaceName: name, workspaceIcon: icon, inviterName: inviter } = invitation;
    const tile = <Tile name={name} icon={icon} done={joined} />;
    if (invitation.state === "valid") {
      card = (
        <Card
          title={`Join ${name}`}
          tile={tile}
          actions={
            <>
              <button
                type="button"
                onClick={() => void join()}
                disabled={going}
                className="nt-row nt-solid px-3 font-medium"
              >
                {going ? "Joining…" : "Join"}
              </button>
              <Link href="/" className="nt-row px-2.5">
                Not now
              </Link>
            </>
          }
          problem={failure}
        >
          {inviter ?? "Someone"} invited you as {an(invitation.role)}. {ROLE_OFFER[invitation.role]}
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
    } else if (invitation.state === "gone") {
      card = (
        <Card title={name} tile={tile} actions={home}>
          This workspace has been deleted, so there’s nothing left to join.
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

  return <JoinFrame>{card ?? <JoinWaiting />}</JoinFrame>;
}

/** The page around the card: the settings surface's topbar, and the card centred under it. */
export function JoinFrame({ children }: { children: ReactNode }) {
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
      <main className="nt-ws-join-body">{children}</main>
    </div>
  );
}

/**
 * The card before the invitation has been read — or before the account has
 * signed in to read it: its sheet, the tile's well and bars where the words
 * will be. Still, so the answer is the card's one arrival.
 */
export function JoinWaiting() {
  return (
    <section className="nt-ws-join is-waiting" aria-busy="true" aria-label="Reading the invitation">
      <span className="nt-skeleton h-12 w-12 rounded-xl" />
      <span className="nt-skeleton mt-4 h-5 w-44" />
      <span className="nt-skeleton mt-3 h-3.5 w-64 max-w-full" />
      <span className="nt-skeleton mt-2 h-3.5 w-48 max-w-full" />
      <span className="nt-skeleton mt-6 h-8 w-20" />
    </section>
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

/**
 * The workspace's token, as the switcher draws it: its initial, in a square —
 * which turns to a tick once you are in, the moment before its home arrives.
 */
function Tile({
  name,
  icon,
  done = false,
}: {
  name: string;
  icon: RowIconValue | null;
  done?: boolean;
}) {
  const shown = drawsItself(icon) ? icon : null;
  return (
    <span
      className={`nt-monogram nt-ws-tile is-square nt-ws-join-tile${
        shown ? ` has-icon is-${shown.kind}` : ""
      }`}
      data-done={done || undefined}
      aria-hidden="true"
    >
      <span className="nt-swap">
        {shown ? (
          <RowIcon
            icon={shown}
            kind="page"
            size={shown.kind === "image" ? 48 : 30}
            className="nt-ws-tile-icon"
          />
        ) : (
          <span>{initial(name)}</span>
        )}
        <Check width={20} height={20} />
      </span>
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
