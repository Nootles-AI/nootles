import { parseSubpaths, serializeSubpaths } from "./path";
import { isGroup, type SceneNode, type SceneOp } from "./types";

/**
 * Path data as the pen tool writes it — three decimals, absolute commands.
 *
 * A path pasted from Figma arrives at double precision, fifteen digits a
 * coordinate, and an icon is a hundred of them: measured on one screen,
 * 145K characters of `d` that read back as 52K once written the canvas's own
 * way. Nothing visible changes at a thousandth of a pixel, and the string of
 * record is what every read costs, so a path is rewritten canonical the
 * moment it appears — the way an inline picture is moved into storage.
 *
 * `seen` is the caller's: a `d` already known canonical is not parsed again,
 * which keeps a drag across a board of icons from re-parsing them per frame.
 * Only canonical forms go in it — a raw `d` may come back, when the
 * collaboration binding re-adopts a scene from the document, and has to be
 * rewritten again when it does.
 */
export function canonicalPathOps(nodes: readonly SceneNode[], seen: Set<string>): SceneOp[] {
  const ops: SceneOp[] = [];
  const walk = (list: readonly SceneNode[]) => {
    for (const node of list) {
      if (node.kind === "path" && !seen.has(node.d)) {
        const canonical = canonicalPath(node.d);
        seen.add(canonical);
        if (canonical !== node.d) ops.push({ type: "setPath", id: node.id, d: canonical });
      }
      if (isGroup(node)) walk(node.children);
    }
  };
  walk(nodes);
  return ops;
}

/** The canonical form, or `d` itself when it does not parse or would not shrink. */
export function canonicalPath(d: string): string {
  try {
    const canonical = serializeSubpaths(parseSubpaths(d));
    return canonical && canonical.length < d.length ? canonical : d;
  } catch {
    return d;
  }
}
