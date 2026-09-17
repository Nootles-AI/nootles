"use client";

import { useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import type {
  BlockNoteEditor,
  BlockSchema,
  InlineContentSchema,
  StyleSchema,
} from "@blocknote/core";
import type { YConvexProvider } from "@/app/lib/sync/YConvexProvider";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isApplyingAi } from "@/app/lib/debugRing";
import { NmlLegacyMirror } from "./mirror";
import { blockNoteNmlMirrorHost } from "./mirrorBlockNote";

/**
 * Makes the existing BlockNote surface a derived compatibility view over NML.
 * This restores its complete chrome/AI feature set while the tested mirror
 * keeps canonical NML authoritative and stale clients coherent.
 */
export function useNmlLegacyMirror<
  BSchema extends BlockSchema,
  ISchema extends InlineContentSchema,
  SSchema extends StyleSchema,
>(
  enabled: boolean,
  editor: BlockNoteEditor<BSchema, ISchema, SSchema> | null,
  provider: YConvexProvider | null,
  userId: string,
): boolean {
  const convex = useConvex();
  const [ready, setReady] = useState(!enabled);
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!enabled) {
      setReady(true);
      return;
    }
    if (!editor || !provider) {
      setReady(false);
      return;
    }
    setReady(false);
    let active = true;
    const mirror = new NmlLegacyMirror(
      provider.doc,
      blockNoteNmlMirrorHost(editor, provider.doc),
      {
        actor: {
          kind: "human",
          userId: userIdRef.current,
          clientId: String(provider.doc.clientID),
        },
        actorForChange: () => ({
          kind: isApplyingAi() ? "model" : "human",
          userId: userIdRef.current,
          clientId: String(provider.doc.clientID),
        }),
        authorize: () => true,
        resolveStorageUrl: (storageId) => convex.query(api.albums.url, {
          storageId: storageId as Id<"_storage">,
        }),
        onError: () => {
          // Never include document content in diagnostics.
          console.error("NML compatibility mirror failed");
        },
      },
    ).start();
    // Do not expose a storage-backed media block with a transient empty URL.
    // `settle` also establishes that every edit observed during mount landed.
    void mirror.settle().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      mirror.stop();
    };
  }, [convex, enabled, editor, provider]);
  /* eslint-enable react-hooks/set-state-in-effect */
  return ready;
}
