"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DialogBox } from "../../Dialog";
import type { WorkspaceContainer } from "../ContainerContext";
import { refusal } from "../refusal";
import { Problem } from "./parts";

/**
 * A question, what answering it does, and the two ways out — the small box
 * every consequential step on a workspace's settings goes through.
 *
 * Cancel comes first and takes focus, so Enter on arrival is the safe answer.
 * Except where `confirmText` asks for a word to be typed first: there the
 * field takes focus, and the typing is the deliberate step. The action waits
 * for the server; a refusal is said in the box, which stays open for it.
 */
export function ConfirmBox({
  label,
  question,
  children,
  action,
  busyAction,
  quiet,
  confirmText,
  onConfirm,
  onClose,
}: {
  label: string;
  question: string;
  /** What happens, in a sentence or two. */
  children: ReactNode;
  action: string;
  busyAction: string;
  /** An action that takes nothing away, drawn without the danger ink. */
  quiet?: boolean;
  /** A word that has to be typed before the action arms. */
  confirmText?: string;
  /** Resolves once done; closing or leaving the page is the caller's. */
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const armed = confirmText === undefined || typed.trim() === confirmText.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!armed || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
    } catch (error) {
      setFailure(refusal(error, "That didn’t go through. Try again in a moment."));
      setBusy(false);
    }
  };

  return (
    <DialogBox label={label} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="text-sm font-medium">{question}</p>
        <p className="mt-1.5 text-pretty text-[13px] text-muted">{children}</p>
        {confirmText !== undefined && (
          <>
            <label htmlFor={`${id}-confirm`} className="mt-3 block text-[13px] text-muted">
              Type <span className="font-medium text-foreground">{confirmText}</span> to confirm.
            </label>
            <input
              id={`${id}-confirm`}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="nt-input mt-1.5"
            />
          </>
        )}
        <Problem text={failure} className="nt-settle mt-2 text-[13px] text-danger" />
        <div className="mt-4 flex justify-end gap-1">
          <button
            type="button"
            onClick={onClose}
            autoFocus={confirmText === undefined}
            className="nt-row px-2.5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!armed || busy}
            className={`nt-row px-2.5 font-medium${quiet ? "" : " text-danger"}`}
          >
            {busy ? busyAction : action}
          </button>
        </div>
      </form>
    </DialogBox>
  );
}

/**
 * Leaving, from either place it is offered — the danger zone, or your own row
 * in the members list. `heir` is who inherits what you made here, named so the
 * sentence is about a person rather than a rule.
 */
export function LeaveWorkspace({
  workspace,
  heir,
  onClose,
}: {
  workspace: WorkspaceContainer;
  heir: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const leave = useMutation(api.members.leave);
  return (
    <ConfirmBox
      label={`Leave ${workspace.name}`}
      question={`Leave ${workspace.name}?`}
      action="Leave"
      busyAction="Leaving…"
      onConfirm={async () => {
        await leave({ workspaceId: workspace.workspaceId });
        router.replace("/");
      }}
      onClose={onClose}
    >
      You lose access to its projects straight away.{" "}
      {heir
        ? `Projects you made here pass to ${heir}.`
        : "Projects you made here pass to its owner."}
    </ConfirmBox>
  );
}
