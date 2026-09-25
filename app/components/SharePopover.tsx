"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { settingsPath } from "@/app/lib/containerPaths";
import { track } from "@/app/lib/telemetry";
import { Check, ChevronsUpDown, Code, Copy, LinkIcon, MoreHorizontal } from "./Icons";
import { Menu, MenuItem } from "./Menu";
import { Segmented, type Segment } from "./Segmented";
import { Tooltip } from "./Tooltip";
import { dayOf, LIFETIMES, lifetimeLabel, runsOutAt } from "./share/expiry";
import { useContainer } from "./workspaces/ContainerContext";
import { Tile } from "./workspaces/places";
import { refusal } from "./workspaces/refusal";
import { useMoment } from "./workspaces/useMoment";
import "./share/access.css";
import "./workspaces/workspaces.css";

type LinkRole = "editor" | "commenter" | "viewer";
type Collaborator = FunctionReturnType<typeof api.share.collaborators>[number];

/** Someone on their way out of the list, as their row was, and the row it followed. */
type Departure = { person: Collaborator; after: string | null };

/** How long a leaving row takes to close up: its fade, then its height (access.css). */
const COLLAPSE_MS = 270;

/**
 * The people to draw: those the server lists, with anyone still closing up
 * back in their place though the server has already let them go.
 */
function withDepartures(
  listed: readonly Collaborator[],
  leaving: ReadonlyMap<string, Departure>,
): Collaborator[] {
  const rows = [...listed];
  for (const [id, { person, after }] of leaving) {
    if (rows.some((p) => p.granteeId === id)) continue;
    rows.splice(after === null ? 0 : rows.findIndex((p) => p.granteeId === after) + 1, 0, person);
  }
  return rows;
}

function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** By code point, not char: a name starting with an emoji keeps it whole. */
function initial(name: string | null | undefined) {
  return (Array.from(name?.trim() ?? "")[0] ?? "?").toUpperCase();
}

/** Each link's name, as its field is labelled. */
const NAME: Record<LinkRole, string> = { editor: "Editor", commenter: "Commenter", viewer: "Viewer" };

/**
 * What each person's row says they hold. A workspace project's list sits under
 * the workspace's own row, which says what its people can do, so every row
 * there says the same kind of thing; elsewhere the three roles are named.
 */
