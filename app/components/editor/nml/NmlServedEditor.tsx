"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { useUser } from "@clerk/nextjs";
import type { Id } from "@/convex/_generated/dataModel";
import { acquireProvider, releaseProvider, type YConvexProvider } from "@/app/lib/sync/YConvexProvider";
import { collabColor } from "@/app/lib/sync/colors";
import { EditableNmlBridge, ReadOnlyNmlBridge, type NmlViewBridge } from "@/app/lib/nml/view/bridge";
import { undoScope, useWorkspaceHistory } from "@/app/lib/history/useWorkspaceHistory";
import { useNmlUndoDomain } from "@/app/lib/history/nmlDomain";
import { NmlEditableView, NmlReadOnlyView } from "./NmlReadOnlyView";
import { useReadOnly } from "../readOnly";

/**
 * Step 13 — the production editor for a document whose canonical NML root has
 * been migrated and *server-verified* (the `nmlAuthority` gate in
 * `Editor.tsx`). It mounts the NML view bridge on the SAME `Y.Doc` the legacy
 * editor would have used (acquired from the shared provider), so NML command
 * transactions ride the ordinary flush path and sync with no extra wiring — and
 * because the BlockNote editor is not mounted here, the legacy `prosemirror`
 * root is never written: NML is the sole tree for this document's edits.
 *
 * This whole path is reached only behind the `NEXT_PUBLIC_NML_SERVE` flag AND a
 * cohort membership, so it is dormant until a cohort is deliberately enrolled.
 */
export function NmlServedEditor({
  docId,
  pageId,
}: {
  docId: string;
  pageId?: Id<"pages">;
  title?: string;
  mode?: string;
}) {
  const client = useConvex();
  const readOnly = useReadOnly();
  const { user } = useUser();
  const spine = useWorkspaceHistory();

  // Held in state and acquired in an effect — the sanctioned shape for an
  // external subscription (see useYjsEditor): acquisition refcounts a
  // module-level instance, so it must run exactly once per mount, which render
  // and useMemo (StrictMode double-invokes both) cannot promise.
  /* eslint-disable react-hooks/set-state-in-effect */
  const [provider, setProvider] = useState<YConvexProvider | null>(null);
  useEffect(() => {
    const acquired = acquireProvider(client, docId);
    setProvider(acquired);
    return () => {
      setProvider(null);
      releaseProvider(docId);
    };
  }, [client, docId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const synced = useSyncExternalStore(
    (onChange) => provider?.subscribe(onChange) ?? (() => {}),
    () => provider?.synced ?? false,
    () => false,
  );

  // The provider ships presence, but the local user's name/colour on awareness
  // is the mounting editor's to set — the legacy path does this in useYjsEditor.
  useEffect(() => {
    if (!provider) return;
    provider.awareness.setLocalStateField("user", {
      name: user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Someone",
      color: collabColor(user?.id ?? "anonymous"),
      ...(user?.imageUrl ? { imageUrl: user.imageUrl } : {}),
    });
  }, [provider, user]);

  const bridge = useMemo<NmlViewBridge | null>(() => {
    if (!provider || !synced) return null;
    if (readOnly) return new ReadOnlyNmlBridge(provider.doc);
    return new EditableNmlBridge(provider.doc, {
      actor: { kind: "human", userId: user?.id ?? "anonymous" },
      // The server's checkWrite already gates the append this produces; the
      // local executor gate only mirrors the role, and a viewer never reaches
      // the editable bridge (they get the read-only projection above).
      authorize: () => true,
      awareness: provider.awareness,
    });
  }, [provider, synced, readOnly, user?.id]);

  useEffect(() => () => bridge?.destroy(), [bridge]);

  useNmlUndoDomain(
    readOnly ? null : spine,
    provider?.doc ?? null,
    bridge instanceof EditableNmlBridge ? bridge : null,
    docId,
    pageId,
  );

  if (!bridge) return <div className="min-h-[40vh]" aria-hidden />;
  return (
    <div className="nt-marquee-surface" {...undoScope}>
      <div className="nt-editor">
        {bridge instanceof EditableNmlBridge ? (
          <NmlEditableView bridge={bridge} />
        ) : (
          <NmlReadOnlyView bridge={bridge as ReadOnlyNmlBridge} />
        )}
      </div>
    </div>
  );
}
