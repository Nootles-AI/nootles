"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useConvex, useQueries } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { acquireProvider, releaseProvider, type YConvexProvider } from "@/app/lib/sync/YConvexProvider";
import { collabColor } from "@/app/lib/sync/colors";
import { EditableNmlBridge, ReadOnlyNmlBridge, type NmlViewBridge } from "@/app/lib/nml/view/bridge";
import { undoScope, useWorkspaceHistory } from "@/app/lib/history/useWorkspaceHistory";
import { useNmlUndoDomain } from "@/app/lib/history/nmlDomain";
import { NmlEditableView, NmlReadOnlyView } from "./NmlReadOnlyView";
import { useReadOnly } from "../readOnly";

/**
 * Steps 9–13 native NML view host. It mounts the native bridge on the same
 * provider/Y.Doc used by production and remains useful for bridge regression and
 * debugging. Phase 2.5 production serving uses the complete BlockNote
 * `EditorSurface` plus `useNmlLegacyMirror` for product parity; this component is
 * no longer selected by `Editor.tsx`.
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

  const bridgeState = useSyncExternalStore(
    (onChange) => bridge?.subscribe(() => onChange()) ?? (() => {}),
    () => bridge?.state ?? null,
    () => null,
  );
  const storageIds = useMemo(() => {
    // The external-store snapshot invalidates this derivation after each bridge update.
    void bridgeState;
    const ids = new Set<string>();
    const visit = (blocks: NonNullable<ReturnType<NmlViewBridge["snapshot"]>>["blocks"]) => {
      for (const block of blocks) {
        if (
          (block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file") &&
          block.props.source?.kind === "storage"
        ) ids.add(block.props.source.storageId);
        visit(block.children);
      }
    };
    const document = bridge?.snapshot();
    if (document) visit(document.blocks);
    return [...ids].sort();
  }, [bridge, bridgeState]);
  const storageUrls = useQueries(Object.fromEntries(storageIds.map((storageId) => [
    storageId,
    { query: api.albums.url, args: { storageId: storageId as Id<"_storage"> } },
  ])));
  const resolveStorageUrl = useCallback((storageId: string) => {
    const result = storageUrls[storageId];
    return typeof result === "string" ? result : undefined;
  }, [storageUrls]);

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
          <NmlEditableView bridge={bridge} resolveStorageUrl={resolveStorageUrl} />
        ) : (
          <NmlReadOnlyView bridge={bridge as ReadOnlyNmlBridge} resolveStorageUrl={resolveStorageUrl} />
        )}
      </div>
    </div>
  );
}
