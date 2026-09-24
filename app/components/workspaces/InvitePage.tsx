"use client";

import { useId, useRef, useState } from "react";
import type { WorkspaceContainer } from "./ContainerContext";
import { InvitationTable } from "./Invitations";
import { InviteLink, RoleChoice, useInvite } from "./Invite";
import { Fold, Problem } from "./settings/parts";
import { ROLE_HINT } from "./seats";
import "./workspaces.css";

/** What finds "Invite people" in a palette, beside the words of its name. */
export const INVITE_WORDS = ["invite", "people", "member", "members", "add", "team"] as const;

/**
 * Inviting someone as a page of the palette: the address where the query was,
 * at its size, then the seat and — once there is one — the link and the
 * invitations still open, keys down the left as the new project's details
 * are. The same form as the home's popover and the members screen
 * (`useInvite`): judged by the server's rule as it is typed, the admin seat
 * refused with its reason for an admin, the link handed back to be sent.
 * Invite is the footer's, and Enter in the address presses it.
 */
export function InvitePage({
  workspace,
  onBack,
}: {
  workspace: WorkspaceContainer;
  onBack: () => void;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const { email, type, role, setRole, busy, problem, sent, live, note, plausible, submit, people } =
    useInvite(workspace);
  // A revoke or renew refused, from the list.
  const [trouble, setTrouble] = useState<string | null>(null);
  // Shut, the list's fold goes on drawing the rows it last held, so they are
  // still there as it closes.
  const open = people?.invitations ?? [];
  const [drawn, setDrawn] = useState(open);
  if (open.length > 0 && drawn !== open) setDrawn(open);
  const invitations = open.length > 0 ? open : drawn;
  const actor = people?.role ?? workspace.role;

  return (
    <form
      className="nt-pal-form"
      onSubmit={submit}
      noValidate
      aria-label={`Invite people to ${workspace.name}`}
    >
      <div className="nt-pal-name-row">
        <label htmlFor={`${id}-email`} className="sr-only">
          Email address
        </label>
        <input
          ref={field}
          id={`${id}-email`}
          autoFocus
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          className="nt-pal-name-input"
          placeholder="Their email address"
          value={email}
          aria-invalid={!!problem}
          aria-describedby={`${id}-note`}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => {
            // Invite is refused until the address could be one, which would
            // leave Enter doing nothing at all; it says why instead.
            if (e.key === "Enter" && !plausible) void submit(e);
          }}
        />
        {/* How inviting works, until there is a link that says it for this
            address — or something went wrong, which says what did. */}
        <Fold open={!live || !!problem}>
          <p
            id={`${id}-note`}
            aria-live="polite"
            className={`pt-0.5 text-[length:var(--text-meta-lg)] text-pretty${
              problem ? " text-danger" : " text-muted"
            }`}
          >
            {note}
          </p>
        </Fold>
      </div>

      <div className="nt-pal-fields">
        <div className="nt-pal-fld">
          <span className="nt-pal-key">Role</span>
          <div className="min-w-0">
            <RoleChoice
              actor={actor}
              value={role}
              onChange={setRole}
              layer="modal"
              align="start"
              className="nt-row nt-ws-pick -ml-2 max-w-full gap-1.5 px-2 text-[length:var(--text-body)] text-foreground"
            />
            <p aria-live="polite" className="text-[length:var(--text-meta-lg)] text-muted text-pretty">
              <span key={role} className="nt-ws-swap">
                {ROLE_HINT[role]}.
              </span>
            </p>
          </div>
        </div>
        <div className="nt-pal-fold" data-open={live} inert={!live}>
          <div className="nt-pal-fld">
            <span className="nt-pal-key">Link</span>
            <div className="min-w-0 pt-px">
              {sent && <InviteLink key={sent.token} {...sent} bare />}
            </div>
          </div>
        </div>
        <div className="nt-pal-fold" data-open={open.length > 0} inert={open.length === 0}>
          <div className="nt-pal-fld">
            <span className="nt-pal-key flex items-baseline gap-[7px]">
              Invitations
              <span className="nt-field-note">{invitations.length}</span>
            </span>
            <div className="min-w-0 pt-px">
              {invitations.length > 0 && (
                <InvitationTable
                  workspace={workspace}
                  actor={actor}
                  invitations={invitations}
                  layer="modal"
                  onProblem={setTrouble}
                  onEmptied={() => field.current?.focus()}
                />
              )}
              <Problem text={trouble} className="nt-note pt-2 text-danger nt-settle" />
            </div>
          </div>
        </div>
      </div>

      <div className="nt-pal-foot">
        <span className="nt-pal-hint">
          <kbd className="nt-kbd">↵</kbd>
          Invite
        </span>
        <span className="ml-auto flex gap-1">
          <button type="button" onClick={onBack} className="nt-row px-2.5">
            Back
          </button>
          <button
            type="submit"
            disabled={!plausible || busy}
            className="nt-row nt-solid px-3 font-medium"
          >
            {busy ? "Inviting…" : "Invite"}
          </button>
        </span>
      </div>
    </form>
  );
}
