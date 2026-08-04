"use client";

import { useEffect, useRef, useState } from "react";
import { EdgeLayer } from "../editor/canvas/render/EdgeLayer";
import { ShapeView } from "../editor/canvas/render/ShapeView";
import { migrateLegacyCanvas } from "../editor/canvas/scene/migrate";
import { moveNodes } from "../editor/canvas/scene/ops";
import type { EdgeId, Scene } from "../editor/canvas/scene/types";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import {
  BRIEF,
  DIAGRAM,
  DIAGRAM_H,
  DIAGRAM_W,
  DRAGGED,
  DRAG_DX,
  DRAG_FROM,
  GHOST,
  HEADING,
  INTRO,
  LEAD,
  LINE,
  OWNERS,
  OWNERS_HEADING,
  STOP,
  STOP_HEADING,
  TITLE,
  WHERE,
  WHERE_HEADING,
} from "./demo";
import "../editor/canvas/canvas.css";
import "./recording.css";

/**
 * The door's argument: someone using the product, on a loop.
 *
 * A still page can show that prose, drawings and code sit on one surface. It
 * cannot show the three things that are actually the product — a line being
 * finished for you, a sentence turning into a diagram, and that diagram being
 * dragged into shape a second later. So the page writes itself instead, with a
 * pointer doing the work.
 *
 * Drawn by the real renderer. `ShapeView` and `EdgeLayer` are the same two
 * components the canvas block mounts, given the same `Scene`, so the drawing on
 * the door cannot drift from the drawing in the product — and the drag is a
 * real `moveNodes` op applied per frame, which is why the connectors re-route
 * while the shape is still moving rather than snapping when it lands.
 *
 * Not `ScenePreview`, which fits its scene to a measured box. The diagram here
 * is authored at the width of the column it sits in, so the transform is known
 * up front — and it has to be, because the pointer is driven to a shape by
 * arithmetic and a fit computed after layout would move the shape out from
 * under it.
 */

/** The document column, and the page's own padding inside the sheet. */
const COLUMN = 600;
const PAD_X = 42;
/** Centres the authored diagram in what the padding leaves. */
const SCENE_X = (COLUMN - PAD_X * 2 - DIAGRAM_W) / 2;

const NO_EDGES: ReadonlySet<EdgeId> = new Set();

const SOURCE = migrateLegacyCanvas(DIAGRAM);

type Head = "off" | "live" | "steady";
type Slot = "off" | "drawing" | "on";

interface Take {
  /** Words of the completion offered so far. */
  ghost: number;
  head: Head;
  tab: "off" | "on" | "press";
  /** The completion has stopped being an offer and become text. */
  ink: boolean;
  /** Characters of the brief the model reads the line as. */
  brief: number;
  slot: Slot;
  /** Shapes on the canvas so far; edges follow their endpoints. */
  shapes: number;
  scene: Scene;
  /** Where the pointer is, in document pixels, or null while it is offstage. */
  at: { x: number; y: number } | null;
  down: boolean;
  /** The last beat is over and the take is on its way out. */
  out: boolean;
}

const OPENING: Take = {
  ghost: 0,
  head: "off",
  tab: "off",
  ink: false,
  brief: 0,
  slot: "off",
  shapes: 0,
  scene: SOURCE,
  at: null,
  down: false,
  out: false,
};

/** Every beat played out, for anyone who has asked not to be moved. */
const FINISHED: Take = {
  ...OPENING,
  ghost: Infinity,
  ink: true,
  brief: 0,
  slot: "on",
  shapes: Infinity,
  scene: moveNodes(SOURCE, [DRAGGED], DRAG_DX, 0),
};

const WORDS = GHOST.match(/\s*\S+/g) ?? [];

