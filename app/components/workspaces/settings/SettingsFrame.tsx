"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { atLeast, type WorkspaceRole } from "@/convex/auth";
import { homePath, settingsPath, type SettingsSection } from "@/app/lib/containerPaths";
import { Authed } from "../../Authed";
import { Wordmark } from "../../Brand";
import { useContainer } from "../ContainerContext";
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
 * way back to this workspace, "Settings" as the title with whose over it —
 * the home's title is the workspace's name, and this is not the home — and
 * the sections as links under it.
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

  if (!workspace || guest) return <div className="flex-1" aria-busy="true" />;
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
      <main className="nt-set-body">
        <h1 className="nt-set-title">
          <span className="nt-ws-set-of">{workspace.name}</span> Settings
        </h1>
        <nav aria-label="Workspace settings" className="nt-ws-set-nav">
          {sections.map((section) => (
            <Link
              key={section.id}
              href={settingsPath(workspace.slug, section.id)}
              aria-current={section.id === current ? "page" : undefined}
              className={`nt-row${section.id === current ? " is-current" : ""}`}
            >
              {section.label}
            </Link>
          ))}
        </nav>
        <Authed>{children}</Authed>
      </main>
    </div>
  );
}
