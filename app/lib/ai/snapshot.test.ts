import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createNmlYDoc } from "@/app/lib/nml/yjs";
import { yReader } from "./snapshot";

describe("Yjs snapshot reader — served NML", () => {
  it("enumerates and resolves storage-backed media for non-editor readers", () => {
    const doc = createNmlYDoc({
      schemaVersion: 1,
      documentId: "stored-media",
      blocks: [{
        id: "image",
        type: "image",
        props: {
          source: { kind: "storage", storageId: "storage-1" },
          caption: "Stored",
        },
        children: [],
      }],
    });
    const reader = yReader();
    reader.apply([Y.encodeStateAsUpdate(doc)]);

    expect(reader.nmlStorageIds()).toEqual(["storage-1"]);
    expect(reader.blocks("nml", {
      resolveStorageUrl: (storageId) => storageId === "storage-1" ? "https://cdn.test/image.png" : undefined,
    })[0]).toMatchObject({
      id: "image",
      type: "image",
      props: { url: "https://cdn.test/image.png", caption: "Stored" },
    });

    reader.destroy();
    doc.destroy();
  });
});
