"use client";

import { useCallback, useEffect, useRef } from "react";
import type { NmlBlock } from "@/app/lib/nml/schema";
import { isSafeUrl } from "@/app/lib/nml/validate";
import {
  deriveCanvasMirror,
  type EditableNmlBridge,
} from "@/app/lib/nml/view";
import { CodeSurface } from "../codemirror/CodeSurface";
import { languageLabel } from "../codemirror/languages";
import { MathField } from "../math/MathField";
import { Katex } from "../math/katex";
import {
  CanvasSurface,
  type CanvasApi,
} from "../canvas/render/CanvasSurface";
import { serializeScene } from "../canvas/scene/serialize";
import { ensureCollaborativeCanvasMintTag } from "../canvas/collab/binding";
import {
  broadcastCanvasPresence,
  paintCanvasPresence,
} from "../canvas/collab/presence";
import { AlbumSurface } from "../album/AlbumSurface";
import { parseAlbum } from "../album/parse";
import { serializeAlbum } from "../album/serialize";
import { StoryboardSurface } from "../storyboard/StoryboardSurface";
import { parseStoryboard } from "../storyboard/parse";
import { serializeStoryboard } from "../storyboard/serialize";
import { LocationSurface } from "../location/LocationSurface";
import { parseLocation } from "../location/parse";
import { serializeLocation } from "../location/serialize";
import { MediaSurface } from "../media/MediaSurface";
import { blockTypeFor } from "../media/link";
import { useDebouncedPersist } from "../useDebouncedPersist";
import "../editor.css";
import "../canvas/canvas.css";

const noChange = () => {};

function textDiff(before: string, after: string): { from: number; to: number; text: string } | null {
  if (before === after) return null;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let suffix = 0;
  while (suffix < before.length - from && suffix < after.length - from &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { from, to: before.length - suffix, text: after.slice(from, after.length - suffix) };
}

function EditableCode({ block, bridge }: {
  block: Extract<NmlBlock, { type: "codeBlock" }>;
  bridge: EditableNmlBridge;
}) {
  const persist = useDebouncedPersist((value) => {
    const diff = textDiff(block.code, value);
    if (diff) bridge.dispatchCommands([
      { type: "setCode", nodeId: block.id, range: { from: diff.from, to: diff.to }, text: diff.text },
    ], [block.id]);
  }, 400, block.code);
  return <div className="nt-code">
    <div className="nt-code-topbar"><span className="nt-code-lang-label">{languageLabel(block.props.language)}</span></div>
    <CodeSurface initialValue={block.code} language={block.props.language} onChange={persist.schedule} onBlur={persist.flush} />
  </div>;
}

function EditableMath({ block, bridge }: {
  block: Extract<NmlBlock, { type: "mathBlock" }>;
  bridge: EditableNmlBridge;
}) {
  const addAfter = (rowId: string) => {
    const temporaryId = `$nml-math-row-${crypto.randomUUID()}`;
    bridge.dispatchCommands([{
      type: "insertMathRows",
      nodeId: block.id,
      anchor: { afterId: rowId },
      rows: [{ id: temporaryId, latex: "" }],
    }], [block.id, temporaryId], [temporaryId]);
  };
  return <div className="nt-mathblock">
    {block.rows.map((row) => <div key={row.id} data-nml-id={row.id} className="nt-mathblock-row">
      <div className="nt-mathblock-input">
        <MathField
          value={row.latex}
          onChange={(latex) => bridge.dispatchCommands([
            { type: "setMathRow", nodeId: block.id, rowId: row.id, latex },
          ], [block.id, row.id])}
          onEnter={() => addAfter(row.id)}
          onBackspaceEmpty={() => block.rows.length > 1 && bridge.dispatchCommands([
            { type: "removeMathRows", nodeId: block.id, rowIds: [row.id] },
          ], [block.id, row.id])}
        />
      </div>
    </div>)}
  </div>;
}

function updateDomain(bridge: EditableNmlBridge, block: NmlBlock, domain: unknown): void {
  bridge.dispatchCommands([{ type: "replaceDomain", nodeId: block.id, domain }], [block.id]);
}

function EditableCanvas({ block, bridge }: {
  block: Extract<NmlBlock, { type: "canvas" }>;
  bridge: EditableNmlBridge;
}) {
  const api = useRef<CanvasApi | null>(null);
  const known = useRef(block.scene);
  const detachApi = useRef<() => void>(() => {});
  const stopBroadcast = useRef<() => void>(() => {});
  const awareness = bridge.canvasAwareness();

  const reconcile = useCallback((target = api.current) => {
    if (!target) return;
    const current = bridge.getBlock(block.id);
    if (current?.type !== "canvas") return;
    const source = deriveCanvasMirror(current.scene);
    if (deriveCanvasMirror(target.store.getScene()) !== source) {
      target.store.adoptRemote(source);
    }
    // `adoptRemote` deliberately defers while a gesture is open. Diff the
    // gesture against what the local store actually showed at its start, not
    // against a collaborator state waiting to be adopted at commit.
    known.current = target.store.getScene();
  }, [block.id, bridge]);

  const setApi = useCallback((next: CanvasApi | null) => {
    if (api.current === next) return;
    stopBroadcast.current();
    stopBroadcast.current = () => {};
    detachApi.current();
    detachApi.current = () => {};
    api.current = next;
    if (!next) return;

    ensureCollaborativeCanvasMintTag();
    known.current = next.store.getScene();
    next.store.setLiveWriter((scene) => {
      const before = known.current;
      known.current = scene;
      // Keep the SceneStore's source cursor aligned with its optimistic scene;
      // the canonical observer below owns reconciliation and persistence.
      next.store.flush();
      if (!bridge.dispatchCanvasScene(block.id, before, scene)) reconcile(next);
    });
    const stopPaint = awareness
      ? paintCanvasPresence(awareness, awareness.clientID, block.id, next)
      : () => {};
    detachApi.current = () => {
      next.store.setLiveWriter(null);
      stopPaint();
    };
    reconcile(next);
  }, [awareness, block.id, bridge, reconcile]);

  useEffect(() => {
    const stopScene = bridge.subscribeCanvas(block.id, reconcile);
    const stopRequests = bridge.subscribe((update) => {
      if (update.request?.status === "rejected") reconcile();
    });
    return () => {
      stopScene();
      stopRequests();
    };
  }, [block.id, bridge, reconcile]);

  useEffect(() => {
    reconcile();
  }, [block.scene, reconcile]);

  useEffect(() => () => {
    stopBroadcast.current();
    detachApi.current();
  }, []);

  const beginPresence = () => {
    bridge.selectAtomicNode(block.id);
    if (!awareness || !api.current) return;
    stopBroadcast.current();
    stopBroadcast.current = broadcastCanvasPresence(
      awareness,
      block.id,
      api.current,
    );
  };
  const endPresence = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    stopBroadcast.current();
    stopBroadcast.current = () => {};
  };

  return <div onFocusCapture={beginPresence} onBlurCapture={endPresence}>
    <CanvasSurface
      source={deriveCanvasMirror(block.scene)}
      onChange={noChange}
      onApi={setApi}
    />
  </div>;
}

