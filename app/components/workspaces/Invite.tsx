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
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { joinPath, settingsPath } from "@/app/lib/containerPaths";
import { Check, Copy } from "../Icons";
import { Segmented, type Segment } from "../Segmented";
import type { WorkspaceContainer } from "./ContainerContext";
import "./workspaces.css";

type Invited = "member" | "admin";

const DAY_MS = 86_400_000;

const ROLES: readonly Segment<Invited>[] = [
  { id: "member", label: "Member", hint: "Sees the workspace’s projects and makes new ones" },
  { id: "admin", label: "Admin", hint: "Also invites people and runs the workspace’s settings" },
];

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
        className="nt-row px-2.5"
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
        className="nt-menu fixed w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto p-3"
        style={
          {
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            maxHeight: pos ? `calc(100dvh - ${pos.top + 8}px)` : undefined,
            visibility: pos ? undefined : "hidden",
            "--origin": "top right",
          } as React.CSSProperties
        }
      >
        {/* Mounted once placed: a hidden field refuses the focus it asks for. */}
        {pos && <InviteForm workspace={workspace} autoFocus />}
        <Link
          href={settingsPath(workspace.slug, "members")}
          className="nt-note mt-3 inline-block hover:underline"
        >
          Members and invitations
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
 * Owners choose between member and admin; an admin's invitations are always
 * a member's (`mayAssignSeat`), so they are offered no choice to be refused.
 */
export function InviteForm({
  workspace,
  autoFocus,
}: {
  workspace: WorkspaceContainer;
  autoFocus?: boolean;
}) {
  const invite = useMutation(api.members.invite);
  const id = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Invited>("member");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; token: string; days: number } | null>(
    null,
  );
  const owner = workspace.role === "owner";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    if (!to || busy) return;
    setBusy(true);
    setProblem(null);
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
      });
      setEmail("");
    } catch (error) {
      setProblem(
        error instanceof ConvexError && typeof error.data === "string"
          ? error.data
          : "That invitation didn’t go through. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={`${id}-email`} className="nt-field-label mb-0">
          Invite by email
        </label>
        {owner && <Segmented label="Invite as" segments={ROLES} value={role} onChange={setRole} />}
      </div>
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
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => {
            setEmail(e.target.value);
            setProblem(null);
          }}
          className="nt-input min-w-0 flex-1"
        />
        <button
          type="submit"
          disabled={!email.trim() || busy}
          className="nt-row nt-solid shrink-0 px-3 font-medium"
        >
          {busy ? "Inviting…" : "Invite"}
        </button>
      </div>
      {problem && (
        <p id={`${id}-problem`} role="alert" className="nt-note mt-2 text-danger">
          {problem}
        </p>
      )}
      {sent && <InviteLink key={sent.token} {...sent} />}
    </form>
  );
}

function InviteLink({ email, token, days }: { email: string; token: string; days: number }) {
  const url = `${window.location.origin}${joinPath(token)}`;
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Refused: the link sits selected instead, one keystroke from copied.
      field.current?.select();
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="nt-ws-sent mt-4">
      <div className="nt-field-label">Invitation link</div>
      <div className="flex items-center gap-1.5">
        <input
          ref={field}
          readOnly
          aria-label={`Invitation link for ${email}`}
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="nt-input min-w-0 flex-1"
        />
        <button
          type="button"
          onClick={() => void copy()}
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
      </p>
    </div>
  );
}