export function Recording() {
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [take, setTake] = useState<Take>(OPENING);
  /** Bumped to play the whole thing again. */
  const [cycle, setCycle] = useState(0);

  /** Measured rather than assumed: where the pointer has to be for each beat
   *  depends on where the text happens to wrap. */
  const caret = useRef<HTMLSpanElement>(null);
  const empty = useRef<HTMLParagraphElement>(null);
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (still) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    let frame = 0;
    const at = (delay: number, run: () => void) => {
      timers.push(setTimeout(run, delay));
    };
    const spotOf = (el: HTMLElement | null, dx = 0, dy = 0) =>
      el ? { x: el.offsetLeft + dx, y: el.offsetTop + dy } : null;

    let t = 0;

    /* ---- The line ------------------------------------------------------ */
    t += 620;
    at(t, () =>
      setTake((s) => ({ ...s, at: spotOf(caret.current, 2, 10), head: "live" })),
    );

    // A word and the space before it, which is roughly what a token is.
    t += 300;
    for (let i = 1; i <= WORDS.length; i += 1) {
      t += 34 + i * 4;
      at(t, () => setTake((s) => ({ ...s, ghost: i })));
    }

    // Steady means "this is where you will be if you press Tab" — the same two
    // states the editor's own suggestion head has.
    t += 160;
    at(t, () => setTake((s) => ({ ...s, head: "steady", tab: "on" })));

    t += 620;
    at(t, () => setTake((s) => ({ ...s, tab: "press" })));
    t += 130;
    at(t, () =>
      setTake((s) => ({ ...s, ink: true, head: "off", tab: "off" })),
    );

    /* ---- The drawing --------------------------------------------------- */
    t += 620;
    at(t, () =>
      setTake((s) => ({ ...s, at: spotOf(empty.current, 6, 10), head: "live" })),
    );

    t += 260;
    for (let i = 1; i <= BRIEF.length; i += 1) {
      t += 13;
      at(t, () => setTake((s) => ({ ...s, brief: i })));
    }

    // The brief stops being words and becomes the block that answers it.
    t += 300;
    at(t, () =>
      setTake((s) => ({ ...s, brief: 0, head: "off", slot: "drawing" })),
    );

    t += 700;
    for (let i = 1; i <= SOURCE.nodes.length; i += 1) {
      t += 150;
      at(t, () => setTake((s) => ({ ...s, shapes: i })));
    }

    t += 260;
    at(t, () => setTake((s) => ({ ...s, slot: "on" })));

    /* ---- The edit ------------------------------------------------------ */
    const grip = () => {
      const box = slot.current;
      if (!box) return null;
      return {
        x: SCENE_X + DRAG_FROM.x + DRAG_FROM.w / 2,
        y: box.offsetTop + DRAG_FROM.y + DRAG_FROM.h / 2,
      };
    };

    t += 420;
    at(t, () => setTake((s) => ({ ...s, at: grip() })));

    t += 300;
    at(t, () => setTake((s) => ({ ...s, down: true })));

    t += 220;
    at(t, () => {
      const start = performance.now();
      const span = 520;
      let done = 0;
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / span);
        // The same curve the app eases everything on: most of the distance
        // early, the last of it settling. A drag that arrives at constant speed
        // reads as a tween; this reads as a hand.
        const eased = 1 - Math.pow(1 - k, 4);
        const want = DRAG_DX * eased;
        const dx = want - done;
        done = want;
        setTake((s) => ({
          ...s,
          scene: moveNodes(s.scene, [DRAGGED], dx, 0),
          at: s.at ? { x: s.at.x + dx, y: s.at.y } : s.at,
        }));
        if (k < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });

    t += 520 + 160;
    at(t, () => setTake((s) => ({ ...s, down: false })));

    /* ---- Again --------------------------------------------------------- */
    t += 2200;
    at(t, () => setTake((s) => ({ ...s, out: true, at: null })));
    t += 520;
    at(t, () => {
      setTake(OPENING);
      setCycle((n) => n + 1);
    });

    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(frame);
    };
  }, [cycle, still]);

  const s = still ? FINISHED : take;
  const shown = WORDS.slice(0, s.ghost === Infinity ? WORDS.length : s.ghost).join("");
  const nodes = s.scene.nodes.slice(
    0,
    s.shapes === Infinity ? s.scene.nodes.length : s.shapes,
  );
  const drawn = new Set(nodes.map((node) => node.id));
  const scene: Scene = {
    ...s.scene,
    nodes,
    edges: s.scene.edges.filter((e) => drawn.has(e.from) && drawn.has(e.to)),
  };

  return (
    <div className={`nt-rec${s.out ? " is-out" : ""}`} aria-hidden>
      <div className="nt-rec-page">
        <p className="nt-thumb-h" data-level={1}>
          {TITLE}
        </p>
        <p className="nt-rec-line">{INTRO}</p>

        <p className="nt-thumb-h" data-level={2}>
          {WHERE_HEADING}
        </p>
        <p className="nt-rec-line">{WHERE}</p>

        <p className="nt-rec-line">
          {LINE}
          <span className={s.ink ? "nt-rec-kept" : "nt-rec-ghost"}>{shown}</span>
          <span ref={caret} className="nt-rec-anchor">
            {s.head !== "off" && (
              <span
                className={`nt-stream-head${s.head === "live" ? " is-live" : ""}`}
              />
            )}
          </span>
          {s.tab !== "off" && (
            <span className={`nt-rec-key${s.tab === "press" ? " is-press" : ""}`}>
              Tab
            </span>
          )}
        </p>

        <p className="nt-thumb-h" data-level={2}>
          {HEADING}
        </p>
        <p className="nt-rec-line">{LEAD}</p>
        {/* The line the drawing is asked for on. Empty at rest and never
            unmounted — a blank line in a document is ordinary, and one that
            appeared for the beat would shift everything under it at the moment
            the eye is on it. */}
        <p ref={empty} className="nt-rec-line">
          <span className="nt-rec-ghost">{BRIEF.slice(0, s.brief)}</span>
          <span className="nt-rec-anchor">
            {s.head === "live" && s.brief > 0 && (
              <span className="nt-stream-head is-live" />
            )}
          </span>
        </p>

        {s.slot !== "off" && (
          <div
            ref={slot}
            className={`nt-rec-slot${s.slot === "drawing" ? " nt-generating" : ""}${
              s.down ? " is-drag" : ""
            }`}
            style={{ height: DIAGRAM_H }}
          >
            <div className="nt-canvas-viewport">
              <div
                className="nt-canvas-scene"
                style={{ transform: `translate(${SCENE_X}px, 0)` }}
              >
                <EdgeLayer scene={scene} selected={NO_EDGES} hoverId={null} />
                {scene.nodes.map((node) => (
                  <ShapeView key={node.id} node={node} />
                ))}
              </div>
            </div>
            {s.slot === "drawing" && <span className="nt-rec-drawing">Drawing…</span>}
          </div>
        )}

        {/* The page carries on under the drawing, and gets pushed down by it.
            That is the point of it being here: a document that ended where the
            demo ended would be a demo with a document drawn round it. */}
        <p className="nt-thumb-h" data-level={2}>
          {OWNERS_HEADING}
        </p>
        {OWNERS.map((line) => (
          <p key={line} className="nt-thumb-li">
            <span className="nt-thumb-marker" />
            <span>{line}</span>
          </p>
        ))}

        <p className="nt-thumb-h" data-level={2}>
          {STOP_HEADING}
        </p>
        <p className="nt-rec-line">{STOP}</p>

        {s.at && (
          <span
            className={`nt-rec-pointer${s.down ? " is-down" : ""}`}
            style={{ transform: `translate(${s.at.x}px, ${s.at.y}px)` }}
          >
            {/* Drawn a size up: the whole page is scaled to 0.78, and a
                pointer sized for the document ends up smaller than the text it
                is pointing at. */}
            <svg viewBox="0 0 12 18" width={15} height={22}>
              <path
                d="M1 1.2 10.6 10.4 6.2 10.9 8.6 15.8 6.6 16.8 4.2 11.9 1 14.8Z"
                fill="var(--foreground)"
                stroke="var(--background)"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}