export default function ReadOnlyDomainContent({ block, editableBridge, resolveStorageUrl }: {
  block: NmlBlock;
  editableBridge?: EditableNmlBridge;
  resolveStorageUrl?: (storageId: string) => string | undefined;
}) {
  switch (block.type) {
    case "codeBlock": return editableBridge
      ? <EditableCode block={block} bridge={editableBridge} />
      : <div className="nt-code"><div className="nt-code-topbar"><span className="nt-code-lang-label">{languageLabel(block.props.language)}</span></div><CodeSurface initialValue={block.code} language={block.props.language} onChange={noChange} readOnly /></div>;
    case "mathBlock": return editableBridge
      ? <EditableMath block={block} bridge={editableBridge} />
      : <div className="nt-mathblock">{block.rows.map((row) => <div key={row.id} data-nml-id={row.id} className="nt-mathblock-row"><Katex latex={row.latex} /></div>)}</div>;
    case "canvas": return editableBridge
      ? <EditableCanvas block={block} bridge={editableBridge} />
      : <CanvasSurface source={serializeScene(block.scene)} onChange={noChange} readOnly />;
    case "album": return <AlbumSurface source={serializeAlbum(block.domain)} onChange={editableBridge ? (source) => updateDomain(editableBridge, block, parseAlbum(source)) : noChange} />;
    case "storyboard": return <StoryboardSurface blockId={block.id} source={serializeStoryboard(block.domain)} onChange={editableBridge ? (source) => updateDomain(editableBridge, block, parseStoryboard(source)) : noChange} readOnly={!editableBridge} />;
    case "location": return <LocationSurface blockId={block.id} source={serializeLocation(block.domain)} onChange={editableBridge ? (source) => updateDomain(editableBridge, block, parseLocation(source)) : noChange} />;
    case "image":
    case "video":
    case "audio":
    case "file": {
      const source = block.props.source;
      const candidate = source?.kind === "url" ? source.url : source ? resolveStorageUrl?.(source.storageId) : undefined;
      const url = candidate && isSafeUrl(candidate) ? candidate : undefined;
      if (source && !url) return <span role="note">This {block.type} is preserved; its media is unavailable.</span>;
      if (block.type === "video" || block.type === "audio") return <MediaSurface
        blockId={block.id}
        url={url ?? ""}
        title={block.props.caption || block.props.name || ""}
        fallbackKind={block.type}
        onSet={editableBridge ? ({ url: nextUrl, name, caption, media }) => {
          const nextType = media ?? blockTypeFor(nextUrl) ?? block.type;
          return editableBridge.dispatchCommands([
            ...(nextType === block.type ? [] : [{ type: "setMediaBlockType" as const, nodeId: block.id, blockType: nextType }]),
            {
              type: "setNodeProps",
              nodeId: block.id,
              patch: { source: nextUrl ? { kind: "url", url: nextUrl } : undefined, name: name || undefined, caption: caption || undefined },
            },
          ], [block.id]);
        } : noChange}
      />;
      if (!url) return null;
      if (block.type === "file") return <a href={url} rel="noopener noreferrer" target="_blank">{block.props.name || block.props.caption || "File"}</a>;
      // eslint-disable-next-line @next/next/no-img-element -- Storage/media URLs are resolved by the authorized host.
      return <figure><img src={url} alt={block.props.caption ?? ""} style={{ maxWidth: "100%" }} />{block.props.caption && <figcaption>{block.props.caption}</figcaption>}</figure>;
    }
    default: return null;
  }
}
