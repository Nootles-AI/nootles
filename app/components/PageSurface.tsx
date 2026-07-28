"use client";

import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Editable } from "./Editable";
import { Editor } from "./editor/Editor";

export function PageSurface({ pageId }: { pageId: Id<"pages"> }) {
  const page = useQuery(api.pages.get, { pageId });
  const rename = useMutation(api.pages.rename);

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
    return <div className="flex-1" />;
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
      <div className="w-full max-w-3xl px-6 py-12 sm:px-12 sm:py-16">
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
          className="w-full text-4xl font-bold tracking-tight text-balance outline-none"
        />
        <div className="mt-6">
          <Editor docId={page.docId} pageId={pageId} />
        </div>
      </div>
    </main>
  );
}
