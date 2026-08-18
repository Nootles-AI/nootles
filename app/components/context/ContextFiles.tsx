"use client";

import { useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CONTEXT_FILE_ACCEPT } from "@/convex/files/shared";
import { fileSize, uploadContextFile } from "@/app/lib/contextFiles";
import { Plus, X } from "../Icons";

/**
 * The files a project's context carries, and the one control that adds them.
 *
 * Simpler than its repository sibling on purpose: there is no account to
 * connect and no list to pick from — a file is chosen from disk, uploaded, and
 * read once on the server. The row's second line is the life of that read:
 * "Reading…" while extraction runs, the size once it has landed, and the
 * reason when it failed.
 */
export function ContextFiles({ projectId }: { projectId: Id<"projects"> }) {
  const convex = useConvex();
  const files = useQuery(api.files.context.listForProject, { projectId });
  const remove = useMutation(api.files.context.remove);
  const refresh = useMutation(api.files.context.refresh);

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (chosen: FileList | null) => {
    if (!chosen?.length || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      // One at a time: each refusal names its file, and the first one stops
      // the batch where a parallel upload would report whichever lost the race.
      for (const file of Array.from(chosen)) {
        await uploadContextFile(convex, projectId, file);
      }
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "That file could not be added.",
      );
    } finally {
      setBusy(false);
      // Same file, chosen again, should fire onChange again.
      if (input.current) input.current.value = "";
    }
  };

  const failed = (files ?? []).filter((f) => f.syncError);

  return (
    <div>
      <div className="nt-field-label">
        Files
        <span className="nt-field-note">Optional</span>
      </div>

      {!!files?.length && (
        <ul className="mb-1">
          {files.map((file) => (
            <li key={file._id} className="nt-repo">
              <span className="nt-repo-body">
                <span className="nt-repo-name">{file.filename}</span>
                <span
                  className={`nt-repo-note${file.syncError ? " is-problem" : ""}`}
                >
                  {file.syncError ??
                    (file.syncedAt ? fileSize(file.size) : "Reading…")}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void remove({ fileId: file._id })}
                aria-label={`Remove ${file.filename}`}
                title="Remove"
                className="nt-icon-btn is-sm"
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        className="nt-row w-full text-muted"
      >
        <Plus />
        <span className="nt-row-label">
          {busy ? "Adding…" : files?.length ? "Add another file" : "Add a file"}
        </span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={CONTEXT_FILE_ACCEPT}
        className="hidden"
        aria-label="Add a context file"
        onChange={(e) => void upload(e.target.files)}
      />

      {failed.length > 0 && (
        <button
          type="button"
          onClick={() => {
            setFailure(null);
            for (const file of failed) {
              void refresh({ fileId: file._id }).catch(() => {});
            }
          }}
          className="nt-row w-full text-muted"
        >
          <span className="nt-row-label">Try reading again</span>
        </button>
      )}

      {failure && (
        <p role="alert" className="mt-1.5 text-[13px] leading-snug text-danger">
          {failure}
        </p>
      )}

      {!files?.length && !failure && (
        <p className="nt-note mt-1.5">
          A PDF, Word document, Markdown, HTML or text file. The assistant reads
          an added file when it needs it, and completions lean on it too.
        </p>
      )}
    </div>
  );
}
