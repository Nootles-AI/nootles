import type { Metadata } from "next";
import "./_kit/kit.css";

export const metadata: Metadata = { title: "Workspace — mockups" };

export default function EditorMockupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
