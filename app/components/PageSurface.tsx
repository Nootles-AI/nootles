"use client";

import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Editable } from "./Editable";
import { Editor } from "./editor/Editor";
import { ModeToggle } from "./ModeToggle";
import type { PageMode } from "./editor/ai/useTabCompletion";

export function PageSurface({ pageId }: { pageId: Id<"pages"> }) {
  const page = useQuery(api.pages.get, { pageId });
  const rename = useMutation(api.pages.rename);
  const setMode = useMutation(api.pages.setMode);

  // Persist title edits on a debounce. The Editable owns the text; we only read
  // it on input and write through.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  if (page === undefined) {
    // Mirrors the real column so the title and first paragraphs land in place.
    return (
      <main className="flex flex-1 flex-col overflow-hidden" aria-busy="true">
        <div
          className="w-full px-6 py-12 sm:px-14 sm:py-20"
          style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
        >
          <div className="ab-skeleton h-8 w-1/2" />
          <div className="mt-8 space-y-3">
            <div className="ab-skeleton h-4 w-full" />
            <div className="ab-skeleton h-4 w-11/12" />
            <div className="ab-skeleton h-4 w-2/3" />
          </div>
        </div>
      </main>
    );
  }
  if (page === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        Page not found
      </div>
    );
  }

  const persistTitle = (text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => rename({ pageId, title: text }), 400);
  };

  return (
    <main className="flex flex-1 flex-col overflow-auto">
      {/* Anchored left, not centred. Centring measured the column against the
          space the panels left over, so collapsing chat slid every line of text
          sideways. A document surface should hold still, like a code editor.
          The left gutter also houses BlockNote's drag handle and + button. */}
      <div
        className="w-full px-6 py-12 sm:px-14 sm:py-20"
        style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
      >
        <div className="mb-6 flex justify-start">
          <ModeToggle
            mode={(page.mode ?? "create") as PageMode}
            onChange={(mode) => setMode({ pageId, mode })}
          />
        </div>
        <Editable
          value={page.title}
          onInput={persistTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder="Untitled"
          label="Page title"
          className="ab-bare-focus w-full text-[length:var(--text-title)] font-semibold tracking-[-0.02em] text-balance outline-none"
        />
        <div className="mt-8">
          <Editor
            docId={page.docId}
            pageId={pageId}
            title={page.title}
            mode={(page.mode ?? "create") as PageMode}
          />
        </div>
      </div>
    </main>
  );
}
