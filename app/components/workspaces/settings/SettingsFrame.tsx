"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { atLeast, type WorkspaceRole } from "@/convex/auth";
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

  if (!workspace || guest) return <SettingsLoading workspace />;
  const sections = SECTIONS.filter((s) => !s.from || atLeast(workspace.role, s.from));
  const current = sections.find((s) => s.id === segment)?.id ?? "general";

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
        <nav aria-label="Workspace settings" className="nt-ws-set-nav">
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
