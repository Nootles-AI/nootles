"use client";

import { useId, useState, type CSSProperties } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { WorkspaceRole } from "@/convex/auth";
import { Check, Copy, Mail, MoreHorizontal, RotateCcw } from "../Icons";
import { Menu, MenuItem } from "../Menu";
import { Tooltip } from "../Tooltip";
import type { WorkspaceContainer } from "./ContainerContext";
import { inviteUrl, useCopied } from "./Invite";
import { refusal } from "./refusal";
import { expiresIn, invitationProblem, ROLE_LABEL } from "./seats";
import "./workspaces.css";

type People = NonNullable<FunctionReturnType<typeof api.members.list>>;
export type Invitation = People["invitations"][number];

/** A row's place in its list, for the staggered entrance. */
export const nth = (i: number) => ({ "--i": i }) as CSSProperties;

/** A row's ⋯, there on hover or focus, and always where there is no hover. */
export const ROW_MENU =
  "nt-icon-btn nt-ws-row-menu opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100";

/** The ⋯ of the row for an invitation or a person, found by what the row is of. */
export const rowMenuId = (key: string) => `nt-ws-row-menu-${key}`;

/**
 * Focus, off a row on its way out of a list: to the ⋯ of the row after it,
 * else of the one before, else `fallback` — somewhere still on the page,
 * rather than the page itself, where it falls when the row it was on goes.
 * `keys` is the list in its drawn order.
 */
export function focusBeside(keys: readonly string[], gone: string, fallback: () => void) {
  const at = keys.indexOf(gone);
  for (const key of [...keys.slice(at + 1), ...keys.slice(0, at).reverse()]) {
    const menu = document.getElementById(rowMenuId(key));
    if (menu && !menu.closest(".is-leaving")) {
      menu.focus();
      return;
    }
  }
  fallback();
}

/**
 * The open invitations, newest first: address, seat, when it lapses, its link
 * to copy again and its ⋯. The members screen sets it under its heading; the
 * palette's invite page beside a key. `onEmptied` is where focus goes when the
 * last row it could move to has gone.
 */
export function InvitationTable({
  workspace,
  actor,
  invitations,
  layer = "dropdown",
  onProblem,
  onEmptied,
}: {
  workspace: WorkspaceContainer;
  actor: WorkspaceRole;
  invitations: Invitation[];
  /** "modal" inside a dialog, so the row menus open over it. */
  layer?: "dropdown" | "modal";
  onProblem: (text: string | null) => void;
  onEmptied: () => void;
}) {
  // Fixed for the visit: "in 13 days" does not need to tick.
  const [now] = useState(() => Date.now());
  const newest = [...invitations].sort((a, b) => b.createdAt - a.createdAt);

  return (
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
            layer={layer}
            onProblem={onProblem}
            onGone={() =>
              focusBeside(
                newest.map((n) => n.invitationId),
                invitation.invitationId,
                onEmptied,
              )
            }
          />
        ))}
      </ul>
    </div>
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
  layer,
  onProblem,
  onGone,
}: {
  index: number;
  workspace: WorkspaceContainer;
  actor: WorkspaceRole;
  invitation: Invitation;
  now: number;
  layer: "dropdown" | "modal";
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
          layer={layer}
          className={why ? "nt-ws-choices" : undefined}
          trigger={(t) => (
            <button
              {...t}
              // Not a submit: the palette's invite page holds this list in its
              // form, whose Enter would otherwise press the first row's ⋯.
              type="button"
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
