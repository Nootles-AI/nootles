// A diagram suggestion on a real page, driven by a scripted stream instead of
// a model. The runner (`diagram-suggest.browser.mjs`) walks it through its
// three states — thinking, drawing, waiting on Tab — photographs each, and
// checks that Tab lands the diagram exactly where the ghost stood and Escape
// takes it away. Nothing here reaches a network: the suggestion is painted
// through the same `setAction` the completion lane paints through, and what
// Tab applies is a batch this file builds.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import type { Batch } from "../convex/ai/operations";
import { schema } from "../app/components/editor/schema";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { blockKeysExtension } from "../app/components/editor/blockKeys";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import {
  clearSuggestion,
  currentSuggestion,
  setAction,
  setActionApplyHandler,
} from "../app/components/editor/ai/ghostText";
import { canvasPreview } from "../app/components/editor/ai/previewWidgets";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import { useWorkspaceHistory, WorkspaceHistoryProvider } from "../app/lib/history/useWorkspaceHistory";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import { textStepsExtension } from "../app/lib/history/textSteps";
import { createNmlYDoc, type NmlDocument } from "../app/lib/nml";
import { NmlLegacyMirror } from "../app/lib/nml/mirror";
import { blockNoteNmlMirrorHost } from "../app/lib/nml/mirrorBlockNote";
import {
  createPageCanvasHub,
  PageCanvasContext,
  PageCanvasHubContext,
  usePaneCanvas,
} from "../app/components/editor/canvas/page/PageCanvas";
import { adoptScene } from "../app/components/editor/canvas/scene/adopt";
import { fitToBand } from "../app/components/editor/canvas/scene/band";
import { parseFragment } from "../app/components/editor/canvas/scene/parse";
import { serializeScene } from "../app/components/editor/canvas/scene/serialize";
import { applyBatch } from "../app/lib/ai/apply";
import { POWER_PATH } from "../app/lib/ai/staged/scenes";
import { PagePane } from "../app/components/PagePane";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";
import "../app/components/editor/canvas/canvas.css";

type Editor = typeof schema.BlockNoteEditor;
const PAGE = "page" as Id<"pages">;
const convex = new ConvexReactClient("https://diagram-suggest-test.invalid", {
  skipConvexDeploymentUrlCheck: true,
});

const card =
  "background:#f4f1ea;border:1.5px solid #8a8272;border-radius:8px;display:flex;align-items:center;justify-content:center;text-align:center";

/** A column diagram, as `/api/diagram` writes one: no height, shapes in page px. */
const PIPELINE = `<nt-diagram>
  <nt-rect id="dp-push" x="24" y="40" w="120" h="64" style="${card}">git push</nt-rect>
  <nt-rect id="dp-ci" x="200" y="40" w="120" h="64" style="${card}">CI checks</nt-rect>
  <nt-rect id="dp-build" x="376" y="40" w="120" h="64" style="${card}">Build image</nt-rect>
  <nt-rect id="dp-stage" x="552" y="40" w="140" h="64" style="${card}">Stage</nt-rect>
  <nt-ellipse id="dp-canary" x="552" y="170" w="140" h="70" style="background:#eef3e8;border:1.5px solid #6d8a5a">Canary 5%</nt-ellipse>
  <nt-rect id="dp-prod" x="376" y="170" w="120" h="70" style="${card}">Production</nt-rect>
  <nt-edge id="dp-e1" from="dp-push" to="dp-ci"></nt-edge>
  <nt-edge id="dp-e2" from="dp-ci" to="dp-build"></nt-edge>
  <nt-edge id="dp-e3" from="dp-build" to="dp-stage"></nt-edge>
  <nt-edge id="dp-e4" from="dp-stage" to="dp-canary">smoke ok</nt-edge>
  <nt-edge id="dp-e5" from="dp-canary" to="dp-prod">error rate flat</nt-edge>
</nt-diagram>`;

const FIXTURES = { column: PIPELINE, wide: POWER_PATH } as const;
type Fixture = keyof typeof FIXTURES;

const paragraph = (id: string, words: string) => ({
  id,
  type: "paragraph",
  props: {},
  content: words ? [{ type: "text", text: words, marks: [] }] : [],
  children: [],
});

const source = (): NmlDocument =>
  ({
    schemaVersion: 1,
    documentId: "diagram-suggest",
    blocks: [
      paragraph("intro", "Release notes for the week. Nothing here is real; it is a page for a suggestion to land on."),
      paragraph("lead", "The deploy pipeline looks like this"),
      paragraph("after", "Everything after the diagram sits here, and must not move when Tab lands it."),
      paragraph("outro", ""),
    ],
  }) as unknown as NmlDocument;

let editor: Editor;

function Page() {
  const history = useWorkspaceHistory();
  useTextUndoDomain(history, editor as unknown as UndoHostEditor, "diagram-suggest", PAGE);
  const [hub] = useState(() =>
    createPageCanvasHub(history ? { batch: history.batch, quiet: history.walking } : { batch: (fn) => fn() }),
  );
  return (
    <PageCanvasHubContext value={hub}>
      <Pane />
    </PageCanvasHubContext>
  );
}

function Pane() {
  const canvas = usePaneCanvas("main", PAGE);
  useEffect(() => canvas.setEditor(editor as never), [canvas]);
  return (
    <PageCanvasContext value={canvas}>
      <div id="stage" style={{ height: "100vh", display: "flex" }}>
        <PagePane pane="main" pageId={PAGE}>
          <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
        </PagePane>
      </div>
    </PageCanvasContext>
  );
}

