"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { PageComments } from "./PageComments";

/**
 * The comments of every page on screen, by page — how the chat, a sibling of
 * the document rather than a parent of it, reaches the same `PageComments`
 * value the page's own comment surfaces read. `EditorRegistry` is the same
 * idea for the editor.
 *
 * `settled` waits, because a page's comments exist before their document has
 * synced: threads read in that window are none at all, and a thread started
 * there would be started against a document that has not arrived.
 */
export class PageCommentsRegistry {
  /** Per page, every provider holding it — one per pane it is open in — latest last. */
  private entries = new Map<string, Array<() => PageComments>>();
  private listeners = new Set<() => void>();

  /** Publishes a page's comments; returns the withdrawal. */
  publish(pageId: string, read: () => PageComments): () => void {
    this.entries.set(pageId, [...(this.entries.get(pageId) ?? []), read]);
    this.changed();
    return () => {
      const rest = (this.entries.get(pageId) ?? []).filter((entry) => entry !== read);
      if (rest.length) this.entries.set(pageId, rest);
      else this.entries.delete(pageId);
    };
  }

  /** Tells whoever is waiting that a published value moved on. */
  changed() {
    for (const listener of [...this.listeners]) listener();
  }

  current(pageId: string): PageComments | null {
    return this.entries.get(pageId)?.at(-1)?.() ?? null;
  }

  /** The page's comments once they have loaded; rejects if they never do. */
  settled(pageId: string, timeoutMs: number): Promise<PageComments> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = this.current(pageId);
        if (!value || value.status === "loading") return false;
        stop();
        resolve(value);
        return true;
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`The comments on page ${pageId} did not finish loading. Say that, rather than answering from memory.`));
      }, timeoutMs);
      const stop = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }
}

const RegistryContext = createContext<PageCommentsRegistry | null>(null);

export function PageCommentsRegistryProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new PageCommentsRegistry());
  return <RegistryContext value={registry}>{children}</RegistryContext>;
}

/** Null outside a workspace: a page's comments then have nobody to publish to. */
export function usePageCommentsRegistry(): PageCommentsRegistry | null {
  return useContext(RegistryContext);
}
