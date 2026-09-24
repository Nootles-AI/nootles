import type { Metadata } from "next";
import { ContainerRoute } from "@/app/components/workspaces/ContainerRoute";

export const metadata: Metadata = {
  title: "Nootles",
};

/**
 * Everything at a workspace's address — its home, its projects, its settings —
 * sits in that workspace (`ContainerRoute`). A layout rather than a wrapper in
 * each page, so moving between them keeps the one resolved workspace instead
 * of asking for it again.
 *
 * `/w/join/<token>` is a sibling rather than a child: a static segment is
 * matched before a dynamic one, so an invitation is never read as a
 * workspace called "join" (which is a reserved address anyway).
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <ContainerRoute slug={slug}>{children}</ContainerRoute>;
}