function mount() {
  const ydoc = createNmlYDoc(source());
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: [completionExtension, blockSelectionExtension, blockKeysExtension, textStepsExtension],
      collaboration: {
        fragment: ydoc.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness: new Awareness(ydoc) },
      },
    } as never),
  ) as unknown as Editor;
  new NmlLegacyMirror(ydoc, blockNoteNmlMirrorHost(editor, ydoc), {
    actor: { kind: "human", userId: "browser-test" },
    onError: (error) => console.error("NML compatibility mirror failed", error),
  }).start();
  createRoot(document.getElementById("app")!).render(
    <ConvexProvider client={convex}>
      <WorkspaceHistoryProvider projectId="diagram-suggest">
        <CurrentPageProvider pageId={PAGE}>
          <Page />
        </CurrentPageProvider>
      </WorkspaceHistoryProvider>
    </ConvexProvider>,
  );
}

/** What the lane's `soFar()` places: whole shapes only, adopted, fitted, canonical. */
function soFar(out: string): string {
  const scene = fitToBand(adoptScene(parseFragment(out).scene));
  return scene.nodes.length ? serializeScene(scene) : "";
}

const view = () => editor.prosemirrorView;

/** The run in flight: its fixture, how much of it has "arrived", and the tail prose. */
let run: { fixture: Fixture; tail: string; placed: string | null } = {
  fixture: "column",
  tail: "",
  placed: null,
};

/** Inserts `data` after the lead paragraph, with the tail written into it — the batch Tab applies. */
function batchFor(data: string): Batch {
  const ops: Batch["ops"] = [];
  if (run.tail) {
    const lead = editor.getBlock("lead");
    const text = (lead?.content as Array<{ text?: string }> | undefined)?.map((c) => c.text ?? "").join("") ?? "";
    ops.push({ kind: "setBlockContent", blockId: "lead", content: [{ type: "text", text: text + run.tail }] });
  }
  ops.push({
    kind: "insertBlocks",
    at: { at: "after", ref: "lead" },
    blocks: [{ tempId: "t1", type: "canvas", props: { data } }],
  });
  return { ops } as Batch;
}

function caretAtLead() {
  editor.focus();
  editor.setTextCursorPosition("lead", "end");
}

function box(el: Element | null | undefined) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** The ghost's band: the box the accepted diagram's band will occupy. */
const ghostBand = () =>
  document.querySelector(".nt-diagram-ghost-band") ??
  document.querySelector(".nt-diagram-preview-surface") ??
  document.querySelector(".nt-diagram-preview");

const realBand = () => document.querySelector(".nt-editor .nt-canvas:not(.nt-canvas-shot)");

function shapeBoxes(host: Element | null) {
  const out: Record<string, { left: number; top: number; width: number; height: number }> = {};
  host?.querySelectorAll(".nt-canvas-scene [data-id]").forEach((el) => {
    const id = el.getAttribute("data-id")!;
    if (el.parentElement?.closest("[data-id]")) return;
    out[id] = box(el)!;
  });
  return out;
}

const harness = {
  ready: () => !!view() && !!document.querySelector('[data-id="lead"]'),
  reset(fixture: Fixture, tail: string) {
    clearSuggestion(view());
    run = { fixture, tail, placed: null };
    caretAtLead();
  },
  /** The brief is out; no shape has arrived. */
  think() {
    setAction(view(), { label: "Add diagram", batch: null, loading: true, tail: run.tail });
  },
  /** The first `n` characters of the builder's reply have arrived. */
  stream(n: number) {
    const drawn = soFar(FIXTURES[run.fixture].slice(0, n));
    const preview = canvasPreview(drawn);
    if (!preview) return false;
    setAction(view(), {
      label: "Add diagram",
      batch: null,
      preview,
      tail: run.tail,
      // What Tab mid-stream places: the diagram as far as it has come.
      onAccept: () => {
        run.placed = drawn;
        applyBatch(editor, batchFor(drawn));
      },
    });
    return true;
  },
  /** The reply finished and compiled: Tab now applies a batch. */
  complete() {
    const drawn = soFar(FIXTURES[run.fixture]);
    const preview = canvasPreview(drawn)!;
    setAction(view(), { label: "Add diagram", batch: batchFor(drawn), preview, tail: run.tail });
  },
  length: () => FIXTURES[run.fixture].length,
  showing: () => {
    const s = currentSuggestion(view().state);
    return s ? s.kind : null;
  },
  ghost: () => box(ghostBand()),
  ghostShapes: () => shapeBoxes(ghostBand()),
  ghostEls: () =>
    document.querySelectorAll(".nt-diagram-ghost, .nt-diagram-preview").length,
  real: () => box(realBand()),
  realShapes: () => shapeBoxes(realBand()),
  after: () => box(document.querySelector('[data-id="after"] .bn-inline-content')),
  lead: () => box(document.querySelector('[data-id="lead"] .bn-inline-content')),
  blocks: () => editor.document.map((b) => b.type),
  /** The words on the caret line after the text: the suggestion's state, as a reader sees it. */
  status: () => {
    const el = document.querySelector(".nt-ghost-status") ?? document.querySelector(".nt-code-preview-head");
    return el?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  },
  phase: () => document.querySelector(".nt-diagram-ghost")?.getAttribute("data-phase") ?? null,
  /** Removes a landed diagram so the next scenario starts from the same page. */
  undoLanding() {
    const canvas = editor.document.find((b) => b.type === "canvas");
    if (canvas) editor.removeBlocks([canvas.id]);
    editor.updateBlock("lead", { content: "The deploy pipeline looks like this" });
    caretAtLead();
  },
};

setActionApplyHandler((batch) => applyBatch(editor, batch));

declare global {
  interface Window {
    diagramSuggest: typeof harness;
  }
}
window.diagramSuggest = harness;
mount();
