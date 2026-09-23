"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { WorkspaceRole } from "@/convex/auth";
import { joinPath, settingsPath } from "@/app/lib/containerPaths";
import { Check, ChevronRight, ChevronsUpDown, Copy } from "../Icons";
import { Menu, MenuItem } from "../Menu";
import { Segmented, type Segment } from "../Segmented";
import type { WorkspaceContainer } from "./ContainerContext";
import { refusal } from "./refusal";
import { INVITED, inviteProblem, ROLE_HINT, ROLE_LABEL, type Invited } from "./seats";
import { useMoment } from "./useMoment";
import "./workspaces.css";

const DAY_MS = 86_400_000;

const HOW =
  "You’ll get a link to send them yourself. It opens only for someone signed in with that address.";

const ROLES: readonly Segment<Invited>[] = INVITED.map((role) => ({
  id: role,
  label: ROLE_LABEL[role],
  hint: ROLE_HINT[role],
}));

/**
 * Inviting someone, from the workspace's home: a popover on the Invite button
 * in the share popover's dress, since this too is a thing you do and copy,
 * not a task that needs the page taken away. Admins and owners only — the
 * caller decides whether to draw it; the server decides whether it works.
 */
export function InviteButton({ workspace }: { workspace: WorkspaceContainer }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="nt-row nt-ws-invite px-2.5"
      >
        Invite
      </button>
      {open && <InvitePopover workspace={workspace} anchor={trigger} onClose={close} />}
    </>
  );
}

function InvitePopover({
  workspace,
  anchor,
  onClose,
}: {
  workspace: WorkspaceContainer;
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  // Under the button, its right edge on the button's: it sits at the end of
  // the header, and grows from the corner that touches what raised it.
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const t = anchor.current;
      const p = pop.current;
      if (!t || !p) return;
      const r = t.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, r.right - p.offsetWidth),
        window.innerWidth - p.offsetWidth - 8,
      );
      setPos({ top: r.bottom + 6, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      {/* Pointer-only dismissal; keyboard users get Escape and Tab-out. */}
      <div
        className="fixed inset-0"
        style={{ zIndex: "var(--z-dropdown)" }}
        onMouseDown={onClose}
      />
      <div
        ref={pop}
        role="dialog"
        aria-label={`Invite people to ${workspace.name}`}
        // Tabbing out of the last control closes it rather than stranding
        // focus behind the click-catcher, like a menu's Tab.
        onBlur={(e) => {
          if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) {
            onClose();
          }
        }}
        // Never a scroller: what it holds is a form and a link, which fit any
        // window, and a scroller would clip the role switch's hints.
        className="nt-menu nt-ws-invite-pop fixed w-[22rem] max-w-[calc(100vw-1rem)] p-3"
        style={
          {
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? undefined : "hidden",
            "--origin": "top right",
          } as React.CSSProperties
        }
      >
        {/* Mounted once placed: a hidden field refuses the focus it asks for. */}
        {pos && <InviteForm workspace={workspace} autoFocus />}
        {/* The way on to everyone, set apart from the notes above it as a
            row with somewhere to go. */}
        <div className="nt-menu-sep mx-0 mt-3" />
        <Link
          href={settingsPath(workspace.slug, "members")}
          className="nt-row nt-ws-onward -mx-2 -mb-2 w-[calc(100%+1rem)] justify-between px-2"
        >
          Members and invitations
          <ChevronRight width={14} height={14} aria-hidden="true" className="nt-ws-onward-glyph" />
        </Link>
      </div>
    </>,
    document.body,
  );
}

