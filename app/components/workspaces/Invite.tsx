"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { WorkspaceRole } from "@/convex/auth";
import { normalizeEmail, NOT_AN_EMAIL, plausibleEmail } from "@/convex/emails";
import { joinPath } from "@/app/lib/containerPaths";
import { Check, ChevronsUpDown, Copy } from "../Icons";
import { Menu, MenuItem } from "../Menu";
import type { WorkspaceContainer } from "./ContainerContext";
import { refusal } from "./refusal";
import { Fold } from "./settings/parts";
import { INVITED, inviteProblem, ROLE_HINT, ROLE_LABEL, type Invited } from "./seats";
import { useMoment } from "./useMoment";
import "./workspaces.css";

const DAY_MS = 86_400_000;

const HOW =
  "You’ll get a link to send them yourself. It opens only for someone signed in with that address.";

/**
 * What an invite form holds, wherever it is drawn: the address as typed, the
 * seat, the round trip, and the link it ends on. One line under the field
 * says how inviting works until something goes wrong, and then what did.
 */
export function useInvite(workspace: WorkspaceContainer) {
  const invite = useMutation(api.members.invite);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Invited>("member");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The last problem, still said while its line folds away under a link:
  // cleared by typing, it would otherwise turn back into the how-to as it goes.
  const [said, setSaid] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  // The link folds away once its invitation is no longer open — revoked here
  // or by another admin, or used — rather than staying to be copied dead.
  const people = useQuery(api.members.list, { workspaceId: workspace.workspaceId });
  const live = !!sent && (people?.invitations.some((i) => i.token === sent.token) ?? true);
  const note = problem ?? (live ? said : null) ?? HOW;
  const plausible = plausibleEmail(email);

  const type = (value: string) => {
    setEmail(value);
    setProblem(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    if (!to || busy) return;
    if (!plausible) {
      setProblem(NOT_AN_EMAIL);
      setSaid(NOT_AN_EMAIL);
      return;
    }
    setBusy(true);
    try {
      const made = await invite({
        workspaceId: workspace.workspaceId,
        email: to,
        role,
      });
      setSent({
        email: normalizeEmail(to),
        token: made.token,
        days: Math.max(1, Math.round((made.expiresAt - Date.now()) / DAY_MS)),
        replaced: made.replaced,
      });
      setProblem(null);
      setSaid(null);
      setEmail("");
    } catch (error) {
      const text = refusal(error, "That invitation didn’t go through. Try again in a moment.");
      setProblem(text);
      setSaid(text);
    } finally {
      setBusy(false);
    }
  };

  return { email, type, role, setRole, busy, problem, sent, live, note, plausible, submit, people };
}

type Sent = { email: string; token: string; days: number; replaced: boolean };

/**
 * An address, a role, and the link that lets them in. Nootles sends no mail:
 * the link is handed back to be sent however the team talks, and it opens
 * only for someone signed in with the address it was made for.
 *
 * One line wherever it is: the address, the role as a menu in the middle of
 * it — an admin sees the admin seat refused with the reason rather than
 * missing — and the press. The home's popover labels it; the members screen's
 * section already has. An address is judged by the server's own rule as it is
 * typed (`convex/emails.ts`), so Invite waits until it could be one, and
 * Enter on one that could not says so without asking the server.
 */
export function InviteForm({
  workspace,
  autoFocus,
  inline,
}: {
  workspace: WorkspaceContainer;
  autoFocus?: boolean;
  /** The members screen's one-line form. */
  inline?: boolean;
}) {
  const auto = useId();
  // The members screen holds one form, so it can be found by name.
  const id = inline ? "nt-ws-invite" : auto;
  const { email, type, role, setRole, busy, problem, sent, live, note, plausible, submit } =
    useInvite(workspace);

  return (
    <form onSubmit={submit} noValidate>
      {inline ? (
        <label htmlFor={`${id}-email`} className="sr-only">
          Email address
        </label>
      ) : (
        <label htmlFor={`${id}-email`} className="nt-field-label">
          Invite someone
        </label>
      )}
      <div className="flex items-center gap-1.5">
        <input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder="name@company.com"
          value={email}
          aria-invalid={!!problem}
          aria-describedby={`${id}-note`}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => {
            // Invite is refused until the address could be one, which would
            // leave Enter doing nothing at all; it says why instead.
            if (e.key === "Enter" && !plausible) void submit(e);
          }}
          className="nt-input h-8 min-w-0 flex-1 py-0"
        />
        {/* In the popover, on its layer, and Escape is the menu's alone. */}
        <RoleChoice
          actor={workspace.role}
          value={role}
          onChange={setRole}
          layer={inline ? "dropdown" : "modal"}
        />
        <button
          type="submit"
          disabled={!plausible || busy}
          className="nt-row nt-solid shrink-0 px-3 font-medium"
        >
          {busy ? "Inviting…" : "Invite"}
        </button>
      </div>
      {/* Once there is a link, the how-to folds away as the link folds in, the
          two at one pace, so the form grows by the difference and nothing
          below it jumps. A problem after that folds back in above the link. */}
      <Fold open={!live || !!problem}>
        <p
          id={`${id}-note`}
          aria-live="polite"
          className={`nt-note pt-2 text-pretty${problem ? " text-danger" : ""}`}
        >
          {note}
        </p>
      </Fold>
      {sent && (
        <Fold open={live} arriving>
          <InviteLink key={sent.token} {...sent} />
        </Fold>
      )}
    </form>
  );
}

