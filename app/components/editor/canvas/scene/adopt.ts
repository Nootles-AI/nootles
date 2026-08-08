import { pathDataBounds, translatePath } from "./path";
import { isGroup, type Scene, type SceneNode } from "./types";

/**
 * What a scene written by a model has to pass through before it is a document.
 *
 * The canvas grammar is the AI's edit surface, so markup arrives from something
 * that was told the rules rather than from something that enforces them. This is
 * the one seam where a plausible reading is turned into the canonical one — run
 * on AI-authored markup only, never on parse. Applying it to every read would
 * rewrite hand-authored documents on load and break
 * `serialize(parse(html)) === html`, which is the contract the AI layer edits
 * diagrams through.
 *
 * It is idempotent, which is what lets it sit on a streaming path: the same
 * diagram is adopted once per chunk as it arrives, and adopting an already-
 * adopted scene changes nothing.
 */

/**
 * Tighten every path node's box onto the geometry it actually draws.
 *
 * `d` is local to the node's box everywhere else in the canvas, and the box is
 * tight around it — that is what makes the selection rectangle the shape, the
 * layers row meaningful, and a resize a scale rather than a drift. A model
 * cannot hold that invariant: computing the bounding box of a dozen bezier
 * curves is exactly the arithmetic it is worst at, and a box guessed wrong is a
 * shape that selects and resizes as something other than what is on screen.
 *
 * So the box is not asked for. Whatever the model wrote for `w`/`h` is replaced
 * by the path's real extent, and any offset the geometry carries is moved out of
 * `d` and into `x`/`y`:
 *
 * ```
 * <nt-path x="40" y="40" w="999" h="999" d="M 10 10 L 60 90 Z"/>
 *   becomes
 * <nt-path x="50" y="50" w="50" h="80" d="M 0 0 L 50 80 Z"/>
 * ```
 *
 * The same arithmetic serves both ways of writing one. A model that wrote `d`
 * from 0,0 (as the prompt asks) has bounds already at the origin, so `x`/`y`
 * survive untouched and only `w`/`h` are corrected; a model that put the whole
 * drawing in `d` and left `x`/`y` at zero gets its position read back out of the
 * geometry. Neither has to be told which it did.
 */
export function adoptScene(scene: Scene): Scene {
  const nodes = adoptNodes(scene.nodes);
  return nodes === scene.nodes ? scene : { ...scene, nodes };
}

function adoptNodes(nodes: readonly SceneNode[]): SceneNode[] {
  let changed = false;
  const out = nodes.map((node) => {
    const next = adoptNode(node);
    if (next !== node) changed = true;
    return next;
  });
  // Structural sharing, as `scene/ops` guarantees it: the canvas store bails
  // React out of re-rendering a subtree whose node object it has seen before,
  // and a map that rebuilt every node would defeat that on every chunk of a
  // streaming diagram.
  return changed ? out : (nodes as SceneNode[]);
}

function adoptNode(node: SceneNode): SceneNode {
  if (isGroup(node)) {
    const children = adoptNodes(node.children);
    return children === node.children ? node : { ...node, children };
  }
  if (node.kind !== "path") return node;

  const bounds = pathDataBounds(node.d);
  if (!bounds) return node;

  const x = round(node.x + bounds.x);
  const y = round(node.y + bounds.y);
  const w = round(bounds.w);
  const h = round(bounds.h);
  if (near(x, node.x) && near(y, node.y) && near(w, node.w) && near(h, node.h)) {
    return node;
  }
  return {
    ...node,
    x,
    y,
    w,
    h,
    d: translatePath(node.d, -bounds.x, -bounds.y),
  };
}

/**
 * The box is stated to the same three decimals `d` is.
 *
 * A tight bound is where a cubic turns, which is a root of its derivative and so
 * irrational in general — left alone it writes `w="28.000000009773718"` into the
 * document, which is noise in every diagram that curves, and noise the round
 * trip then has to carry for ever.
 */
const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * `d` is written with three decimals, so a path that has already been adopted
 * comes back a rounding away from its own box rather than exactly on it. Without
 * the tolerance every adoption would rewrite `d` again, and a streaming diagram
 * would re-serialize every path on every chunk.
 */
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
