import { deleteSelection } from "../ContextMenu";
import {
  clampNudge,
  createDiagramCommands,
  type NudgeRange,
  type NudgeRun,
  type ShortcutId,
} from "../engine/shortcuts";
import { distributeByNode } from "../scene/align";
import { bandLeft, bandWidth, WIDE_MARGIN } from "../scene/band";
import { wideMarginOf } from "@/app/lib/columnScale";
import { canBoolean } from "../scene/boolean";
import { topSelection, type Point, type Scene, type SceneOp } from "../scene/types";
import type { DiagramTarget, PageCanvas } from "./PageCanvas";

/**
 * The diagram keymap's verbs with the page's meaning: an edit acts on every
 * diagram holding part of the selection, as one undo step. The page's keymap
 * dispatches through here, and so does the workspace palette, so a command
 * reached either way is the same command.
 */

/** The keys that speak to the one diagram the page is focused on, never to all. */
const FOCUSED_ONLY: ReadonlySet<ShortcutId> = new Set([
  "edit.vector",
  "select.parent",
  "select.next",
  "select.previous",
]);

type Batch = <T>(fn: () => T) => T;

/** What the page decides once for a command, before any diagram runs it. */
export type Shared = {
  /** ⌘⇧H and ⌘⇧L: the value every diagram writes. */
  flag?: boolean;
  /** An arrow key: the step every diagram takes. */
  holdNudge?: (dx: number, dy: number) => Point;
};

const bandRange = (scene: Scene): NudgeRange => {
  const minX = bandLeft(scene);
  return { minX, maxX: minX + bandWidth(scene) };
};

export function commandsFor(
  target: DiagramTarget,
  opts: { nudge?: () => NudgeRun } & Shared = {},
) {
  return createDiagramCommands({
    store: target.store,
    selection: target.selection,
    get nudge() {
      return opts.nudge?.();
    },
    band: () => bandRange(target.store.getScene()),
    wideMargin: () => {
      const el = target.entry.api.band.current;
      return el ? wideMarginOf(el) : WIDE_MARGIN;
    },
    holdNudge: opts.holdNudge,
    pathEdit: { set: target.entry.api.openPath },
    labelEdit: { open: target.entry.api.openLabel },
    flag: opts.flag === undefined ? undefined : () => opts.flag!,
  });
}

const writable = (canvas: PageCanvas) => canvas.targets().filter((target) => !target.entry.readOnly);

const held = (target: DiagramTarget) =>
  topSelection(target.store.getScene(), target.selection.getSnapshot().ids);

/**
 * A nudge held by every band holding part of the selection: each axis goes as
 * far as the one with the least room lets it, so the shapes keep their places
 * beside one another as a drag's do.
 */
function nudgeHold(targets: readonly DiagramTarget[]) {
  // Decided by the first diagram to ask, before any of them has moved.
  let decided: Point | null = null;
  return (dx: number, dy: number): Point => {
    if (decided) return decided;
    let x = dx;
    let y = dy;
    for (const target of targets) {
      const scene = target.store.getScene();
      const ids = held(target).map((node) => node.id);
      const step = clampNudge(scene, ids, dx, dy, bandRange(scene));
      if (Math.abs(step.x) < Math.abs(x)) x = step.x;
      if (Math.abs(step.y) < Math.abs(y)) y = step.y;
    }
    decided = { x, y };
    return decided;
  };
}

/** ⌘⇧H and ⌘⇧L read over the whole page's selection, before any of it changes. */
function flagValue(targets: readonly DiagramTarget[], flag: "locked" | "hidden"): boolean {
  return !targets.every((target) => held(target).every((node) => node[flag]));
}

/**
 * Horizontal spacing evened out over diagrams, which share the column's x —
 * the style panel's reading (`AlignRow`). Each has its own top, so vertical
 * spacing is one diagram's.
 */
function distributeAcross(targets: readonly DiagramTarget[]): Map<DiagramTarget, SceneOp[]> | null {
  const owners = new Map(targets.flatMap((target) => held(target).map((node) => [node, target] as const)));
  if (owners.size < 3) return null;
  const ops = new Map<DiagramTarget, SceneOp[]>();
  for (const [node, to] of distributeByNode([...owners.keys()], "horizontal")) {
    const dx = to.x - node.x;
    if (dx === 0) continue;
    const target = owners.get(node)!;
    const list = ops.get(target) ?? [];
    list.push({ type: "move", ids: [node.id], dx, dy: 0 });
    ops.set(target, list);
  }
  return ops;
}

