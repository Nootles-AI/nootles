"use client";

import { useId, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { atLeast, type WorkspaceRole } from "@/convex/auth";
import { Check, Copy, Mail, MoreHorizontal, RotateCcw } from "../../Icons";
import { Menu, MenuItem } from "../../Menu";
import { useStandIn } from "../../StandIn";
import { Tooltip } from "../../Tooltip";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import { InviteForm, inviteUrl, useCopied } from "../Invite";
import { useNaming } from "../people";
import { refusal } from "../refusal";
import {
  expiresIn,
  heirOf,
  invitationProblem,
  LEAVE_INSTEAD,
  leaveProblem,
  removeProblem,
  roleChoices,
  ROLE_HINT,
  ROLE_LABEL,
  sayOnce,
  type Headcount,
} from "../seats";
import { ConfirmBox, LeaveWorkspace } from "./Confirm";
import { JoinByDomain } from "./JoinByDomain";
import { Avatar, Bone, Fold, Problem } from "./parts";

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

/** A row's ⋯, there on hover or focus, and always where there is no hover. */
const ROW_MENU =
  "nt-icon-btn nt-ws-row-menu opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100";

/** The ⋯ of the row for an invitation or a person, found by what the row is of. */
const rowMenuId = (key: string) => `nt-ws-row-menu-${key}`;

/** The roster's heading: where focus lands when no row is left to take it. */
const ROSTER = "nt-ws-people";

const toRoster = () => document.getElementById(ROSTER)?.focus();

/**
 * Focus, off a row on its way out of a list: to the ⋯ of the row after it,
 * else of the one before, else the roster's heading — somewhere still on the
 * page, rather than the page itself, where it falls when the row it was on
 * goes. `keys` is the list in its drawn order.
 */
function focusBeside(keys: readonly string[], gone: string) {
  const at = keys.indexOf(gone);
  for (const key of [...keys.slice(at + 1), ...keys.slice(0, at).reverse()]) {
    const menu = document.getElementById(rowMenuId(key));
    if (menu && !menu.closest(".is-leaving")) {
      menu.focus();
      return;
    }
  }
  toRoster();
}

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
  // Whether the skeleton has been up, which has no invitations to show.
  const [cold, setCold] = useState(false);
  if (people === undefined && !cold) setCold(true);

  if (people === undefined) {
    return <Loading invites={!standIn && atLeast(workspace.role, "admin")} />;
  }
  // A guest, or a seat that has just gone: the frame moves them on.
  if (people === null) return null;
  // An operator standing in reads; the server refuses their writes anyway.
  return (
    <Sections
      workspace={workspace}
      people={people}
      actor={standIn ? null : people.role}
      cold={cold}
    />
  );
}

function Sections({
  workspace,
  people,
  actor,
  cold,
}: {
  workspace: WorkspaceContainer;
  people: People;
  actor: WorkspaceRole | null;
  /** Drawn in place of the skeleton, which held no room for invitations. */
  cold: boolean;
}) {
  const runs = actor !== null && atLeast(actor, "admin");
  // The invitations fold open as the first is sent and shut as the last goes,
  // so the people under them are moved rather than thrown — and fold open
  // too when they arrive after the skeleton. Shut, the fold goes on drawing
  // the rows it last held, so they are still there as it closes.
  const inviting = people.invitations.length > 0;
  const [drawn, setDrawn] = useState(people.invitations);
  if (inviting && drawn !== people.invitations) setDrawn(people.invitations);
  const invitations = inviting ? people.invitations : drawn;

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
      {runs && (
        <Fold open={inviting} arriving={cold}>
          {invitations.length > 0 && (
            <Invitations workspace={workspace} actor={actor} invitations={invitations} />
          )}
        </Fold>
      )}
      <Roster workspace={workspace} actor={runs ? actor : null} members={people.members} />
      {runs && <JoinByDomain workspace={workspace} />}
    </>
  );
}

/**
 * The page's shape while it is on its way: the invite card first, for whoever
 * the page will give one, then the roster — so nothing moves down when the
 * people arrive, and any invitations fold open between the two. Each bar sits
 * in the line box of the text it stands for; the invite card's note is one
 * line wherever the card is wide enough to hold it, and two below that.
 */
function Loading({ invites }: { invites: boolean }) {
  return (
    <>
      {invites && (
        <section className="nt-set-section" aria-hidden="true">
          <Bone bar="h-3.5 w-24" className="mb-2" />
          <div className="nt-ws-card">
            <div className="nt-skeleton h-8" />
            <div className="mt-2">
              <Bone bar="h-3 w-[92%]" />
              <Bone bar="h-3 w-3/5" className="sm:hidden" />
            </div>
          </div>
        </section>
      )}
      <section className="nt-set-section" aria-busy="true" aria-label="Members">
        <Bone bar="h-3.5 w-20" className="mb-2" />
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
    </>
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
          <span className="nt-ws-col-end" />
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
              onGone={() =>
                focusBeside(
                  newest.map((n) => n.invitationId),
                  invitation.invitationId,
                )
              }
            />
          ))}
        </ul>
      </div>
      <Problem text={problem} />
    </section>
  );
}

