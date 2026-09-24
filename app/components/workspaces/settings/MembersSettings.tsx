"use client";

import { useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { atLeast, type WorkspaceRole } from "@/convex/roles";
import { Check, MoreHorizontal } from "../../Icons";
import { Menu, MenuItem } from "../../Menu";
import { useStandIn } from "../../StandIn";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import { InviteForm } from "../Invite";
import {
  focusBeside,
  InvitationTable,
  nth,
  ROW_MENU,
  rowMenuId,
  type Invitation,
} from "../Invitations";
import { useNaming } from "../people";
import { refusal } from "../refusal";
import { useLeaving } from "../useLeaving";
import { useMoment } from "../useMoment";
import {
  heirOf,
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

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** The roster's heading: where focus lands when no row is left to take it. */
const ROSTER = "nt-ws-people";

const toRoster = () => document.getElementById(ROSTER)?.focus();

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
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-invitations">
      <h2 id="nt-ws-invitations" className="nt-set-label nt-ws-label">
        Invitations
        <span className="nt-field-note">{invitations.length}</span>
      </h2>
      <InvitationTable
        workspace={workspace}
        actor={actor}
        invitations={invitations}
        onProblem={setProblem}
        onEmptied={toRoster}
      />
      <Problem text={problem} />
    </section>
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
  const count: Headcount = {
    owners: members.filter((m) => m.role === "owner").length,
    people: members.length,
  };
  const heir = heirOf(members);
  // Someone removed — here, or by another admin — fades out of the list.
  const rows = useLeaving(members, (m) => m.userId);

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
          {rows.map(({ item: member, leaving }, i) => (
            <MemberRow
              key={member.userId}
              index={i}
              workspace={workspace}
              actor={actor}
              member={member}
              leaving={leaving}
              count={count}
              heir={heir && (heir.name ?? heir.email)}
              onProblem={setProblem}
              onGone={() =>
                focusBeside(
                  members.map((m) => m.userId),
                  member.userId,
                  toRoster,
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
 * One person. A role changed from here is acknowledged where it is read: the
 * new word settles into the column, and a tick beside it says it took.
 */
function MemberRow({
  index,
  workspace,
  actor,
  member,
  leaving,
  count,
  heir,
  onProblem,
  onGone,
}: {
  index: number;
  workspace: WorkspaceContainer;
  actor: WorkspaceRole | null;
  member: Member;
  /** Gone from the list, and fading out of it. */
  leaving: boolean;
  count: Headcount;
  heir: string | null;
  onProblem: (text: string | null) => void;
  onGone: () => void;
}) {
  const naming = useNaming();
  const named = naming(member);
  const [changed, ack] = useMoment(1200);
  return (
    <li
      style={nth(index)}
      inert={leaving}
      className={`nt-list-row nt-ws-person group${leaving ? " is-leaving" : ""}`}
    >
      <Avatar member={member} named={named} />
      <div className="nt-ws-who">
        <span className="nt-ws-who-name">
          {named.name}
          {member.isMe && named.known && <span className="text-muted"> (you)</span>}
        </span>
        {named.mail && <span className="nt-ws-who-mail">{named.mail}</span>}
      </div>
      <span className="nt-ws-col-role">
        <Check
          width={12}
          height={12}
          aria-hidden="true"
          className={`nt-menu-check nt-ws-role-tick${changed ? " is-on" : ""}`}
        />
        <span key={member.role} className="nt-ws-swap">
          {ROLE_LABEL[member.role]}
        </span>
      </span>
      <span className="nt-ws-col-when nt-meta">{WHEN.format(member.joinedAt)}</span>
      {actor && (
        <span className="nt-ws-col-end">
          <PersonMenu
            workspace={workspace}
            actor={actor}
            member={member}
            name={named.name}
            count={count}
            heir={heir}
            onChanged={ack}
            onProblem={onProblem}
            onGone={onGone}
          />
        </span>
      )}
    </li>
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
  onChanged,
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
  /** Their seat changed, from here. */
  onChanged: () => void;
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
    setRole({ workspaceId: workspace.workspaceId, userId: member.userId, role }).then(onChanged);

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
