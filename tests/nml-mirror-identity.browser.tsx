import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment, withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { useTabCompletion } from "../app/components/editor/ai/useTabCompletion";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { remoteScrollExtension } from "../app/lib/sync/remoteScroll";
import type { YConvexProvider } from "../app/lib/sync/YConvexProvider";
import { duringAiApply } from "../app/lib/debugRing";
import { createNmlYDoc, decodeNmlDocument, type NmlDocument } from "../app/lib/nml";
import { NmlLegacyMirror } from "../app/lib/nml/mirror";
import { nmlToAnyBlocks } from "../app/lib/nml/model/projection";
import { useNmlLegacyMirror } from "../app/lib/nml/useNmlLegacyMirror";
import type { NmlTransactionOrigin } from "../app/lib/nml/yjs";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
  remoteScrollExtension,
];

type Editor = typeof schema.BlockNoteEditor;
type Actor = NmlTransactionOrigin["actor"];

type Resource = {
  id: number;
  documentId: string;
  doc: Y.Doc;
  awareness: Awareness;
  editor: Editor;
  provider: YConvexProvider;
  actors: Actor[];
};

let resourceSequence = 0;
let current: Resource;
let updateIdentity: ((userId: string) => void) | undefined;
let replaceResource: (() => void) | undefined;
let baseline: {
  editor: Editor;
  dom: Element | null;
  selection: { from: number; to: number };
} | null = null;

const lifecycle = {
  mirrorStarts: 0,
  mirrorStops: 0,
  surfaceMounts: 0,
  surfaceUnmounts: 0,
  ready: [] as boolean[],
};

// Construction is deliberately observed at the class seam rather than exposed
// through production code just for a test. Identity hydration must not touch
// either count; a real document replacement must touch both.
const startMirror = NmlLegacyMirror.prototype.start;
const stopMirror = NmlLegacyMirror.prototype.stop;
NmlLegacyMirror.prototype.start = function startInstrumented(this: NmlLegacyMirror) {
  lifecycle.mirrorStarts++;
  return startMirror.call(this);
};
NmlLegacyMirror.prototype.stop = function stopInstrumented(this: NmlLegacyMirror) {
  lifecycle.mirrorStops++;
  return stopMirror.call(this);
};

const source = (documentId: string): NmlDocument => ({
  schemaVersion: 1,
  documentId,
  blocks: [
    {
      id: `${documentId}-paragraph`,
      type: "paragraph",
      props: {},
      content: [
        {
          type: "text",
          text: `The deployment pipeline for ${documentId} is ready`,
          marks: [],
        },
      ],
      children: [],
    },
  ],
});

function makeResource(seedLegacy = false): Resource {
  const id = ++resourceSequence;
  const documentId = `identity-document-${id}`;
  const doc = createNmlYDoc(source(documentId));
  const awareness = new Awareness(doc);
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: EXTENSIONS,
      collaboration: {
        fragment: doc.getXmlFragment("prosemirror"),
        user: { name: "Identity fixture", color: "#6544e9" },
        provider: { awareness },
      },
    }),
  ) as unknown as Editor;
  if (seedLegacy) {
    doc.transact(() => {
      blocksToYXmlFragment(
        editor,
        nmlToAnyBlocks(source(documentId)) as never,
        doc.getXmlFragment("prosemirror"),
      );
    }, "fixture-seed");
  }
  const actors: Actor[] = [];
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    const origin = transaction.origin as Partial<NmlTransactionOrigin> | null;
    if (origin?.command === "legacy-mirror" && origin.actor) {
      actors.push({ ...origin.actor });
    }
  });
  return {
    id,
    documentId,
    doc,
    awareness,
    editor,
    // The mirror intentionally needs only the provider-owned Y.Doc. Keeping the
    // rest absent makes this an offline fixture rather than a sync simulation.
    provider: { doc } as YConvexProvider,
    actors,
  };
}

function Surface({ resource }: { resource: Resource }) {
  useTabCompletion(resource.editor, undefined, "", "create", resource.documentId);
  useEffect(() => {
    lifecycle.surfaceMounts++;
    return () => {
      lifecycle.surfaceUnmounts++;
    };
  }, []);
  return (
    <div data-surface-resource={resource.id}>
      <BlockNoteView
        editor={resource.editor}
        theme="light"
        className="nt-editor"
        sideMenu={false}
        slashMenu={false}
        formattingToolbar={false}
      />
    </div>
  );
}

function Fixture({ enabled }: { enabled: boolean }) {
  const [userId, setUserId] = useState("anonymous");
  const [resource, setResource] = useState(() => makeResource(!enabled));
  const ready = useNmlLegacyMirror(
    enabled,
    resource.editor,
    resource.provider,
    userId,
  );
  useEffect(() => {
    current = resource;
    updateIdentity = setUserId;
    replaceResource = () => setResource(makeResource(!enabled));
  }, [enabled, resource]);
  useEffect(() => {
    lifecycle.ready.push(ready);
  }, [ready]);
  return (
    <main data-ready={String(ready)} data-user-id={userId}>
      {ready ? <Surface resource={resource} /> : <div id="placeholder">Loading</div>}
    </main>
  );
}

const convex = new ConvexReactClient("https://nml-mirror-identity.invalid", {
  skipConvexDeploymentUrlCheck: true,
});
const enabled = new URLSearchParams(location.search).get("enabled") !== "0";
createRoot(document.getElementById("app")!).render(
  <ConvexProvider client={convex}>
    <Fixture enabled={enabled} />
  </ConvexProvider>,
);

const harness = {
  updateIdentity(userId: string) {
    updateIdentity?.(userId);
  },
  replaceDocument() {
    replaceResource?.();
  },
  capture() {
    const selection = current.editor.prosemirrorState.selection;
    baseline = {
      editor: current.editor,
      dom: document.querySelector(".bn-editor"),
      selection: { from: selection.from, to: selection.to },
    };
    return this.probe();
  },
  probe() {
    const selection = current.editor.prosemirrorState.selection;
    return {
      enabled,
      resourceId: current.id,
      documentId: current.documentId,
      ready: document.querySelector("main")?.getAttribute("data-ready") === "true",
      userId: document.querySelector("main")?.getAttribute("data-user-id"),
      text: document.querySelector(".bn-editor")?.textContent ?? "",
      ghost: document.querySelector(".nt-ghost")?.textContent ?? "",
      selection: { from: selection.from, to: selection.to },
      editorSame: baseline ? baseline.editor === current.editor : null,
      domSame: baseline ? baseline.dom === document.querySelector(".bn-editor") : null,
      selectionSame: baseline
        ? baseline.selection.from === selection.from && baseline.selection.to === selection.to
        : null,
      lifecycle: {
        ...lifecycle,
        ready: [...lifecycle.ready],
      },
      actors: current.actors.map((actor) => ({ ...actor })),
    };
  },
  clearActors() {
    current.actors.length = 0;
  },
  aiEdit(text: string) {
    duringAiApply(() => {
      current.editor.insertInlineContent(text);
    });
  },
  canonicalText() {
    const nml = decodeNmlDocument(current.doc);
    return nml.blocks
      .flatMap((block) =>
        "content" in block
          ? block.content.map((node) => (node.type === "text" ? node.text : ""))
          : [],
      )
      .join("");
  },
};

declare global {
  interface Window {
    nmlMirrorIdentity: typeof harness;
  }
}

window.nmlMirrorIdentity = harness;
