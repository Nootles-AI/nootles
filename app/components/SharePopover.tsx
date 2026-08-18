"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { track } from "@/app/lib/telemetry";
import { LinkIcon } from "./Icons";
import { Segmented, type Segment } from "./Segmented";
import "./share/access.css";

type LinkRole = "editor" | "viewer";

/** By code point, not char: a name starting with an emoji keeps it whole. */
function initial(name: string | null | undefined) {
  return (Array.from(name?.trim() ?? "")[0] ?? "?").toUpperCase();
}

const TABS: readonly Segment<LinkRole>[] = [
  {
    id: "editor",
    label: "Editor link",
    hint: "Anyone with it can view; signing in lets them edit",
  },
  {
    id: "viewer",
    label: "Viewer link",
    hint: "Anyone with it can view. Nobody can edit through it",
  },
];

/**
 * Sharing, from the sidebar head: one link per role, each its own tab.
 *
 * A popover on the Share button rather than a modal — sharing is a capability
 * you flip and copy, not a task that needs the page taken away. The two links
 * are deliberately separate capabilities rather than one link with a setting —
 * which URL you paste IS the decision, so handing someone view access can
 * never quietly become handing them the pen. Turning a link off revokes it:
 * the URL dies, and so does the access of everyone who signed in through it.
 */
export function SharePopover({ projectId }: { projectId: Id<"projects"> }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        aria-label="Share project"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Share project"
        className="nt-icon-btn"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <LinkIcon />
      </button>
      {open && (
        <SharePopoverBody
          projectId={projectId}
          anchor={triggerRef}
          onClose={close}
        />
      )}
    </>
  );
}

