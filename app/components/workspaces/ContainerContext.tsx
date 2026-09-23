"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkspaceRole } from "@/convex/auth";

/**
 * Whose place this is: your own account, or one workspace you have a seat in.
 *
 * Decided by the address rather than by anything stored — `/w/<slug>/…` is
 * the workspace (`ContainerRoute` provides it), and everywhere else is yours,
 * which is why the default needs no provider. Chrome reads it to know where
 * "home" is and what to call it; nothing reads it to decide what anyone may
 * do, which stays the server's (`convex/auth.ts`).
 */
export type WorkspaceContainer = {
  kind: "workspace";
  workspaceId: Id<"workspaces">;
  /** The current address, never a retired one. */
  slug: string;
  name: string;
  role: WorkspaceRole;
};

export type Container = { kind: "account" } | WorkspaceContainer;

const ACCOUNT: Container = { kind: "account" };

const Current = createContext<Container>(ACCOUNT);

export function ContainerProvider({
  value,
  children,
}: {
  value: WorkspaceContainer;
  children: ReactNode;
}) {
  return <Current value={value}>{children}</Current>;
}

export function useContainer(): Container {
  return useContext(Current);
}

/** The slug an address is built from, or null for your own container. */
export function slugOf(container: Container): string | null {
  return container.kind === "workspace" ? container.slug : null;
}
