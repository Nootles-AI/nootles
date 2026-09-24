"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { atLeast, type WorkspaceRole } from "@/convex/roles";
import { homePath, settingsPath, type SettingsSection } from "@/app/lib/containerPaths";
import { Authed } from "../../Authed";
import { Wordmark } from "../../Brand";
import { SettingsLoading } from "../../settings/SettingsLoading";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import "../../settings/settings.css";
import "../workspaces.css";

/**
 * Every section a workspace's settings has, in the order they are listed, and
 * the seat it takes to see it listed. The server refuses the rest anyway; a
 * section nobody could read is only left out of the nav.
 */
const SECTIONS: readonly { id: SettingsSection; label: string; from?: WorkspaceRole }[] = [
  { id: "general", label: "General" },
  { id: "members", label: "Members" },
  { id: "integrations", label: "Integrations" },
  { id: "billing", label: "Billing" },
  { id: "audit", label: "Audit", from: "admin" },
];

/**
 * The chrome of a workspace's settings: the account settings' topbar with the
 * way back to this workspace — which is where its name is said — the title,
 * and the sections as links under it. Moving between sections keeps all of
 * that still: only the section's body changes, fading in, and the rows that
 * rose into place on arrival do not rise again.
 *
 * A guest has no settings here — they were let into projects, not into the
 * workspace — so the address sends them to the workspace's projects instead.
 */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const router = useRouter();
  const container = useContainer();
  // One level below `settings/`: nothing on the page itself, which is General.
  const segment = useSelectedLayoutSegment();
  const workspace = container.kind === "workspace" ? container : null;
  const guest = workspace?.role === "guest";

  useEffect(() => {
    if (workspace && guest) router.replace(homePath(workspace.slug));
  }, [workspace, guest, router]);

  // Whether another section has been opened since the page arrived.
  const [first] = useState(segment);
  const [moved, setMoved] = useState(false);
  if (segment !== first && !moved) setMoved(true);

  const sections = workspace
    ? SECTIONS.filter((s) => !s.from || atLeast(workspace.role, s.from))
    : [];
  const current = sections.find((s) => s.id === segment)?.id ?? "general";
  // Where you are is one wash that travels between the links, so opening
  // another section reads as the one place moving, as the palette's highlight
  // does. Placed from the link's box, written to the nav; it snaps into its
  // first place, travels only after that, and follows the row as it wraps.
  const nav = useRef<HTMLElement>(null);
  const count = sections.length;
  useLayoutEffect(() => {
    const el = nav.current;
    const link = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !link) return;
    const place = () => {
      el.style.setProperty("--hl-x", `${link.offsetLeft}px`);
      el.style.setProperty("--hl-y", `${link.offsetTop}px`);
      el.style.setProperty("--hl-w", `${link.offsetWidth}px`);
      el.dataset.marked = "true";
    };
    place();
    const frame = requestAnimationFrame(() => (el.dataset.travels = "true"));
    const watch = new ResizeObserver(place);
    watch.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
    };
  }, [current, count]);
  useLanding(current);

  if (!workspace || guest) return <SettingsLoading workspace />;

  return (
    <div className="nt-set-page">
      <header className="nt-set-topbar">
        <Link href="/" aria-label="Nootles">
          <Wordmark height={18} />
        </Link>
        <Link href={homePath(workspace.slug)} className="nt-note hover:underline">
          Back to {workspace.name}
        </Link>
      </header>
      <main className={`nt-set-body${moved ? " nt-ws-moved" : ""}`}>
        <Warm workspace={workspace} />
        <h1 className="nt-set-title">Workspace settings</h1>
        <nav ref={nav} aria-label="Workspace settings" className="nt-ws-set-nav">
          <span className="nt-ws-set-nav-hl" aria-hidden="true" />
          {sections.map((section) => (
            <Link
              key={section.id}
              href={settingsPath(workspace.slug, section.id)}
              aria-current={section.id === current ? "page" : undefined}
              data-label={section.label}
              className={`nt-row${section.id === current ? " is-current" : ""}`}
            >
              {section.label}
            </Link>
          ))}
        </nav>
        <div key={current} className={moved ? "nt-ws-section-in" : undefined}>
          <Authed>{children}</Authed>
        </div>
      </main>
    </div>
  );
}

/**
 * Arriving on one section by its address — Integrations' way to General ›
 * Sharing — the card it names washes once and lets go, so the eye lands where
 * the link meant. Found by the heading's id, once the section has drawn it.
 * The wash is colour, not movement, so it plays under reduced motion too.
 */
function useLanding(current: string) {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const until = performance.now() + 3000;
    let frame = 0;
    let wash: Animation | undefined;
    const look = () => {
      const card = document
        .getElementById(id)
        ?.closest(".nt-set-section")
        ?.querySelector(".nt-set-list, .nt-ws-card, .nt-ws-table");
      if (!card) {
        if (performance.now() < until) frame = requestAnimationFrame(look);
        return;
      }
      const root = getComputedStyle(document.documentElement);
      wash = card.animate(
        [
          { boxShadow: `inset 0 0 0 100vmax ${root.getPropertyValue("--selected")}` },
          { boxShadow: "inset 0 0 0 100vmax transparent" },
        ],
        { duration: 900, delay: 150, easing: root.getPropertyValue("--ease"), fill: "backwards" },
      );
    };
    look();
    return () => {
      cancelAnimationFrame(frame);
      wash?.cancel();
    };
  }, [current]);
}

/**
 * What the sections ask that is slow to answer and quick to be asked again —
 * the GitHub App's status, the plan and its spend, the people — held open for
 * as long as the settings are, so going back to a section seconds later draws
 * it from what was already said rather than from its skeleton. Each section
 * asks the same queries with the same arguments, which Convex answers from
 * these subscriptions.
 */
function Warm({ workspace }: { workspace: WorkspaceContainer }) {
  const args = { workspaceId: workspace.workspaceId };
  useQuery(api.members.list, args);
  useQuery(api.github.app.status, args);
  useQuery(api.teamBilling.summary, args);
  useQuery(api.entitlements.forContainer, args);
  return null;
}