/** Whether `id` would do something to the page's selection as it stands. */
export function commandApplies(canvas: PageCanvas, id: ShortcutId): boolean {
  const targets = writable(canvas);
  const counts = targets.map((target) => held(target).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return false;
  switch (id) {
    case "edit.union":
    case "edit.subtract":
    case "edit.intersect":
    case "edit.exclude":
      return targets.length === 1 && canBoolean(held(targets[0]));
    case "align.distributeH":
      return targets.length > 1 ? total >= 3 : counts[0] >= 3;
    case "align.distributeV":
      return targets.length === 1 && counts[0] >= 3;
    default:
      return true;
  }
}

/**
 * Runs `id` over the page's selection. `commands` supplies each diagram's
 * verbs — the keymap's carry its nudge runs; the default carries none.
 */
export function runAcross(
  canvas: PageCanvas,
  id: ShortcutId,
  e?: KeyboardEvent,
  {
    batch = canvas.batch,
    commands = (target, shared) => commandsFor(target, shared),
  }: {
    batch?: Batch;
    commands?: (target: DiagramTarget, shared: Shared) => ReturnType<typeof commandsFor>;
  } = {},
): boolean {
  const targets = writable(canvas);
  if (FOCUSED_ONLY.has(id)) {
    const focused = canvas.selection.getSnapshot().focused;
    const target = targets.find((t) => t.blockId === focused) ?? targets[0];
    return !!target && batch(() => commands(target, {})[id](e));
  }
  // Ids read up front: a diagram emptied by the delete takes its block, and
  // the caret that lands in the text must not let the next one's go first.
  if (id === "edit.delete") {
    return deleteSelection(
      targets.map((t) => ({ ...t, select: (ids: readonly string[]) => t.selection.select(ids) })),
      batch,
    );
  }
  if (id === "align.distributeV" && targets.length > 1) return false;
  const spread = id === "align.distributeH" && targets.length > 1 ? distributeAcross(targets) : null;
  if (id === "align.distributeH" && targets.length > 1 && !spread) return false;
  const flag =
    id === "toggle.hidden"
      ? flagValue(targets, "hidden")
      : id === "toggle.locked"
        ? flagValue(targets, "locked")
        : undefined;
  const shared: Shared = {
    flag,
    holdNudge: id === "move.nudge" || id === "move.nudgeFar" ? nudgeHold(targets) : undefined,
  };
  const focused = canvas.selection.getSnapshot().focused;
  let handled = id === "toggle.hidden" || spread !== null;
  canvas.selection.keep(() =>
    batch(() => {
      if (spread) {
        for (const [target, ops] of spread) target.store.dispatch(ops);
        return;
      }
      for (const target of targets) if (commands(target, shared)[id](e)) handled = true;
    }),
  );
  // Each diagram's own change moved the page's focus onto it.
  if (focused && canvas.selection.getSnapshot().parts.has(focused)) canvas.selection.focus(focused);
  return handled;
}

/** What the workspace palette offers over a selection, in its order, and the other words each is found by. */
export const PALETTE_COMMANDS: readonly { id: ShortcutId; words: readonly string[] }[] = [
  { id: "edit.union", words: ["boolean", "combine", "merge"] },
  { id: "edit.subtract", words: ["boolean", "cut"] },
  { id: "edit.intersect", words: ["boolean"] },
  { id: "edit.exclude", words: ["boolean"] },
  { id: "align.left", words: [] },
  { id: "align.hcenter", words: ["center", "centre"] },
  { id: "align.right", words: [] },
  { id: "align.top", words: [] },
  { id: "align.vcenter", words: ["middle", "center", "centre"] },
  { id: "align.bottom", words: [] },
  { id: "align.distributeH", words: ["space", "spacing", "even"] },
  { id: "align.distributeV", words: ["space", "spacing", "even"] },
  { id: "arrange.flipH", words: ["mirror"] },
  { id: "arrange.flipV", words: ["mirror"] },
];
