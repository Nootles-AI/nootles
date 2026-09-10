import { isGroup, type SceneNode, type SceneOp } from "./types";

/**
 * Pictures carried inside the markup — an `<nt-image src="data:…">`, or a
 * fill written as `url(data:…)` — which is how a paste from Figma arrives.
 *
 * A picture inline is a picture the document has to carry on every read: a
 * screen with four of them weighed half a megabyte in its own block, most of
 * it base64 no reader can use. The canvas block hoists them into storage the
 * moment they appear — pasted, written by the AI, or found on a board saved
 * before this existed — and keeps the URL instead. These two functions are
 * the pure halves of that: what is inline, and the ops that swap each inline
 * picture for its URL.
 */

const INLINE_SRC = /^data:image\//i;
const INLINE_FILL = /url\((["']?)(data:image\/[^)"']+)\1\)/gi;

export function inlinePictures(nodes: readonly SceneNode[]): string[] {
  const found = new Set<string>();
  const walk = (list: readonly SceneNode[]) => {
    for (const node of list) {
      if (node.kind === "image" && INLINE_SRC.test(node.src)) found.add(node.src);
      for (const value of Object.values(node.style)) {
        for (const m of value.matchAll(INLINE_FILL)) found.add(m[2]);
      }
      if (isGroup(node)) walk(node.children);
    }
  };
  walk(nodes);
  return [...found];
}

/**
 * The ops that swap every picture in `urls` for its URL; a picture with no
 * URL stays inline. One op per changed shape and declaration, so an untouched
 * shape is untouched.
 */
export function hoistOps(nodes: readonly SceneNode[], urls: ReadonlyMap<string, string>): SceneOp[] {
  const ops: SceneOp[] = [];
  const walk = (list: readonly SceneNode[]) => {
    for (const node of list) {
      if (node.kind === "image" && urls.has(node.src)) {
        ops.push({ type: "setSrc", id: node.id, src: urls.get(node.src)! });
      }
      const decls: Record<string, string> = {};
      for (const [prop, value] of Object.entries(node.style)) {
        const next = value.replace(INLINE_FILL, (whole, quote: string, uri: string) =>
          urls.has(uri) ? `url(${quote}${urls.get(uri)}${quote})` : whole,
        );
        if (next !== value) decls[prop] = next;
      }
      if (Object.keys(decls).length) ops.push({ type: "setStyle", ids: [node.id], decls });
      if (isGroup(node)) walk(node.children);
    }
  };
  walk(nodes);
  return ops;
}
