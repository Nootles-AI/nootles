"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { atLeast } from "@/convex/auth";
import { useStandIn } from "../StandIn";
import type { WorkspaceContainer } from "./ContainerContext";
import { Tile } from "./places";
import { refusal } from "./refusal";
import "../iconPicker.css";

/* Carries the emoji set; fetched when a picker first opens, as the sidebar's is. */
const IconPicker = dynamic(() => import("../IconPicker").then((m) => m.IconPicker), {
  ssr: false,
});

/** The picker's own size, which it is kept inside the window by. */
const PICKER = { width: 336, height: 372 };

/** Whether this seat chooses the workspace's icon: its owners and admins, never a stand-in. */
export function useChoosesIcon(workspace: WorkspaceContainer): boolean {
  const standIn = useStandIn();
  return !standIn && atLeast(workspace.role, "admin");
}

/**
 * The pages' icon picker, choosing the workspace's icon: hung under whatever
 * raised it, its left edge on that one's, and kept inside the window. Removing
 * the icon gives the workspace its letter back. Closes on a choice.
 */
export function WorkspaceIconPicker({
  workspace,
  anchor,
  onClose,
  onProblem,
}: {
  workspace: WorkspaceContainer;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onProblem?: (text: string) => void;
}) {
  const setIcon = useMutation(api.workspaces.setIcon);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setAt({
        left: Math.max(8, Math.min(r.left, window.innerWidth - PICKER.width)),
        top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - PICKER.height)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  if (!at) return null;
  return createPortal(
    <div className="nt-iconpicker-anchor" style={at}>
      <IconPicker
        icon={workspace.icon}
        onPick={(icon) => {
          onClose();
          anchor.current?.focus();
          setIcon({ workspaceId: workspace.workspaceId, icon }).catch((error) =>
            onProblem?.(refusal(error, "That icon didn’t save. Try again in a moment.")),
          );
        }}
        onClose={() => {
          onClose();
          anchor.current?.focus();
        }}
      />
    </div>,
    document.body,
  );
}

/**
 * The workspace's tile beside its name on its home. For whoever may choose
 * the icon, the tile is the way to: pressing it opens the picker under it.
 */
export function TitleTile({
  workspace,
  onProblem,
}: {
  workspace: WorkspaceContainer;
  onProblem: (text: string) => void;
}) {
  const chooses = useChoosesIcon(workspace);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const tile = <Tile name={workspace.name} icon={workspace.icon} size={28} className="is-title" />;
  if (!chooses) return tile;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`Choose ${workspace.name}’s icon`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // Pressing it again shuts the picker, rather than the picker hearing
        // a press outside itself and shutting just before this reopens it.
        onPointerDown={(e) => {
          if (open) e.nativeEvent.stopPropagation();
        }}
        onClick={() => setOpen((o) => !o)}
        className="nt-ws-title-tile"
      >
        {tile}
      </button>
      {open && (
        <WorkspaceIconPicker
          workspace={workspace}
          anchor={button}
          onClose={() => setOpen(false)}
          onProblem={onProblem}
        />
      )}
    </>
  );
}