/**
 * An address, a role, and the link that lets them in. Nootles sends no mail:
 * the link is handed back to be sent however the team talks, and it opens
 * only for someone signed in with the address it was made for.
 *
 * Two dresses for one form. In the home's popover the role is a switch beside
 * the label, and only an owner — the one who has a choice — sees it. On the
 * members screen it is one line, the role a menu in the middle of it, and an
 * admin sees the admin seat refused with the reason rather than missing.
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
  const invite = useMutation(api.members.invite);
  const auto = useId();
  // The members screen holds one form, so it can be found by name.
  const id = inline ? "nt-ws-invite" : auto;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Invited>("member");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The last problem, still said while its line folds away under a link:
  // cleared by typing, it would otherwise turn back into the how-to as it goes.
  const [said, setSaid] = useState<string | null>(null);
  const [sent, setSent] = useState<{
    email: string;
    token: string;
    days: number;
    replaced: boolean;
  } | null>(null);
  const owner = workspace.role === "owner";
  // One line under the field, saying how inviting works until something goes
  // wrong and then what did — in place, so nothing below it moves.
  const note = problem ?? (sent && said) ?? HOW;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    if (!to || busy) return;
    setBusy(true);
    try {
      const made = await invite({
        workspaceId: workspace.workspaceId,
        email: to,
        role: owner ? role : "member",
      });
      setSent({
        email: to.toLowerCase(),
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

  return (
    <form onSubmit={submit} noValidate>
      {inline ? (
        <label htmlFor={`${id}-email`} className="sr-only">
          Email address
        </label>
      ) : (
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label htmlFor={`${id}-email`} className="nt-field-label mb-0">
            Invite someone
          </label>
          {owner && <Segmented label="Invite as" segments={ROLES} value={role} onChange={setRole} />}
        </div>
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
          onChange={(e) => {
            setEmail(e.target.value);
            setProblem(null);
          }}
          className="nt-input h-8 min-w-0 flex-1 py-0"
        />
        {inline && <RoleChoice actor={workspace.role} value={role} onChange={setRole} />}
        <button
          type="submit"
          disabled={!email.trim() || busy}
          className="nt-row nt-solid shrink-0 px-3 font-medium"
        >
          {busy ? "Inviting…" : "Invite"}
        </button>
      </div>
      {/* Once there is a link, the how-to folds away as the link folds in, the
          two at one pace, so the form grows by the difference and nothing
          below it jumps. A problem after that folds back in above the link. */}
      <div className="nt-ws-fold" data-open={!sent || !!problem}>
        <div className="nt-ws-fold-body">
          <p
            id={`${id}-note`}
            aria-live="polite"
            className={`nt-note pt-2 text-pretty${problem ? " text-danger" : ""}`}
          >
            {note}
          </p>
        </div>
      </div>
      {sent && (
        <div className="nt-ws-fold is-arriving">
          <div className="nt-ws-fold-body">
            <InviteLink key={sent.token} {...sent} />
          </div>
        </div>
      )}
    </form>
  );
}

/**
 * The seat an invitation asks for, as a menu: each role with what it may do,
 * and the ones this inviter may not hand out refused with the reason in the
 * place the description would be.
 */
function RoleChoice({
  actor,
  value,
  onChange,
}: {
  actor: WorkspaceRole;
  value: Invited;
  onChange: (role: Invited) => void;
}) {
  return (
    <Menu
      label="Invite as"
      side="bottom"
      align="end"
      className="nt-ws-choices"
      trigger={(t) => (
        <button
          {...t}
          type="button"
          aria-label={`Invite as ${ROLE_LABEL[value].toLowerCase()}`}
          className="nt-row nt-ws-pick shrink-0 gap-1.5 px-2.5"
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
function InviteLink({
  email,
  token,
  days,
  replaced,
}: {
  email: string;
  token: string;
  days: number;
  replaced: boolean;
}) {
  const url = inviteUrl(token);
  const field = useRef<HTMLInputElement>(null);
  const [copied, copy] = useCopied();

  return (
    <div className="nt-ws-sent pt-4">
      <div className="nt-field-label">Invitation link</div>
      <div className="flex items-center gap-1.5">
        <input
          ref={field}
          readOnly
          aria-label={`Invitation link for ${email}`}
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="nt-input h-8 min-w-0 flex-1 py-0"
        />
        <button
          type="button"
          // Refused: the link sits selected instead, one keystroke from copied.
          onClick={() => void copy(url).then((ok) => ok || field.current?.select())}
          aria-live="polite"
          data-done={copied || undefined}
          className="nt-row nt-solid min-w-[5.5rem] shrink-0 justify-center gap-1.5 px-3 font-medium"
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
