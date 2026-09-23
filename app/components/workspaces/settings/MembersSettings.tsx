"use client";

import { useId, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { atLeast, type WorkspaceRole } from "@/convex/auth";
import { Check, Copy, Mail, MoreHorizontal } from "../../Icons";
import { Menu, MenuItem } from "../../Menu";
import { useStandIn } from "../../StandIn";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import { InviteForm, inviteUrl, useCopied } from "../Invite";
import { refusal } from "../refusal";
import {
  expiresIn,
  heirOf,
  invitationProblem,
  leaveProblem,
  removeProblem,
  roleChoices,
  ROLE_HINT,
  ROLE_LABEL,
} from "../seats";
import { ConfirmBox, LeaveWorkspace } from "./Confirm";
import { JoinByDomain } from "./JoinByDomain";

type People = NonNullable<FunctionReturnType<typeof api.members.list>>;
type Member = People["members"][number];
type Invitation = People["invitations"][number];

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** A row's place in its list, for the staggered entrance. */
const nth = (i: number) => ({ "--i": i }) as CSSProperties;

/** By code point, so a name that starts with an emoji keeps it whole. */
const initial = (name: string | null) => (Array.from(name?.trim() ?? "")[0] ?? "?").toUpperCase();

const nameOf = (m: Member) => m.name ?? m.email ?? "Someone";

/**
 * Who is in a workspace, and who has been asked.
 *
 * Every section is drawn for the seat you hold: members read the list, and
 * admins and owners also invite, revoke, change roles, remove, and open the
 * workspace to their email domain. What anyone may do to whom comes from the
 * same rules the server keeps (`seats.ts` → `mayAssignSeat`), so a choice that
 * would be refused is drawn refused, with the reason beside it.
 */
export function MembersSettings() {
  const container = useContainer();
  if (container.kind !== "workspace") return null;
  return <Members workspace={container} />;
}

function Members({ workspace }: { workspace: WorkspaceContainer }) {
  const standIn = useStandIn();
  const people = useQuery(api.members.list, { workspaceId: workspace.workspaceId });

  if (people === undefined) return <Loading />;
  // A guest, or a seat that has just gone: the frame moves them on.
  if (people === null) return null;

  // An operator standing in reads; the server refuses their writes anyway.
  const actor = standIn ? null : people.role;
  const runs = actor !== null && atLeast(actor, "admin");

  return (
    <>
      {runs && (
        <section className="nt-set-section" aria-labelledby="nt-ws-invite">
          <h2 id="nt-ws-invite" className="nt-set-label">
            Invite people
          </h2>
          <div className="nt-ws-card">
            <InviteForm workspace={workspace} inline />
          </div>
        </section>
      )}
      {runs && people.invitations.length > 0 && (
        <Invitations workspace={workspace} actor={actor} invitations={people.invitations} />
      )}
      <Roster workspace={workspace} actor={runs ? actor : null} members={people.members} />
      {runs && <JoinByDomain workspace={workspace} />}
    </>
  );
}

/** The roster's shape, while it is on its way. */
function Loading() {
  return (
    <section className="nt-set-section" aria-busy="true" aria-label="Members">
      <div className="nt-skeleton mb-2 h-3.5 w-20" />
      <div className="nt-ws-table">
        <div className="nt-list-head" />
        <ul className="nt-ws-rows">
          {[0, 1, 2].map((i) => (
            <li key={i} className="nt-ws-person">
              <span className="nt-skeleton h-8 w-8 shrink-0 rounded-full" />
              <span className="nt-skeleton h-3.5 w-40" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---- Invitations -----------------------------------------------------------

function Invitations({
  workspace,
  actor,
  invitations,
}: {
  workspace: WorkspaceContainer;
  actor: WorkspaceRole;
  invitations: Invitation[];
}) {
  // Fixed for the visit: "in 13 days" does not need to tick.
  const [now] = useState(() => Date.now());
  const [problem, setProblem] = useState<string | null>(null);
  const newest = [...invitations].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-invitations">
      <h2 id="nt-ws-invitations" className="nt-set-label nt-ws-label">
        Invitations
        <span className="nt-field-note">{invitations.length}</span>
      </h2>
      <div className="nt-ws-table">
        <div className="nt-list-head" aria-hidden="true">
          <span className="flex-1">Email</span>
          <span className="nt-ws-col-role">Role</span>
          <span className="nt-ws-col-when">Expires</span>
          <span className="nt-ws-col-invite" />
        </div>
        <ul className="nt-ws-rows" aria-label="Invitations">
          {newest.map((invitation, i) => (
            <InvitationRow
              key={invitation.invitationId}
              index={i}
              workspace={workspace}
              actor={actor}
              invitation={invitation}
              now={now}
              onProblem={setProblem}
            />
          ))}
        </ul>
      </div>
      {problem && (
        <p role="alert" className="nt-set-problem">
          {problem}
        </p>
      )}
    </section>
  );
}

/**
 * One address asked in. Its link can be copied again, since an admin's job
 * with an invitation is handing it on; once it has lapsed, renewing sends the
 * same seat again under a new link and a fresh fortnight.
 */
function InvitationRow({
  index,
  workspace,
  actor,
  invitation,
  now,
  onProblem,
}: {
  index: number;
  workspace: WorkspaceContainer;
  actor: WorkspaceRole;
  invitation: Invitation;
  now: number;
  onProblem: (text: string | null) => void;
}) {
  const id = useId();
  const revoke = useMutation(api.members.revokeInvite);
  const invite = useMutation(api.members.invite);
  const [copied, copy] = useCopied();
  const [leaving, setLeaving] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const expired = invitation.expiresAt <= now;
  const why = invitationProblem(actor, invitation.role);

  const revokeIt = () => {
    onProblem(null);
    // Leaves at once; the list drops it when the server agrees, and it comes
    // back if the server does not.
    setLeaving(true);
    revoke({ invitationId: invitation.invitationId }).catch((error) => {
      setLeaving(false);
      onProblem(refusal(error, `Couldn’t revoke the invitation for ${invitation.email}.`));
    });
  };

  const renew = () => {
    onProblem(null);
    setRenewing(true);
    invite({ workspaceId: workspace.workspaceId, email: invitation.email, role: invitation.role })
      .catch((error) =>
        onProblem(refusal(error, `Couldn’t renew the invitation for ${invitation.email}.`)),
      )
      .finally(() => setRenewing(false));
  };

  return (
    <li
      style={nth(index)}
      className={`nt-list-row nt-ws-person${leaving ? " is-leaving" : ""}`}
    >
      <span className="nt-monogram is-lg nt-ws-pending" aria-hidden="true">
        <Mail width={14} height={14} />
      </span>
      <div className="nt-ws-who">
        <span className="nt-ws-who-name">{invitation.email}</span>
      </div>
      <span className="nt-ws-col-role">{ROLE_LABEL[invitation.role]}</span>
      <span className={`nt-ws-col-when nt-meta${expired ? " nt-ws-lapsed" : ""}`}>
        {expiresIn(invitation.expiresAt, now)}
      </span>
      <span className="nt-ws-col-invite">
        {!expired && (
          <button
            type="button"
            onClick={() => void copy(inviteUrl(invitation.token))}
            aria-live="polite"
            aria-label={copied ? "Copied" : `Copy the invitation link for ${invitation.email}`}
            data-done={copied || undefined}
            className="nt-row gap-1.5 px-2"
          >
            <span className="nt-swap" aria-hidden="true">
              <Copy width={14} height={14} />
              <Check width={14} height={14} />
            </span>
            {copied ? "Copied" : "Copy link"}
          </button>
        )}
        {/* A refused button hears no pointer, so the reason hangs on what
            holds the refused ones. */}
        <span
          className={why ? "nt-tip nt-ws-tip-end nt-ws-refused" : "contents"}
          data-tip={why ?? undefined}
        >
          {expired && (
            <button
              type="button"
              onClick={renew}
              disabled={!!why || renewing}
              aria-describedby={why ? `${id}-why` : undefined}
              aria-label={`Renew the invitation for ${invitation.email}`}
              className="nt-row px-2"
            >
              {renewing ? "Renewing…" : "Renew"}
            </button>
          )}
          <button
            type="button"
            onClick={revokeIt}
            disabled={!!why || leaving}
            aria-describedby={why ? `${id}-why` : undefined}
            aria-label={`Revoke the invitation for ${invitation.email}`}
            className="nt-row px-2"
          >
            Revoke
          </button>
        </span>
        {why && (
          <span id={`${id}-why`} className="sr-only">
            {why}
          </span>
        )}
      </span>
    </li>
  );
}

// ---- The roster ------------------------------------------------------------

/**
 * Everyone with a seat, owners first. `actor` is the seat that may act on the
 * rows — null for someone who only reads them, whose rows have no menu.
 */
function Roster({
  workspace,
  actor,
  members,
}: {
  workspace: WorkspaceContainer;
  actor: WorkspaceRole | null;
  members: Member[];
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const owners = members.filter((m) => m.role === "owner").length;
  const heir = heirOf(members);

  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-people">
      <h2 id="nt-ws-people" className="nt-set-label nt-ws-label">
        Members
        <span className="nt-field-note">{members.length}</span>
      </h2>
      <div className="nt-ws-table">
        <div className="nt-list-head" aria-hidden="true">
          <span className="flex-1">Name</span>
          <span className="nt-ws-col-role">Role</span>
          <span className="nt-ws-col-when">Joined</span>
          {actor && <span className="nt-col-actions" />}
        </div>
        <ul className="nt-ws-rows" aria-label={`Members of ${workspace.name}`}>
          {members.map((member, i) => (
            <li key={member.userId} style={nth(i)} className="nt-list-row nt-ws-person group">
              <Avatar member={member} />
              <div className="nt-ws-who">
                <span className="nt-ws-who-name">
                  {nameOf(member)}
                  {member.isMe && <span className="text-muted"> (you)</span>}
                </span>
                {member.name && member.email && (
                  <span className="nt-ws-who-mail">{member.email}</span>
                )}
              </div>
              <span className="nt-ws-col-role">{ROLE_LABEL[member.role]}</span>
              <span className="nt-ws-col-when nt-meta">{WHEN.format(member.joinedAt)}</span>
              {actor && (
                <span className="nt-col-actions">
                  <PersonMenu
                    workspace={workspace}
                    actor={actor}
                    member={member}
                    owners={owners}
                    heir={heir && (heir.name ?? heir.email)}
                    onProblem={setProblem}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {problem && (
        <p role="alert" className="nt-set-problem">
          {problem}
        </p>
      )}
    </section>
  );
}

/** You as your monogram, as everywhere you see yourself; everyone else as their photo. */
function Avatar({ member }: { member: Member }) {
  if (member.imageUrl && !member.isMe) {
    return (
      // Not next/image: Clerk's avatar hosts are not the optimizer's to fetch.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={member.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-full" />
    );
  }
  return (
    <span className="nt-monogram is-lg shrink-0" aria-hidden="true">
      {initial(member.name ?? member.email)}
    </span>
  );
}

type Asking =
  | { kind: "remove" }
  | { kind: "leave" }
  | { kind: "role"; role: WorkspaceRole };

/**
 * The ⋯ on a person's row: the seats they could hold, ticked at theirs, and
 * the way out — removing them, or on your own row, leaving. What this seat
 * may not do stays in the menu, refused, with the reason where the
 * description would be.
 *
 * Most role changes happen on the pick. The two that cannot be taken back by
 * whoever made them ask first: making someone an owner, and stepping down
 * yourself.
 */
function PersonMenu({
  workspace,
  actor,
  member,
  owners,
  heir,
  onProblem,
}: {
  workspace: WorkspaceContainer;
  actor: WorkspaceRole;
  member: Member;
  owners: number;
  heir: string | null;
  onProblem: (text: string | null) => void;
}) {
  const setRole = useMutation(api.members.setRole);
  const remove = useMutation(api.members.remove);
  const [asking, setAsking] = useState<Asking | null>(null);
  const name = nameOf(member);
  const choices = roleChoices(actor, member, owners);
  const out = member.isMe ? leaveProblem(member.role, owners) : removeProblem(actor, member.role);
  const close = () => setAsking(null);

  const change = (role: WorkspaceRole) =>
    setRole({ workspaceId: workspace.workspaceId, userId: member.userId, role });

  const pick = (role: WorkspaceRole) => {
    onProblem(null);
    if (role === member.role) return;
    if (role === "owner" || member.isMe) {
      setAsking({ kind: "role", role });
      return;
    }
    change(role).catch((error) =>
      onProblem(refusal(error, `Couldn’t change ${name}’s role. Try again in a moment.`)),
    );
  };

  return (
    <>
      <Menu
        label={`Actions for ${name}`}
        side="bottom"
        align="end"
        className="nt-ws-choices"
        trigger={(t) => (
          <button
            {...t}
            aria-label={`Actions for ${name}`}
            className="nt-icon-btn nt-ws-row-menu opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
          >
            <MoreHorizontal />
          </button>
        )}
      >
        {(closeMenu) => (
          <>
            {choices.map((choice) => {
              // A dialog takes focus as it opens; handed back to the trigger,
              // it would be taken straight away.
              const asks = choice.role !== member.role && (choice.role === "owner" || member.isMe);
              return (
                <MenuItem
                  key={choice.role}
                  className="nt-ws-choice"
                  disabled={!!choice.why}
                  onClick={() => {
                    closeMenu(asks ? { restoreFocus: false } : undefined);
                    pick(choice.role);
                  }}
                >
                  <span className="nt-ws-choice-text">
                    <span>{ROLE_LABEL[choice.role]}</span>
                    <span className="nt-ws-choice-hint">
                      {choice.why ?? ROLE_HINT[choice.role]}
                    </span>
                  </span>
                  <Check
                    width={14}
                    height={14}
                    aria-hidden="true"
                    className={`nt-menu-check${choice.role === member.role ? " is-on" : ""}`}
                  />
                </MenuItem>
              );
            })}
            <div className="nt-menu-sep" />
            <MenuItem
              danger
              className="nt-ws-choice"
              disabled={!!out}
              onClick={() => {
                closeMenu({ restoreFocus: false });
                onProblem(null);
                setAsking({ kind: member.isMe ? "leave" : "remove" });
              }}
            >
              <span className="nt-ws-choice-text">
                <span>
                  {member.isMe ? `Leave ${workspace.name}` : `Remove from ${workspace.name}`}
                </span>
                {out && <span className="nt-ws-choice-hint">{out}</span>}
              </span>
            </MenuItem>
          </>
        )}
      </Menu>

      {asking?.kind === "remove" && (
        <ConfirmBox
          label={`Remove ${name}`}
          question={`Remove ${name}?`}
          action="Remove"
          busyAction="Removing…"
          onConfirm={async () => {
            await remove({ workspaceId: workspace.workspaceId, userId: member.userId });
            close();
          }}
          onClose={close}
        >
          They lose access to {workspace.name} straight away. Projects they made here pass to
          you, and repositories or Notion pages they linked are unlinked.
        </ConfirmBox>
      )}
      {asking?.kind === "leave" && (
        <LeaveWorkspace workspace={workspace} heir={heir} onClose={close} />
      )}
      {asking?.kind === "role" && asking.role === "owner" && (
        <ConfirmBox
          label={`Make ${name} an owner`}
          question={`Make ${name} an owner?`}
          action="Make owner"
          busyAction="Saving…"
          quiet
          onConfirm={async () => {
            await change("owner");
            close();
          }}
          onClose={close}
        >
          Owners can do everything, including deleting {workspace.name} and changing anyone’s
          role — yours too.
        </ConfirmBox>
      )}
      {asking?.kind === "role" && asking.role !== "owner" && (
        <ConfirmBox
          label={`Step down to ${ROLE_LABEL[asking.role].toLowerCase()}`}
          question={`Step down to ${ROLE_LABEL[asking.role].toLowerCase()}?`}
          action="Step down"
          busyAction="Saving…"
          onConfirm={async () => {
            await change(asking.role);
            close();
          }}
          onClose={close}
        >
          {asking.role === "admin"
            ? `You’ll keep running ${workspace.name}’s people and settings, but not deleting it or appointing owners.`
            : `You’ll stop running ${workspace.name}’s people and settings.`}{" "}
          Only an owner can make you one again.
        </ConfirmBox>
      )}
    </>
  );
}