/**
 * One address asked in. Its link can be copied again, since an admin's job
 * with an invitation is handing it on; once it has lapsed, renewing sends the
 * same seat again under a new link and a fresh fortnight. Withdrawing it is
 * in its ⋯, a step away from the pointer that copies.
 */
function InvitationRow({
  index,
  workspace,
  actor,
  invitation,
  now,
  onProblem,
  onGone,
}: {
  index: number;
  workspace: WorkspaceContainer;
  actor: WorkspaceRole;
  invitation: Invitation;
  now: number;
  onProblem: (text: string | null) => void;
  /** Moves focus off the row, which is on its way out. */
  onGone: () => void;
}) {
  const id = useId();
  const revoke = useMutation(api.members.revokeInvite);
  const invite = useMutation(api.members.invite);
  const [copied, copy] = useCopied();
  const [leaving, setLeaving] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const { email } = invitation;
  const expired = invitation.expiresAt <= now;
  const why = invitationProblem(actor, invitation.role);

  const revokeIt = () => {
    onProblem(null);
    onGone();
    // Leaves at once; the list drops it when the server agrees, and it comes
    // back if the server does not.
    setLeaving(true);
    revoke({ invitationId: invitation.invitationId }).catch((error) => {
      setLeaving(false);
      onProblem(refusal(error, `Couldn’t revoke the invitation for ${email}.`));
    });
  };

  const renew = () => {
    onProblem(null);
    setRenewing(true);
    invite({ workspaceId: workspace.workspaceId, email, role: invitation.role })
      .catch((error) => onProblem(refusal(error, `Couldn’t renew the invitation for ${email}.`)))
      .finally(() => setRenewing(false));
  };

  return (
    <li
      style={nth(index)}
      className={`nt-list-row nt-ws-person group${leaving ? " is-leaving" : ""}`}
    >
      <span className="nt-monogram is-lg nt-ws-pending" aria-hidden="true">
        <Mail width={14} height={14} />
      </span>
      <div className="nt-ws-who">
        <span className="nt-ws-who-name" title={email}>
          {email}
        </span>
      </div>
      <span className="nt-ws-col-role">{ROLE_LABEL[invitation.role]}</span>
      <span className={`nt-ws-col-when nt-meta${expired ? " nt-ws-lapsed" : ""}`}>
        {expiresIn(invitation.expiresAt, now)}
      </span>
      <span className="nt-ws-col-end">
        {expired ? (
          // A refused button hears no pointer; the tooltip listens on what
          // holds it, so the reason is still there to be found.
          <Tooltip label={why ?? "Renew with a new link"}>
            <button
              type="button"
              onClick={renew}
              disabled={!!why || renewing}
              aria-describedby={why ? `${id}-why` : undefined}
              aria-label={`Renew the invitation for ${email}`}
              className="nt-icon-btn"
            >
              <RotateCcw />
            </button>
          </Tooltip>
        ) : (
          <Tooltip label="Copy link">
            <button
              type="button"
              onClick={() => void copy(inviteUrl(invitation.token))}
              aria-live="polite"
              aria-label={copied ? "Copied" : `Copy the invitation link for ${email}`}
              data-done={copied || undefined}
              className="nt-icon-btn"
            >
              <span className="nt-swap" aria-hidden="true">
                <Copy />
                <Check />
              </span>
            </button>
          </Tooltip>
        )}
        <Menu
          label={`The invitation for ${email}`}
          side="bottom"
          align="end"
          className={why ? "nt-ws-choices" : undefined}
          trigger={(t) => (
            <button
              {...t}
              id={rowMenuId(invitation.invitationId)}
              aria-label={`Actions for the invitation to ${email}`}
              className={ROW_MENU}
            >
              <MoreHorizontal />
            </button>
          )}
        >
          {(close) => (
            <MenuItem
              danger
              className="nt-ws-choice"
              disabled={!!why || leaving}
              onClick={() => {
                // Not back to this ⋯: the row it is on is leaving.
                close({ restoreFocus: false });
                revokeIt();
              }}
            >
              <span className="nt-ws-choice-text">
                <span>Revoke invitation</span>
                {why && <span className="nt-ws-choice-hint">{why}</span>}
              </span>
            </MenuItem>
          )}
        </Menu>
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
  const naming = useNaming();
  const count: Headcount = {
    owners: members.filter((m) => m.role === "owner").length,
    people: members.length,
  };
  const heir = heirOf(members);

  return (
    <section className="nt-set-section" aria-labelledby={ROSTER}>
      {/* Focusable by script only, for focus to land on when a row goes. */}
      <h2 id={ROSTER} tabIndex={-1} className="nt-set-label nt-ws-label">
        Members
        <span className="nt-field-note">{members.length}</span>
      </h2>
      <div className="nt-ws-table">
        <div className="nt-list-head" aria-hidden="true">
          <span className="flex-1">Name</span>
          <span className="nt-ws-col-role">Role</span>
          <span className="nt-ws-col-when">Joined</span>
          {actor && <span className="nt-ws-col-end" />}
        </div>
        <ul className="nt-ws-rows" aria-label={`Members of ${workspace.name}`}>
          {members.map((member, i) => {
            const named = naming(member);
            return (
              <li key={member.userId} style={nth(i)} className="nt-list-row nt-ws-person group">
                <Avatar member={member} named={named} />
                <div className="nt-ws-who">
                  <span className="nt-ws-who-name">
                    {named.name}
                    {member.isMe && named.known && <span className="text-muted"> (you)</span>}
                  </span>
                  {named.mail && <span className="nt-ws-who-mail">{named.mail}</span>}
                </div>
                <span className="nt-ws-col-role">{ROLE_LABEL[member.role]}</span>
                <span className="nt-ws-col-when nt-meta">{WHEN.format(member.joinedAt)}</span>
                {actor && (
                  <span className="nt-ws-col-end">
                    <PersonMenu
                      workspace={workspace}
                      actor={actor}
                      member={member}
                      name={named.name}
                      count={count}
                      heir={heir && (heir.name ?? heir.email)}
                      onProblem={setProblem}
                      onGone={() =>
                        focusBeside(
                          members.map((m) => m.userId),
                          member.userId,
                        )
                      }
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <Problem text={problem} />
    </section>
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
 * description would be — or, when every refusal has the same reason, said
 * once above them (`sayOnce`).
 *
 * Most role changes happen on the pick. The two that cannot be taken back by
 * whoever made them ask first: making someone an owner, and stepping down
 * yourself. Those questions are asked after the menu has gone, so their
 * answer hands focus back to the ⋯ itself — or, where the answer takes the ⋯
 * away with the row or with the seat that could use it, to what is left.
 */
function PersonMenu({
  workspace,
  actor,
  member,
  name,
  count,
  heir,
  onProblem,
  onGone,
}: {
  workspace: WorkspaceContainer;
  actor: WorkspaceRole;
  member: Member;
  /** What the row calls them. */
  name: string;
  count: Headcount;
  heir: string | null;
  onProblem: (text: string | null) => void;
  /** Moves focus off the row, which is on its way out. */
  onGone: () => void;
}) {
  const setRole = useMutation(api.members.setRole);
  const remove = useMutation(api.members.remove);
  const captionId = useId();
  const trigger = useRef<{ focus: () => void }>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const choices = roleChoices(actor, member, count);
  const out = member.isMe ? leaveProblem(member.role, count) : removeProblem(actor, member.role);
  const said = sayOnce(choices, out, member.isMe ? LEAVE_INSTEAD : null);
  const close = () => {
    setAsking(null);
    trigger.current?.focus();
  };

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
        focusRef={trigger}
        trigger={(t) => (
          <button
            {...t}
            id={rowMenuId(member.userId)}
            aria-label={`Actions for ${name}`}
            className={ROW_MENU}
          >
            <MoreHorizontal />
          </button>
        )}
      >
        {(closeMenu) => (
          <>
            {said.caption && (
              <>
                <p id={captionId} className="nt-menu-caption">
                  {said.caption}
                </p>
                <div className="nt-menu-sep" />
              </>
            )}
            {choices.map((choice) => {
              // A dialog takes focus as it opens; handed back to the trigger,
              // it would be taken straight away.
              const asks = choice.role !== member.role && (choice.role === "owner" || member.isMe);
              const captioned = !!said.caption && !!choice.why;
              return (
                <MenuItem
                  key={choice.role}
                  className="nt-ws-choice"
                  disabled={!!choice.why}
                  describedBy={captioned ? captionId : undefined}
                  onClick={() => {
                    closeMenu(asks ? { restoreFocus: false } : undefined);
                    pick(choice.role);
                  }}
                >
                  <span className="nt-ws-choice-text">
                    <span>{ROLE_LABEL[choice.role]}</span>
                    {!captioned && (
                      <span className="nt-ws-choice-hint">
                        {choice.why ?? ROLE_HINT[choice.role]}
                      </span>
                    )}
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
              describedBy={out && said.out !== out ? captionId : undefined}
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
                {said.out && <span className="nt-ws-choice-hint">{said.out}</span>}
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
            setAsking(null);
            onGone();
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
            // A member runs no rows, so there is no ⋯ left to come back to.
            if (asking.role === "admin") close();
            else {
              setAsking(null);
              toRoster();
            }
          }}
          onClose={close}
        >
          {asking.role === "admin"
            ? `You’ll keep managing ${workspace.name}’s people and settings, but not deleting it or appointing owners.`
            : `You’ll stop managing ${workspace.name}’s people and settings, and you won’t be able to open private projects others made.`}{" "}
          Only an owner can make you one again.
        </ConfirmBox>
      )}
    </>
  );
}
