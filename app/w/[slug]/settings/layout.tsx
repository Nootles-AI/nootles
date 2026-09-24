import type { Metadata } from "next";
import { SettingsFrame } from "@/app/components/workspaces/settings/SettingsFrame";

export const metadata: Metadata = {
  title: "Workspace settings — Nootles",
};

/**
 * A workspace's settings, one route per section, inside one frame — so moving
 * between sections keeps the chrome and its section nav still, and a section
 * is a link someone can be sent.
 */
export default function WorkspaceSettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsFrame>{children}</SettingsFrame>;
}