/**
 * The seat an invitation asks for, as a menu: each role with what it may do,
 * and the ones this inviter may not hand out refused with the reason in the
 * place the description would be.
 */
export function RoleChoice({
  actor,
  value,
  onChange,
  layer,
  className = "nt-row nt-ws-pick shrink-0 gap-1.5 px-2.5",
  align = "end",
}: {
  actor: WorkspaceRole;
  value: Invited;
  onChange: (role: Invited) => void;
  layer: "dropdown" | "modal";
  className?: string;
  /** The edge of the button the menu hangs from: its end at the end of a line. */
  align?: "start" | "end";
}) {
  return (
    <Menu
      label="Invite as"
      side="bottom"
      align={align}
      layer={layer}
      className="nt-ws-choices"
      trigger={(t) => (
        <button
          {...t}
          type="button"
          aria-label={`Invite as ${ROLE_LABEL[value].toLowerCase()}`}
          className={className}
        >
          {ROLE_LABEL[value]}
          <ChevronsUpDown width={14} height={14} aria-hidden="true" className="nt-ws-pick-glyph" />
        </button>
      )}
    >
      {(close) =>
        INVITED.map((role) => {
          const why = inviteProblem(actor, role);
          return (
            <MenuItem
              key={role}
              className="nt-ws-choice"
              disabled={!!why}
              onClick={() => {
                onChange(role);
                close();
              }}
            >
              <span className="nt-ws-choice-text">
                <span>{ROLE_LABEL[role]}</span>
                <span className="nt-ws-choice-hint">{why ?? ROLE_HINT[role]}</span>
              </span>
              <Check
                width={14}
                height={14}
                aria-hidden="true"
                className={`nt-menu-check${role === value ? " is-on" : ""}`}
              />
            </MenuItem>
          );
        })
      }
    </Menu>
  );
}

/**
 * Copying, with the word that says it worked: true for a moment after a copy
 * lands, for a `.nt-swap` to turn its glyph on. The copy answers whether the
 * browser allowed it, so a caller can offer another way when it did not.
 */
export function useCopied(): [boolean, (text: string) => Promise<boolean>] {
  const [copied, flash] = useMoment();
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      flash();
      return true;
    },
    [flash],
  );
  return [copied, copy];
}

/** Where an invitation's token opens, on this deployment. */
export function inviteUrl(token: string): string {
  return `${window.location.origin}${joinPath(token)}`;
}

/**
 * The link just made, to be handed on. Asking an address whose invitation was
 * still open makes it a new link and the old one stops working, which the note
 * says, since whoever holds the old one will find it dead.
 */
export function InviteLink({
  email,
  token,
  days,
  replaced,
  bare,
}: Sent & {
  /** Named by a key beside it rather than a label above. */
  bare?: boolean;
}) {
  const url = inviteUrl(token);
  const field = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [copied, copy] = useCopied();
  // Its end is the part that is this invitation's; the start is only where
  // Nootles lives, so that is what gives way. The Invite that made it is
  // refused again with the field emptied, so the focus it held moves on to
  // the next thing to do: copying.
  useEffect(() => {
    const input = field.current;
    if (input) input.scrollLeft = input.scrollWidth;
    button.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className={bare ? undefined : "pt-4"}>
      {!bare && <div className="nt-field-label">Invitation link</div>}
      <div className="flex items-center gap-1.5">
        <input
          ref={field}
          readOnly
          aria-label={`Invitation link for ${email}`}
          value={url.replace(/^https?:\/\//, "")}
          onFocus={(e) => e.currentTarget.select()}
          className="nt-input h-8 min-w-0 flex-1 py-0"
        />
        <button
          ref={button}
          type="button"
          // Refused: the link sits selected instead, one keystroke from copied.
          onClick={() => void copy(url).then((ok) => ok || field.current?.select())}
          aria-live="polite"
          data-done={copied || undefined}
          className="nt-row nt-solid nt-settle min-w-[5.5rem] shrink-0 justify-center gap-1.5 px-3 font-medium"
        >
          <span className="nt-swap" aria-hidden="true">
            <Copy width={14} height={14} />
            <Check width={14} height={14} />
          </span>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="nt-note mt-2 text-pretty">
        Send it to {email} yourself. It opens only for someone signed in with that address,
        for the next {days} {days === 1 ? "day" : "days"}.
        {replaced && " This link replaces the earlier one, which no longer works."}
      </p>
    </div>
  );
}
