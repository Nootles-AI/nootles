"use client";

import type { ReactNode } from "react";
import { Wordmark } from "./Brand";

/**
 * Said in place of a screen that cannot draw right now, with a way back —
 * never a blank one. A reload is always offered: it is the one thing that
 * recovers from anything, and the person should not have to know that.
 */
export function Interrupted({
  title,
  children,
  busy = false,
  retry,
}: {
  title: string;
  children: ReactNode;
  /** True while the app is already working its own way back. */
  busy?: boolean;
  /** A lighter way back than a reload, when there is one. */
  retry?: () => void;
}) {
  return (
    <div
      role={busy ? "status" : "alert"}
      aria-busy={busy}
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center"
    >
      <Wordmark className="mb-4 text-muted" aria-hidden />
      <p className="text-[length:var(--text-body)] font-medium">{title}</p>
      <p className="max-w-xs text-[length:var(--text-ui)] text-pretty text-muted">{children}</p>
      <div className="mt-2 flex gap-1">
        {retry && (
          <button type="button" className="nt-row px-2.5" onClick={retry}>
            Try again
          </button>
        )}
        <button type="button" className="nt-row px-2.5" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