const HOLDS = {
  role: { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" },
  can: { owner: "Can manage", editor: "Can edit", commenter: "Can comment", viewer: "Can view" },
} as const;

/**
 * What a link does, as its tab and the note under it say it. A workspace's
 * links open only for someone signed in, so there is no viewing without it.
 */
const SAYS = {
  anyone: {
    editor: "Anyone with this link can view; signing in lets them edit.",
    commenter: "Anyone with this link can view; signing in lets them comment.",
    viewer: "Anyone with this link can view. Nobody can edit through it.",
  },
  signedIn: {
    editor: "Anyone signed in who has this link can edit.",
    commenter: "Anyone signed in who has this link can comment. Nobody can edit through it.",
    viewer: "Anyone signed in who has this link can view. Nobody can edit through it.",
  },
} as const;

/** What a link not yet made would do, for the note that offers to make it. */
const WOULD = {
  anyone: {
    editor: "anyone who has it can view, and edit once signed in",
    commenter: "anyone who has it can view, and comment once signed in",
    viewer: "anyone who has it can view",
  },
  signedIn: {
    editor: "anyone signed in who has it can edit",
    commenter: "anyone signed in who has it can comment",
    viewer: "anyone signed in who has it can view",
  },
} as const;

const TABS: Record<keyof typeof SAYS, readonly Segment<LinkRole>[]> = {
  anyone: [
    { id: "editor", label: "Editor link", hint: "Anyone with it can view; signing in lets them edit" },
    {
      id: "commenter",
      label: "Commenter link",
      hint: "Anyone with it can view; signing in lets them comment",
    },
    { id: "viewer", label: "Viewer link", hint: "Anyone with it can view. Nobody can edit through it" },
  ],
  signedIn: [
    { id: "editor", label: "Editor link", hint: "Anyone signed in who has it can edit" },
    { id: "commenter", label: "Commenter link", hint: "Anyone signed in who has it can comment" },
    {
      id: "viewer",
      label: "Viewer link",
      hint: "Anyone signed in who has it can view. Nobody can edit through it",
    },
  ],
};

/** A row's ⋯, there on hover or focus, and always where there is no hover. */
const ROW_MENU =
  "nt-icon-btn is-sm nt-ws-row-menu opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100";

/**
 * Sharing, from the sidebar head: one link per role — editor, commenter,
 * viewer — each its own tab.
 *
 * A popover on the Share button rather than a modal — sharing is a capability
 * you flip and copy, not a task that needs the page taken away. The links
 * are deliberately separate capabilities rather than one link with a setting —
 * which URL you paste IS the decision, so handing someone view access can
 * never quietly become handing them the pen. Turning a link off revokes it:
 * the URL dies, and so does the access of everyone who signed in through it.
 *
 * An editor gets the same popover to send from: every link, to copy or to
 * make. Everything that changes who already has access — a
 * link turned off, its expiry, the people and their requests — is its
 * managers' alone, and not drawn.
 */
export function SharePopover({
  projectId,
  manages,
}: {
  projectId: Id<"projects">;
  manages: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The popover outlives `open` by its exit animation, like Menu's.
  const [leaving, setLeaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setLeaving(true);
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
        onClick={() => {
          if (open) return close();
          setLeaving(false);
          setOpen(true);
        }}
      >
        <LinkIcon />
      </button>
      {(open || leaving) && (
        <SharePopoverBody
          projectId={projectId}
          manages={manages}
          anchor={triggerRef}
          closing={!open}
          onClose={close}
          onGone={() => setLeaving(false)}
        />
      )}
    </>
  );
}

function SharePopoverBody({
  projectId,
  manages,
  anchor,
  closing,
  onClose,
  onGone,
}: {
  projectId: Id<"projects">;
  manages: boolean;
  anchor: React.RefObject<HTMLButtonElement | null>;
  /** On its way out: drawn, but no longer answering anything. */
  closing: boolean;
  onClose: () => void;
  onGone: () => void;
}) {
  const links = useQuery(api.share.links, { projectId });
  const collaborators = useQuery(api.share.collaborators, manages ? { projectId } : "skip");
  // In a workspace, most of who can reach a project is who is in it: the
  // popover says so before the links, so nobody sends one to a teammate who
  // needed none. A private one is its maker's and the workspace's owners' and
  // admins' — the maker named, when they are neither and not you.
  const container = useContainer();
  const project = useQuery(api.projects.get, { projectId });
  const workspace =
    container.kind === "workspace" && project?.workspaceId === container.workspaceId
      ? container
      : null;
  const hidden = project?.visibility === "private";
  const people = useQuery(
    api.members.list,
    manages && workspace && hidden ? { workspaceId: workspace.workspaceId } : "skip",
  );
  const maker = hidden
    ? people?.members.find((m) => m.userId === project.ownerId && !m.isMe && m.role === "member")
    : undefined;
  const holds = workspace ? HOLDS.can : HOLDS.role;
  // A guest reads a project's code only where the workspace allows guests
  // code at all and there is code linked to read; only then is it offered.
  // The same subscription the workspace's route already holds.
  const settings = useQuery(
    api.workspaces.bySlug,
    manages && workspace ? { slug: workspace.slug } : "skip",
  )?.workspace.settings;
  const guests = !!collaborators?.some((person) => person.guest);
  const repos = useQuery(
    api.github.repos.listForProject,
    guests && settings?.guestCodeAccess ? { projectId } : "skip",
  );
  const offersCode = !!settings?.guestCodeAccess && !!repos?.length;
  const setLink = useMutation(api.share.setLink);
  // The owner's whole inbox, narrowed here: the toast and this list are the
  // same question in two places, so they read the same query rather than two
  // that could disagree about who is still waiting.
  const waiting = (useQuery(api.share.incomingRequests, manages ? {} : "skip") ?? []).filter(
    (ask) => ask.projectId === projectId,
  );
  const decide = useMutation(api.share.decideRequest);
  const { user: me } = useUser();

  const tipId = useId();
  const [role, setRole] = useState<LinkRole>("editor");
  const [copied, setCopied] = useState<LinkRole | null>(null);
  // Fixed for the visit: a link's day does not need to tick.
  const [now] = useState(() => Date.now());
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  // Turning a link off kills its address for good, so it is asked twice.
  const [offAsked, setOffAsked] = useState(false);
  const offRef = useRef<HTMLButtonElement>(null);
  const [peopleProblem, setPeopleProblem] = useState<string | null>(null);
  // An answered request is on its way out: it fades while the server agrees,
  // rather than sitting there looking unanswered until the list redraws.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // Likewise someone whose access was just taken away, and they leave the
  // count with their row. The row stays drawn until it has closed up, even
  // once the server has let them go; after that, never again this visit.
  const [leaving, setLeaving] = useState<ReadonlyMap<string, Departure>>(new Map());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const rows =
    collaborators &&
    withDepartures(
      collaborators.filter((p) => !gone.has(p.granteeId)),
      leaving,
    );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Fixed from the trigger's measured rect, like every anchored surface here,
  // so the sidebar's overflow can never clip it. Portaled to body below: the
  // sidebar's `.nt-panel` sets its own z-index, which caps every descendant's
  // stacking regardless of `fixed` position — a mount-in-place popover here
  // would still render under the sidebar's resize handle.
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(
    null,
  );
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
      // Grown from under the trigger, wherever the edge pushed the box.
      setPos({ top: r.bottom + 6, left, origin: `top ${r.left + r.width / 2 - left}px` });
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
    if (closing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // A question on screen is answered first: Escape is its Cancel.
      if (offAsked) {
        setOffAsked(false);
        requestAnimationFrame(() => offRef.current?.focus());
      } else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, closing, offAsked]);

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
    timer.current = setTimeout(() => setCopied(null), 1600);
    track("share_link_copied", { role: which });
  };

  const create = () => {
    setLinkProblem(null);
    setOffAsked(false);
    setLink({ projectId, role, enabled: true })
      .then((t) => {
        if (t) void copy(t, role);
      })
      .catch((error) =>
        setLinkProblem(refusal(error, "That link wasn’t made. Try again in a moment.")),
      );
    track("share_link_toggled", { role, on: true });
  };

  const waitingOut = rows?.filter((p) => p.paused && !leaving.has(p.granteeId)).length ?? 0;
  const token = links ? links[role] : null;
  const until = links ? links.expiresAt[role] : null;
  // A link that has run out admits nobody; turning it on again mints another.
  const ranOut = token && until !== null && until <= now ? until : null;
  const lapsed = ranOut !== null;
  // Until the project says which home it is in, the page it is open in is
  // the likely answer.
  const inWorkspace = project ? !!project.workspaceId : container.kind === "workspace";
  const says = inWorkspace ? "signedIn" : "anyone";
  // Whether someone removed could come straight back: a claim is kept by any
  // live link, not only the one it came through.
  const liveLinks =
    links && links.allowed !== false
      ? (["editor", "commenter", "viewer"] as const).filter(
          (r) => !!links[r] && (links.expiresAt[r] === null || links.expiresAt[r] > now),
        )
      : [];

  return createPortal(
    <>
      {/* Pointer-only dismissal; keyboard users get Escape and Tab-out. */}
      {!closing && (
        <div
          className="fixed inset-0"
          // The popover layer, above the modal one: on a phone the Share
          // button is inside the sidebar drawer, which sits at the modal layer
          // itself (NT-76).
          style={{ zIndex: "var(--z-popover)" }}
          onMouseDown={onClose}
        />
      )}
      <div
        ref={popRef}
        role="dialog"
        aria-label="Share project"
        tabIndex={-1}
        // Tabbing past the last control would strand focus behind the scrim,
        // on things only the keyboard can reach — so leaving closes, same as
        // Menu's Tab contract. `relatedTarget` is null on clicks into the
        // popover's own padding; those must not count as leaving. Nor does
        // going into a menu raised from a row here, which is portaled out of
        // the popover's box but not out of it.
        onBlur={(e) => {
          const to = e.relatedTarget;
          if (
            !closing &&
            to instanceof Element &&
            !e.currentTarget.contains(to) &&
            !to.closest("[role='menu']")
          )
            onClose();
        }}
        // The container takes focus only to bootstrap the keyboard into the
        // dialog — the control focus ring is not its to wear.
        inert={closing}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onGone();
        }}
        className={`nt-menu fixed w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto p-3 outline-none${
          closing ? " is-closing" : ""
        }`}
        style={{
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          "--origin": pos?.origin,
          // On a window too short for the whole popover, it scrolls rather
          // than running off the bottom edge.
          maxHeight: pos ? `calc(100dvh - ${pos.top + 8}px)` : undefined,
          visibility: pos ? undefined : "hidden",
          zIndex: "var(--z-popover)",
        } as React.CSSProperties}
      >
        {/* A workspace comes first, under its own label: everyone its
            membership lets in, as one row, said before any link is offered —
            and not among the people, whose count is of the rows under them. */}
        {project === undefined && container.kind === "workspace" ? (
          <div aria-hidden className="mb-4">
            <div className="nt-skeleton h-3.5 w-20" />
            <div className="nt-skeleton mt-2.5 h-8" />
          </div>
        ) : (
          workspace && (
            <div className="mb-4">
              <div className="nt-field-label">Workspace</div>
              <div className="flex h-8 items-center gap-2">
                <Tile name={workspace.name} icon={workspace.icon} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-ui)]">
                  {hidden
                    ? `${workspace.name}’s owners and admins`
                    : `Everyone in ${workspace.name}`}
                </span>
                <span className="shrink-0 text-[length:var(--text-ui)] text-muted">
                  {hidden ? "Can manage" : "Can edit"}
                </span>
              </div>
            </div>
          )
        )}

        {links === undefined && container.kind === "workspace" ? (
          // A workspace may allow no links at all, so not even the tabs are
          // drawn before it has said.
          <div aria-hidden>
            <div className="nt-skeleton h-6 w-44" />
            <div className="nt-skeleton mt-3 h-8" />
          </div>
        ) : links?.allowed === false ? (
          // No links at all here: the tabs would offer what cannot be had.
          // Whoever came in by one is only waiting, and is said to be.
          <p className="nt-note text-pretty">
            Share links are turned off in {workspace?.name ?? "this workspace"}, so nobody can
            open this project through one.
            {manages && " "}
            {manages && (waitingOut > 0
              ? `${waitingOut === 1 ? "The person" : `The ${waitingOut} people`} who joined by link will be back when links are turned on again`
              : "They can be turned back on")}
            {!manages ? null : workspace ? (
              <>
                {" in "}
                <Link href={settingsPath(workspace.slug)} className="nt-ws-aside-link">
                  workspace settings
                </Link>
                .
              </>
            ) : (
              "."
            )}
          </p>
        ) : (
          <>
            <Segmented
              label="Share links"
              segments={TABS[says]}
              value={role}
              onChange={(next) => {
                setRole(next);
                setOffAsked(false);
                setLinkProblem(null);
              }}
              chosenSaidBelow={!!token && !lapsed}
            />

            {links === undefined ? (
              // The shape of the link row, so the popover opens at its size
              // instead of growing under the pointer when the query lands.
              <div aria-hidden className="nt-skeleton mt-3 h-8" />
            ) : token && !lapsed ? (
              <>
                <div className="mt-3 flex items-center gap-1.5">
                  <input
                    ref={inputRef}
                    readOnly
                    aria-label={`${NAME[role]} link`}
                    value={`${window.location.origin}/share/${token}`}
                    onFocus={(e) => e.currentTarget.select()}
                    className="nt-input h-8 min-w-0 flex-1 py-0"
                  />
                  <button
                    onClick={() => void copy(token, role)}
                    aria-live="polite"
                    data-done={copied === role || undefined}
                    className="nt-row nt-solid min-w-[5.5rem] shrink-0 justify-center gap-1.5 px-3 font-medium"
                  >
                    {/* Two glyphs in one seat: the tick takes it while the word
                        says so, and gives it back. */}
                    <span className="nt-swap" aria-hidden="true">
                      <Copy width={14} height={14} />
                      <Check width={14} height={14} />
                    </span>
                    {copied === role ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="nt-note mt-2 text-pretty">
                  {SAYS[says][role]}
                  {/* Theirs to see, not to move: the lifetime is the managers'. */}
                  {!manages && until !== null && ` It expires ${dayOf(until, now)}.`}
                </p>
                {!manages ? null : offAsked ? (
                  <div role="group" aria-labelledby={`${tipId}-ask`} className="mt-3">
                    <p id={`${tipId}-ask`} className="nt-note text-pretty">
                      Turn off the {role} link? Its address stops working for good, and a new
                      link will have a new one. People who joined through it lose the access it
                      gave them.
                    </p>
                    <div className="mt-2 -mr-2 flex justify-end gap-1">
                      <button
                        autoFocus
                        onClick={() => {
                          setOffAsked(false);
                          requestAnimationFrame(() => offRef.current?.focus());
                        }}
                        className="nt-row px-2.5"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          setOffAsked(false);
                          setLinkProblem(null);
                          setLink({ projectId, role, enabled: false }).catch((error) =>
                            setLinkProblem(
                              refusal(error, "That link is still on. Try again in a moment."),
                            ),
                          );
                          track("share_link_toggled", { role, on: false });
                        }}
                        className="nt-row px-2.5 font-medium text-danger"
                      >
                        Turn off
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="nt-share-link-foot mt-1 -mx-2 flex items-center justify-between gap-2">
                    <LinkLifetime
                      // Each link its own: a tick given for one never shows on
                      // the other's tab.
                      key={role}
                      projectId={projectId}
                      role={role}
                      until={until}
                      now={now}
                      onProblem={setLinkProblem}
                    />
                    <button
                      ref={offRef}
                      onClick={() => {
                        setLinkProblem(null);
                        setOffAsked(true);
                      }}
                      aria-describedby={`${tipId}-off`}
                      data-tip="Its address stops working for good, and whoever joined through it loses that access"
                      className="nt-row nt-tip shrink-0 px-2 text-danger"
                    >
                      Turn off link
                      {/* The same words for a screen reader, which never sees the tooltip. */}
                      <span id={`${tipId}-off`} className="sr-only">
                        Its address stops working for good, and whoever joined through it loses
                        that access
                      </span>
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="nt-note mt-3 text-pretty">
                  {ranOut !== null
                    ? `Expired on ${dayOf(ranOut, now)}. Nobody can ${
                        { editor: "view or edit", commenter: "view or comment", viewer: "view" }[role]
                      } through it now.`
                    : `There’s no ${role} link. Once one is made, ${WOULD[says][role]}.`}
                  {links.defaultDays !== null &&
                    ` New links expire after ${lifetimeLabel(links.defaultDays)}.`}
                </p>
                <button onClick={create} className="nt-row nt-solid mt-2 px-3 font-medium">
                  {lapsed ? `Create a new ${role} link` : `Create ${role} link`}
                </button>
              </>
            )}
            {linkProblem && (
              <p key={linkProblem} role="alert" className="nt-note nt-settle mt-2 text-pretty text-danger">
                {linkProblem}
              </p>
            )}
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
                <li
                  key={ask.requestId}
                  className={`nt-ask-row${answered.has(ask.requestId) ? " is-leaving" : ""}`}
                >
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
                      setAnswered((ids) => new Set(ids).add(ask.requestId));
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
                      setAnswered((ids) => new Set(ids).add(ask.requestId));
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

        {!manages ? null : rows === undefined ||
        project === undefined ||
        (workspace && hidden && people === undefined) ? (
          <div aria-hidden className="mt-4">
            <div className="nt-skeleton h-3.5 w-28" />
            <div className="nt-skeleton mt-2.5 h-8" />
          </div>
        ) : (
          <div className="mt-4">
            <div className="nt-field-label">
              People with access
              <span className="nt-field-note">
                {rows.filter((p) => !leaving.has(p.granteeId)).length +
                  1 +
                  (maker ? 1 : 0)}
              </span>
            </div>
            <ul
              aria-label="People with access"
              className="nt-share-people max-h-56 space-y-px overflow-y-auto"
            >
              {/* First the one person who always has access. Alone, the row
                  is also the answer to "has anyone joined yet": only you. */}
              <li className="flex h-8 items-center gap-2">
                <span aria-hidden className="nt-monogram shrink-0">
                  {initial(
                    me?.fullName?.trim() ||
                      me?.primaryEmailAddress?.emailAddress,
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-ui)]">You</span>
                <span className="shrink-0 text-[length:var(--text-ui)] text-muted">{holds.owner}</span>
              </li>
              {maker && (
                <li className="flex h-8 items-center gap-2">
                  {maker.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={maker.imageUrl}
                      alt=""
                      className="h-5 w-5 shrink-0 rounded-full"
                    />
                  ) : (
                    <span aria-hidden className="nt-monogram shrink-0">
                      {initial(maker.name ?? maker.email)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-ui)]">
                    {maker.name ?? maker.email ?? "Someone"}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-ui)] text-muted">{holds.editor}</span>
                </li>
              )}
              {rows.map((person, i) => (
                <Person
                  key={person.granteeId}
                  projectId={projectId}
                  person={person}
                  holds={
                    person.paused ? "Paused" : holds[person.role]
                  }
                  offersCode={offersCode && person.guest && !person.paused}
                  liveLinks={liveLinks}
                  leaving={leaving.has(person.granteeId)}
                  onLeaving={() =>
                    setLeaving((was) =>
                      new Map(was).set(person.granteeId, {
                        person,
                        after: i === 0 ? null : rows[i - 1].granteeId,
                      }),
                    )
                  }
                  onStayed={() => setLeaving((was) => without(was, person.granteeId))}
                  onLeft={() => {
                    setGone((was) => new Set(was).add(person.granteeId));
                    setLeaving((was) => without(was, person.granteeId));
                  }}
                  now={now}
                  onProblem={setPeopleProblem}
                  // Its row is going, ⋯ and all: focus waits on the popover.
                  onGone={() => popRef.current?.focus()}
                />
              ))}
            </ul>
            {peopleProblem && (
              <p key={peopleProblem} role="alert" className="nt-note nt-settle mt-2 text-pretty text-danger">
                {peopleProblem}
              </p>
            )}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

/**
 * When a link expires, and the choice of when: the day it does, as the
 * trigger of a menu of lifetimes counted from now.
 * A pick moves the link's day and its people's with it (`share.setLink`); the
 * trigger's glyph turns to a tick for a moment once the server has it.
 */
function LinkLifetime({
  projectId,
  role,
  until,
  now,
  onProblem,
}: {
  projectId: Id<"projects">;
  role: LinkRole;
  until: number | null;
  now: number;
  onProblem: (text: string | null) => void;
}) {
  const [saved, flash] = useMoment();
  const setLifetime = useMutation(api.share.setLink).withOptimisticUpdate((store, args) => {
    if (args.expiresInDays === undefined) return;
    const shown = store.getQuery(api.share.links, { projectId: args.projectId });
    if (!shown) return;
    // From the popover's own moment rather than this one: close enough for
    // the day it shows until the server's answer replaces it.
    const at = args.expiresInDays === null ? null : runsOutAt(args.expiresInDays, now);
    store.setQuery(
      api.share.links,
      { projectId: args.projectId },
      { ...shown, expiresAt: { ...shown.expiresAt, [args.role]: at } },
    );
  });

  const pick = (days: number | null) => {
    onProblem(null);
    setLifetime({ projectId, role, enabled: true, expiresInDays: days })
      .then(flash)
      .catch((error) =>
        onProblem(refusal(error, "That expiry didn’t save. Try again in a moment.")),
      );
  };

  const said = until === null ? "Never expires" : `Expires ${dayOf(until, now)}`;
  // The link keeps only its day, not the lifetime picked: the pick is the
  // lifetime that, counted from today, lands on that day.
  const chosen =
    until === null
      ? null
      : LIFETIMES.find(
          (days) => days !== null && dayOf(runsOutAt(days, now), now) === dayOf(until, now),
        );
  return (
    <Menu
      label="When the link expires"
      side="bottom"
      align="start"
      // Above the popover, and Escape closes this menu alone, not both.
      layer="modal"
      className="nt-ws-choices"
      trigger={(t) => (
        <button
          {...t}
          aria-label={`${said}. Change when the link expires`}
          data-done={saved || undefined}
          className="nt-row nt-ws-pick min-w-0 gap-1.5 px-2"
        >
          <span className="truncate text-muted">{said}</span>
          <span className="nt-swap nt-ws-pick-glyph" aria-hidden="true">
            <ChevronsUpDown width={14} height={14} />
            <Check width={14} height={14} />
          </span>
        </button>
      )}
    >
      {(close) => (
        <>
          {/* Set on another day, the link's lifetime matches none counted
              from today: its day is said here instead of a tick. */}
          {chosen === undefined && (
            <>
              <p className="nt-menu-caption">{said}.</p>
              <div className="nt-menu-sep" />
            </>
          )}
          {LIFETIMES.map((days) => (
            <MenuItem
              key={days ?? "never"}
              className="nt-ws-choice"
              onClick={() => {
                close();
                pick(days);
              }}
            >
              <span className="nt-ws-choice-text">
                <span>{lifetimeLabel(days)}</span>
                <span className="nt-ws-choice-hint">
                  {days === null
                    ? "Until you turn it off"
                    : `Expires ${dayOf(runsOutAt(days, now), now)}`}
                </span>
              </span>
              <Check
                width={14}
                height={14}
                aria-hidden="true"
                className={`nt-menu-check${days === chosen ? " is-on" : ""}`}
              />
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

/** What Remove access leaves open: the links that would let them straight back. */
function rejoinHint(live: readonly LinkRole[]): string {
  if (live.length === 0) return "They lose access now";
  if (live.length === 1) {
    return `They lose access now, but can rejoin through the ${live[0]} link while it’s on. Turn it off to keep them out`;
  }
  const names = `${live.slice(0, -1).join(", ")} or ${live[live.length - 1]}`;
  const all = live.length === 2 ? "both" : "them all";
  return `They lose access now, but can rejoin through the ${names} link while any is on. Turn ${all} off to keep them out`;
}

/**
 * Someone let in through a link, with what they hold and a ⋯ of what can be
 * done about it: their access taken away — the link stays, so while it works
 * they can come back by it — and, for a workspace's guest where the workspace
 * allows it and there is code linked, the project's code let in or out.
 */
function Person({
  projectId,
  person,
  holds,
  offersCode,
  liveLinks,
  leaving,
  onLeaving,
  onStayed,
  onLeft,
  now,
  onProblem,
  onGone,
}: {
  projectId: Id<"projects">;
  person: Collaborator;
  /** What the row says they can do. */
  holds: string;
  offersCode: boolean;
  /** The links still on that would let them straight back in. */
  liveLinks: readonly LinkRole[];
  leaving: boolean;
  onLeaving: () => void;
  /** Their access stayed after all: the row comes back. */
  onStayed: () => void;
  /** Their access is gone and their row has closed up. */
  onLeft: () => void;
  now: number;
  onProblem: (text: string | null) => void;
  /** Moves focus off the row, which is on its way out. */
  onGone: () => void;
}) {
  const revoke = useMutation(api.share.revokeClaim);
  const setCode = useMutation(api.share.setCodeAccess).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.share.collaborators, { projectId: args.projectId });
    if (!list) return;
    store.setQuery(
      api.share.collaborators,
      { projectId: args.projectId },
      list.map((p) => (p.granteeId === args.granteeId ? { ...p, codeAccess: args.allowed } : p)),
    );
  });
  const name = person.name ?? person.email ?? "Someone";

  const remove = () => {
    onProblem(null);
    // Leaves at once, and comes back if the server does not agree. When it
    // does, the row is let go only once it has closed up, so the rows under
    // it slide up rather than snap however fast the answer comes.
    onLeaving();
    onGone();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const closed = new Promise((done) => setTimeout(done, still ? 0 : COLLAPSE_MS));
    Promise.all([revoke({ projectId, granteeId: person.granteeId }), closed]).then(
      onLeft,
      (error) => {
        onStayed();
        onProblem(refusal(error, `Couldn’t remove ${name}’s access. Try again in a moment.`));
      },
    );
  };

  const toggleCode = () => {
    onProblem(null);
    setCode({ projectId, granteeId: person.granteeId, allowed: !person.codeAccess }).catch(
      (error) =>
        onProblem(refusal(error, `Couldn’t change ${name}’s code context. Try again in a moment.`)),
    );
  };

  return (
    <li className={`group flex h-8 items-center gap-2${leaving ? " is-leaving" : ""}`}>
      {person.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={person.imageUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
      ) : (
        <span aria-hidden className="nt-monogram shrink-0">
          {initial(person.name ?? person.email)}
        </span>
      )}
      <span
        className={`flex min-w-0 flex-1 items-center gap-1.5 text-[length:var(--text-ui)]${
          person.paused ? " text-muted" : ""
        }`}
      >
        <span className="truncate">{name}</span>
        {offersCode && person.codeAccess && (
          <Tooltip label="Sees code context" className="flex shrink-0 text-muted">
            <Code width={14} height={14} aria-hidden="true" />
            <span className="sr-only">, sees code context</span>
          </Tooltip>
        )}
      </span>
      {/* The ⋯ takes the role's seat as it appears, so every role in the
          list ends on the same edge as the workspace's above it. */}
      <span className="nt-share-hold">
        <span className="nt-share-hold-text text-[length:var(--text-ui)] text-muted">{holds}</span>
        <Menu
          label={`Access for ${name}`}
          side="bottom"
          align="end"
          layer="modal"
          className="nt-ws-choices"
          trigger={(t) => (
            <button {...t} aria-label={`Actions for ${name}`} className={ROW_MENU}>
              <MoreHorizontal />
            </button>
          )}
        >
          {(close) => (
            <>
              {person.paused ? (
                <>
                  <p className="nt-menu-caption">
                    Kept out while the workspace’s links are off.
                  </p>
                  <div className="nt-menu-sep" />
                </>
              ) : person.expiresAt !== null && (
                <>
                  <p className="nt-menu-caption">
                    Their access expires with the link on {dayOf(person.expiresAt, now)}.
                  </p>
                  <div className="nt-menu-sep" />
                </>
              )}
              {offersCode && (
                <>
                  <MenuItem
                    className="nt-ws-choice"
                    onClick={() => {
                      close();
                      toggleCode();
                    }}
                  >
                    <span className="nt-ws-choice-text">
                      <span>
                        Allow code context
                        <span className="sr-only">{person.codeAccess ? ", on" : ", off"}</span>
                      </span>
                      <span className="nt-ws-choice-hint">
                        Gives them the linked repositories as context too
                      </span>
                    </span>
                    <Check
                      width={14}
                      height={14}
                      aria-hidden="true"
                      className={`nt-menu-check${person.codeAccess ? " is-on" : ""}`}
                    />
                  </MenuItem>
                  <div className="nt-menu-sep" />
                </>
              )}
              <MenuItem
                danger
                className="nt-ws-choice"
                disabled={leaving}
                onClick={() => {
                  // Not back to this ⋯: the row it is on is leaving.
                  close({ restoreFocus: false });
                  remove();
                }}
              >
                <span className="nt-ws-choice-text">
                  <span>Remove access</span>
                  <span className="nt-ws-choice-hint">
                    {person.paused
                      ? "They won’t be back when links are turned on again"
                      : rejoinHint(liveLinks)}
                  </span>
                </span>
              </MenuItem>
            </>
          )}
        </Menu>
      </span>
    </li>
  );
}
