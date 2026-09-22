"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NmlCommand } from "@/app/lib/nml/commands";
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

/**
 * Dispatch for a surface that holds its own value — CodeMirror's text, a
 * MathLive row — and hands it to the document afterwards.
 *
 * The document is free to say no: a request is already in flight, or the one
 * this block sent lost a precondition to a collaborator. Either way the
 * canonical value stays exactly where it was, so nothing in the block's props
 * moves and the surface would go on showing a value the page does not have.
 * The count returned alongside is what asks the surface to look again.
 *
 * Only the refusals of *this* block's writes count. A rejection belongs to us
 * when we are waiting on one — the bridge keeps a single request outstanding —
 * and somebody else's must not take text off this surface that has not been
 * offered to the document yet.
 */
function useReassertingDispatch(bridge: EditableNmlBridge): [
  number,
  (commands: NmlCommand[], nodeIds: string[], temporaryIds?: string[]) => boolean,
] {
  const [reasserted, setReasserted] = useState(0);
  const awaiting = useRef(false);
  const reassert = useCallback(() => setReasserted((count) => count + 1), []);

  useEffect(() => bridge.subscribe((update) => {
    const status = update.request?.status;
    if (!status || status === "optimistic" || !awaiting.current) return;
    awaiting.current = false;
    if (status === "rejected") reassert();
  }), [bridge, reassert]);

  const dispatch = useCallback((commands: NmlCommand[], nodeIds: string[], temporaryIds?: string[]) => {
    // Set before the dispatch, not after: a commit whose authorization is
    // synchronous lands its Yjs transaction, and with it the settlement this
    // very subscription is waiting for, before the call returns.
    awaiting.current = true;
    if (bridge.dispatchCommands(commands, nodeIds, temporaryIds)) return true;
    awaiting.current = false;
    reassert();
    return false;
  }, [bridge, reassert]);

  return [reasserted, dispatch];
}

function EditableCode({ block, bridge }: {
  block: Extract<NmlBlock, { type: "codeBlock" }>;
  bridge: EditableNmlBridge;
}) {
  const [reasserted, dispatch] = useReassertingDispatch(bridge);
  const persist = useDebouncedPersist((value) => {
    const diff = textDiff(block.code, value);
    return !diff || dispatch([
      { type: "setCode", nodeId: block.id, range: { from: diff.from, to: diff.to }, text: diff.text },
    ], [block.id]);
  }, 400, block.code);
  return <div className="nt-code">
    <div className="nt-code-topbar"><span className="nt-code-lang-label">{languageLabel(block.props.language)}</span></div>
    <CodeSurface initialValue={block.code} reasserted={reasserted} language={block.props.language} onChange={persist.schedule} onBlur={persist.flush} />
  </div>;
}

function EditableMath({ block, bridge }: {
  block: Extract<NmlBlock, { type: "mathBlock" }>;
  bridge: EditableNmlBridge;
}) {
  const [reasserted, dispatch] = useReassertingDispatch(bridge);
  /**
   * Only a row this block asked for takes the keyboard — the way Enter works.
   * Every other row mounts quietly: a field that focuses itself on mount takes
   * the caret from wherever the person is the moment MathLive finishes
   * loading, and a row the model or a collaborator adds is not theirs to be
   * moved into (NT-77).
   *
   * The commit mints the new row's id, so the row is recognised by arriving:
   * the one that was not there when it was asked for. A refusal withdraws the
   * ask, or a collaborator's row would answer it later.
   */
  const [asked, setAsked] = useState<{ known: string[]; reasserted: number } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  if (asked) {
    const arrived = block.rows.find((row) => !asked.known.includes(row.id));
    if (arrived) {
      setFocusId(arrived.id);
      setAsked(null);
    } else if (asked.reasserted !== reasserted) setAsked(null);
  }
  const addAfter = (rowId: string) => {
    const temporaryId = `$nml-math-row-${crypto.randomUUID()}`;
    const known = block.rows.map((row) => row.id);
    if (dispatch([{
      type: "insertMathRows",
      nodeId: block.id,
      anchor: { afterId: rowId },
      rows: [{ id: temporaryId, latex: "" }],
    }], [block.id, temporaryId], [temporaryId])) setAsked({ known, reasserted });
  };
  return <div className="nt-mathblock">
    {block.rows.map((row) => <div key={row.id} data-nml-id={row.id} className="nt-mathblock-row">
      <div className="nt-mathblock-input">
        <MathField
          value={row.latex}
          reasserted={reasserted}
          autoFocus={row.id === focusId}
          onChange={(latex) => latex !== row.latex && dispatch([
            { type: "setMathRow", nodeId: block.id, rowId: row.id, latex },
          ], [block.id, row.id])}
          onEnter={() => addAfter(row.id)}
          onBackspaceEmpty={() => block.rows.length > 1 && dispatch([
            { type: "removeMathRows", nodeId: block.id, rowIds: [row.id] },
          ], [block.id, row.id])}
        />
      </div>
    </div>)}
  </div>;
}

type Dispatch = (commands: NmlCommand[], nodeIds: string[]) => boolean;

/** Writes a domain block whole. `false` means the document refused it. */
function updateDomain(dispatch: Dispatch, block: NmlBlock, domain: unknown): boolean {
  return dispatch([{ type: "replaceDomain", nodeId: block.id, domain }], [block.id]);
}

/**
 * A storyboard holds its board and an album its committed arrangement until
 * the document takes them, so each is sent back to the document when it
 * refuses — the same obligation as a code block's text. A location card holds
 * nothing of its own and needs no such thing.
 */
function EditableStoryboard({ block, bridge }: {
  block: Extract<NmlBlock, { type: "storyboard" }>;
  bridge: EditableNmlBridge;
}) {
  const [reasserted, dispatch] = useReassertingDispatch(bridge);
  return <StoryboardSurface
    blockId={block.id}
    source={serializeStoryboard(block.domain)}
    reasserted={reasserted}
    onChange={(source) => updateDomain(dispatch, block, parseStoryboard(source))}
  />;
}

function EditableAlbum({ block, bridge }: {
  block: Extract<NmlBlock, { type: "album" }>;
  bridge: EditableNmlBridge;
}) {
  const [reasserted, dispatch] = useReassertingDispatch(bridge);
  return <AlbumSurface
    source={serializeAlbum(block.domain)}
    reasserted={reasserted}
    onChange={(source) => updateDomain(dispatch, block, parseAlbum(source))}
  />;
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
    case "album": return editableBridge
      ? <EditableAlbum block={block} bridge={editableBridge} />
      : <AlbumSurface source={serializeAlbum(block.domain)} onChange={noChange} />;
    case "storyboard": return editableBridge
      ? <EditableStoryboard block={block} bridge={editableBridge} />
      : <StoryboardSurface blockId={block.id} source={serializeStoryboard(block.domain)} onChange={noChange} readOnly />;
    case "location": return <LocationSurface blockId={block.id} source={serializeLocation(block.domain)} onChange={editableBridge ? (source) => updateDomain(
      (commands, nodeIds) => editableBridge.dispatchCommands(commands, nodeIds), block, parseLocation(source),
    ) : noChange} />;
    case "notionStub": return <a
      href={isSafeUrl(block.props.href) ? block.props.href : undefined}
      rel="noopener noreferrer"
      target="_blank"
    >{block.props.notionType || "Notion content"} (not imported)</a>;
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