function SharePopoverBody({
  projectId,
  anchor,
  onClose,
}: {
  projectId: Id<"projects">;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const links = useQuery(api.share.links, { projectId });
  const collaborators = useQuery(api.share.collaborators, { projectId });
  const setLink = useMutation(api.share.setLink);
  // The owner's whole inbox, narrowed here: the toast and this list are the
  // same question in two places, so they read the same query rather than two
  // that could disagree about who is still waiting.
  const waiting = (useQuery(api.share.incomingRequests) ?? []).filter(
    (ask) => ask.projectId === projectId,
  );
  const decide = useMutation(api.share.decideRequest);
  const { user: me } = useUser();

  const tipId = useId();
  const [role, setRole] = useState<LinkRole>("editor");
  const [copied, setCopied] = useState<LinkRole | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Fixed from the trigger's measured rect, like every anchored surface here,
  // so the sidebar's overflow can never clip it.
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const t = anchor.current;
      const p = popRef.current;
      if (!t || !p) return;
      const r = t.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, r.left),
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

  // The popover mounts hidden until measured, and a hidden element refuses
  // focus — so focus follows the first placement rather than the mount. Once
  // only: re-placing on scroll must never steal focus back from a control.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    popRef.current?.focus();
  }, [pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const inputRef = useRef<HTMLInputElement>(null);
  const copy = async (token: string, which: LinkRole) => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/share/${token}`,
      );
    } catch {
      // Clipboard refused (permissions, or the gesture expired while the
      // create mutation ran). Hand over the manual path instead of claiming
      // success: the URL sits selected, one keystroke from copied. A frame
      // later because on the create path the input has not mounted yet.
      requestAnimationFrame(() => inputRef.current?.select());
      return;
    }
    setCopied(which);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
    track("share_link_copied", { role: which });
  };

  const token = links ? links[role] : null;

  return (
    <>
      {/* Pointer-only dismissal; keyboard users get Escape and Tab-out. */}
      <div
        className="fixed inset-0"
        style={{ zIndex: "var(--z-dropdown)" }}
        onMouseDown={onClose}
      />
      <div
        ref={popRef}
        role="dialog"
        aria-label="Share project"
        tabIndex={-1}
        // Tabbing past the last control would strand focus behind the scrim,
        // on things only the keyboard can reach — so leaving closes, same as
        // Menu's Tab contract. `relatedTarget` is null on clicks into the
        // popover's own padding; those must not count as leaving.
        onBlur={(e) => {
          if (
            e.relatedTarget instanceof Node &&
            !e.currentTarget.contains(e.relatedTarget)
          )
            onClose();
        }}
        // The container takes focus only to bootstrap the keyboard into the
        // dialog — the control focus ring is not its to wear.
        className="nt-menu fixed w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto p-3 outline-none"
        style={{
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          // On a window too short for the whole popover, it scrolls rather
          // than running off the bottom edge.
          maxHeight: pos ? `calc(100dvh - ${pos.top + 8}px)` : undefined,
          visibility: pos ? undefined : "hidden",
        }}
      >
        <Segmented
          label="Share links"
          segments={TABS}
          value={role}
          onChange={setRole}
        />

        {links === undefined ? (
          // The shape of the link row, so the popover opens at its size
          // instead of growing under the pointer when the query lands.
          <div aria-hidden className="nt-skeleton mt-3 h-9" />
        ) : token ? (
          <>
            <div className="mt-3 flex items-center gap-1.5">
              <input
                ref={inputRef}
                readOnly
                aria-label={`${role === "editor" ? "Editor" : "Viewer"} link`}
                value={`${window.location.origin}/share/${token}`}
                onFocus={(e) => e.currentTarget.select()}
                className="nt-input min-w-0 flex-1"
              />
              <button
                onClick={() => void copy(token, role)}
                aria-live="polite"
                className="nt-row nt-solid min-w-[4.5rem] shrink-0 justify-center px-3 font-medium"
              >
                {copied === role ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="nt-note mt-2 text-pretty">
              {role === "editor"
                ? "Anyone with this link can view; signing in lets them edit."
                : "Anyone with this link can view. Nobody can edit through it."}
            </p>
            <button
              onClick={() => {
                void setLink({ projectId, role, enabled: false });
                track("share_link_toggled", { role, on: false });
              }}
              aria-describedby={`${tipId}-off`}
              data-tip="The link stops working, and everyone who signed in through it loses access"
              className="nt-row nt-tip mt-1 -mx-2.5 px-2.5 text-danger"
            >
              Turn off link
              {/* The same words for a screen reader, which never sees the tooltip. */}
              <span id={`${tipId}-off`} className="sr-only">
                The link stops working, and everyone who signed in through it
                loses access
              </span>
            </button>
          </>
        ) : (
          <>
            <p className="nt-note mt-3 text-pretty">
              {role === "editor"
                ? "Off. Nobody can view or edit through an editor link."
                : "Off. Nobody can view through a viewer link."}
            </p>
            <button
              onClick={() => {
                void setLink({ projectId, role, enabled: true }).then((t) => {
                  if (t) void copy(t, role);
                });
                track("share_link_toggled", { role, on: true });
              }}
              className="nt-row nt-solid mt-2 px-3 font-medium"
            >
              Create {role} link
            </button>
          </>
        )}

        {waiting.length > 0 && (
          <div className="mt-4">
            <div className="nt-field-label">
              Waiting to edit
              <span className="nt-field-note">{waiting.length}</span>
            </div>
            <ul aria-label="People waiting to edit" className="space-y-px">
              {waiting.map((ask) => (
                <li key={ask.requestId} className="nt-ask-row">
                  {ask.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={ask.imageUrl}
                      alt=""
                      className="h-5 w-5 shrink-0 rounded-full"
                    />
                  ) : (
                    <span aria-hidden className="nt-monogram shrink-0">
                      {initial(ask.name ?? ask.email)}
                    </span>
                  )}
                  <span className="nt-ask-row-name">
                    {ask.name ?? ask.email ?? "Someone"}
                  </span>
                  <button
                    className="nt-ask-no"
                    onClick={() => {
                      track("access_request_decided", { grant: false });
                      void decide({
                        requestId: ask.requestId,
                        grant: false,
                      }).catch(() => {});
                    }}
                  >
                    Not now
                  </button>
                  <button
                    className="nt-ask-yes"
                    onClick={() => {
                      track("access_request_decided", { grant: true });
                      void decide({
                        requestId: ask.requestId,
                        grant: true,
                      }).catch(() => {});
                    }}
                  >
                    Give edit access
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {collaborators === undefined ? (
          <div aria-hidden className="mt-4">
            <div className="nt-skeleton h-3.5 w-28" />
            <div className="nt-skeleton mt-2.5 h-8" />
          </div>
        ) : (
          <div className="mt-4">
            <div className="nt-field-label">
              People with access
              <span className="nt-field-note">{collaborators.length + 1}</span>
            </div>
            <ul
              aria-label="People with access"
              className="max-h-56 space-y-px overflow-y-auto"
            >
              {/* The list answers "who has access", so it starts with the one
                  person who always does. Alone, the row is also the answer to
                  "has anyone joined yet": only you. */}
              <li className="flex h-8 items-center gap-2">
                <span aria-hidden className="nt-monogram shrink-0">
                  {initial(
                    me?.fullName?.trim() ||
                      me?.primaryEmailAddress?.emailAddress,
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">You</span>
                <span className="shrink-0 text-[13px] text-muted">Owner</span>
              </li>
              {collaborators.map((person) => (
                <li
                  key={person.granteeId}
                  className="flex h-8 items-center gap-2"
                >
                  {person.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={person.imageUrl}
                      alt=""
                      className="h-5 w-5 shrink-0 rounded-full"
                    />
                  ) : (
                    <span aria-hidden className="nt-monogram shrink-0">
                      {initial(person.name ?? person.email)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {person.name ?? person.email ?? "Someone"}
                  </span>
                  <span className="shrink-0 text-[13px] text-muted">
                    {person.role === "editor" ? "Editor" : "Viewer"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
