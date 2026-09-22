"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { RowIcon } from "../../rowIcon";
import { Code, FileDoc, Minus, Plus } from "../../Icons";
import { NotionMark } from "../../NotionMark";
import { Layout, startAt, type Body } from "./force";
import { neighbours, PROJECT, type ViewEdge, type ViewNode } from "./model";

type Camera = { x: number; y: number; k: number };

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
/**
 * The smallest a fit will go. Past it titles stop being words; a big graph
 * opens framed on its middle instead, and the rest is a pan or a pinch away.
 */
const MIN_FIT = 0.55;
/** Steps run before the first paint: the shaping nobody needs to watch. */
const PRESETTLE = 160;
const EASE_MS = 420;
const DOT = 22;

/**
 * Structure is what holds the picture together, so its springs are stiff and
 * its lengths depend on the level: a folder stands well off the project, its
 * pages close round it. Mentions pull only gently — enough to draw related
 * pages toward each other, never enough to drag a page out of its folder.
 */
function springFor(edge: ViewEdge, kinds: Map<string, ViewNode["kind"]>) {
  if (edge.kind === "mentions") return { length: 220, strength: 0.03 };
  if (edge.kind === "works") return { length: 200, strength: 0.02 };
  const from = kinds.get(edge.source);
  const to = kinds.get(edge.target);
  if (from === "project") {
    if (to === "repo") return { length: 330, strength: 0.4 };
    if (to === "document") return { length: 220, strength: 0.4 };
    return to === "folder" ? { length: 250, strength: 0.4 } : { length: 190, strength: 0.4 };
  }
  if (from === "repo") return { length: 170, strength: 0.45 };
  return { length: 104, strength: 0.5 };
}

/**
 * The context graph, drawn and driven.
 *
 * Nodes are HTML (so a title is real text, an icon is the sidebar's own, and
 * each node is a button a keyboard can reach) over one SVG of lines; both
 * layers share one camera transform, the in-house canvas's own arrangement.
 * React draws the structure and the states; positions are written straight to
 * the DOM each frame, so a settling graph re-renders nothing.
 */
export function GraphCanvas({
  nodes,
  edges,
  selected,
  matches,
  centreOn,
  reserve,
  onSelect,
  onOpen,
}: {
  nodes: readonly ViewNode[];
  edges: readonly ViewEdge[];
  selected: string;
  /** Nodes a search matched; null when nothing is being searched for. */
  matches: ReadonlySet<string> | null;
  /** Bring this node to the middle of the free area; the nonce repeats a request. */
  centreOn: { id: string; nonce: number } | null;
  /** Room taken over the canvas by floating chrome, so framing avoids it. */
  reserve: () => { right: number; bottom: number };
  onSelect: (id: string) => void;
  onOpen: (pageId: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const lines = useRef<SVGGElement>(null);
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const pathEls = useRef(new Map<string, SVGPathElement>());
  const layout = useRef<Layout | null>(null);
  const bodyOf = useRef(new Map<string, Body>());
  const camera = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const loop = useRef(0);
  const tween = useRef(0);
  const drag = useRef<{ id: string; moved: boolean; x: number; y: number } | null>(null);
  const clickSuppressed = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);

  const near = useMemo(() => neighbours(edges), [edges]);
  const edgesRef = useRef(edges);
  const reserveRef = useRef(reserve);
  useEffect(() => {
    edgesRef.current = edges;
    reserveRef.current = reserve;
  });

  const applyCamera = () => {
    const { x, y, k } = camera.current;
    const transform = `translate(${x}px, ${y}px) scale(${k})`;
    if (world.current) world.current.style.transform = transform;
    if (lines.current) lines.current.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
    const vp = viewport.current;
    if (vp) {
      vp.style.backgroundSize = `${DOT * k}px ${DOT * k}px`;
      vp.style.backgroundPosition = `${x}px ${y}px`;
    }
  };

  const paint = () => {
    for (const [id, body] of bodyOf.current) {
      const el = nodeEls.current.get(id);
      if (el) el.style.transform = `translate(${body.x - body.w / 2}px, ${body.y - body.h / 2}px)`;
    }
    for (const edge of edgesRef.current) {
      const path = pathEls.current.get(edge.id);
      const a = bodyOf.current.get(edge.source);
      const b = bodyOf.current.get(edge.target);
      if (path && a && b) path.setAttribute("d", route(a, b, edge.kind !== "contains"));
    }
  };

  const tick = () => {
    const l = layout.current;
    loop.current = 0;
    if (!l) return;
    const moving = l.step();
    paint();
    if (moving || drag.current) loop.current = requestAnimationFrame(tick);
  };
  const wake = () => {
    if (!loop.current) loop.current = requestAnimationFrame(tick);
  };

  const easeTo = (to: Camera, animate = true) => {
    cancelAnimationFrame(tween.current);
    const from = { ...camera.current };
    if (!animate || reducedMotion()) {
      camera.current = to;
      applyCamera();
      setZoom(to.k);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / EASE_MS);
      const e = 1 - Math.pow(1 - t, 3);
      camera.current = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: from.k + (to.k - from.k) * e,
      };
      applyCamera();
      if (t < 1) tween.current = requestAnimationFrame(step);
      else setZoom(to.k);
    };
    tween.current = requestAnimationFrame(step);
  };

  /** The free area's size — the viewport less what floats over it. */
  const free = () => {
    const vp = viewport.current;
    const { right, bottom } = reserveRef.current();
    return { w: (vp?.clientWidth ?? 800) - right, h: (vp?.clientHeight ?? 600) - bottom };
  };

  const fit = (animate = true, b = layout.current?.bounds()) => {
    if (!b) return;
    const { w, h } = free();
    const k = clamp(Math.min((w - 160) / b.w, (h - 160) / b.h, 1.15), MIN_FIT, MAX_ZOOM);
    easeTo({ x: w / 2 - (b.x + b.w / 2) * k, y: h / 2 - (b.y + b.h / 2) * k, k }, animate);
  };

  const zoomBy = (factor: number, at?: { x: number; y: number }) => {
    const { w, h } = free();
    const c = camera.current;
    const k = clamp(c.k * factor, MIN_ZOOM, MAX_ZOOM);
    const px = at?.x ?? w / 2;
    const py = at?.y ?? h / 2;
    return { x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k, k };
  };

  // The layout, rebuilt warm whenever the graph's shape changes: bodies seen
  // before keep their places, new ones start beside their parents, and the
  // measure is the rendered box, so a longer title takes more room.
  const shape = useMemo(
    () =>
      nodes.map((n) => `${n.id}:${label(n)}`).join("|") + "#" + edges.map((e) => e.id).join("|"),
    [nodes, edges],
  );
  useLayoutEffect(() => {
    const previous = bodyOf.current;
    const parent = new Map<string, string>();
    for (const e of edges) if (e.kind === "contains") parent.set(e.target, e.source);
    const siblings = new Map<string, number>();
    const family = new Map<string, number>();
    for (const n of nodes) {
      const up = parent.get(n.id) ?? "";
      family.set(up, (family.get(up) ?? 0) + 1);
    }
    const next = new Map<string, Body>();
    const bodies = nodes.map((node) => {
      const el = nodeEls.current.get(node.id);
      const w = el?.offsetWidth ?? 120;
      const h = el?.offsetHeight ?? 32;
      const old = previous.get(node.id);
      const up = parent.get(node.id);
      const n = siblings.get(up ?? "") ?? 0;
      siblings.set(up ?? "", n + 1);
      const above = up ? parent.get(up) : undefined;
      const at =
        old ??
        startAt(
          node.id,
          n,
          family.get(up ?? "") ?? 1,
          up ? next.get(up) : undefined,
          above ? next.get(above) : undefined,
        );
      const body: Body = {
        id: node.id,
        x: node.id === PROJECT ? (old?.x ?? 0) : at.x,
        y: node.id === PROJECT ? (old?.y ?? 0) : at.y,
        vx: 0,
        vy: 0,
        w,
        h,
        pinned: node.id === PROJECT,
      };
      next.set(node.id, body);
      return body;
    });
    const index = new Map(bodies.map((b, i) => [b.id, i]));
    const kinds = new Map(nodes.map((n) => [n.id, n.kind]));
    const springs = edges.flatMap((e) => {
      const a = index.get(e.source);
      const b = index.get(e.target);
      return a === undefined || b === undefined ? [] : [{ a, b, ...springFor(e, kinds) }];
    });
    const first = !layout.current;
    const l = new Layout(bodies, springs);
    layout.current = l;
    bodyOf.current = next;
    if (first) {
      l.run(reducedMotion() ? Infinity : PRESETTLE);
      // Framed on where it will come to rest, so the settle happens in view.
      const rest = new Layout(
        bodies.map((b) => ({ ...b })),
        springs,
      );
      rest.alpha = l.alpha;
      rest.run();
      fit(false, rest.bounds());
    } else {
      l.alpha = 0.3;
    }
    paint();
    wake();
    // Rebuilt from `shape`; the node and edge arrays are its source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  useEffect(() => {
    if (!centreOn) return;
    const body = bodyOf.current.get(centreOn.id);
    if (!body) return;
    const { w, h } = free();
    const k = Math.max(camera.current.k, 0.8);
    easeTo({ x: w / 2 - body.x * k, y: h / 2 - body.y * k, k });
    // A request is its nonce; the helpers are stable in effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreOn?.nonce]);

  // Wheel: pan, or zoom with a pinch or the command key — the canvas's own
  // convention. Native and non-passive, because it must stop the page scroll.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(tween.current);
      const rect = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        camera.current = zoomBy(Math.exp(-e.deltaY * 0.01), {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
        setZoom(camera.current.k);
      } else {
        camera.current = {
          ...camera.current,
          x: camera.current.x - e.deltaX,
          y: camera.current.y - e.deltaY,
        };
      }
      applyCamera();
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleared as well as cancelled: a stale id reads as "a frame is coming",
  // and `wake` would then never ask for one again.
  useEffect(
    () => () => {
      cancelAnimationFrame(loop.current);
      cancelAnimationFrame(tween.current);
      loop.current = 0;
      tween.current = 0;
    },
    [],
  );

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const rect = viewport.current!.getBoundingClientRect();
    const { x, y, k } = camera.current;
    return { x: (e.clientX - rect.left - x) / k, y: (e.clientY - rect.top - y) / k };
  };

  const onBackgroundDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    cancelAnimationFrame(tween.current);
    const start = { x: e.clientX, y: e.clientY, cx: camera.current.x, cy: camera.current.y };
    let moved = false;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      camera.current = { ...camera.current, x: start.cx + dx, y: start.cy + dy };
      applyCamera();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("is-panning");
      if (!moved) onSelect(PROJECT);
    };
    el.classList.add("is-panning");
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onNodeDown = (id: string) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const body = bodyOf.current.get(id);
    if (!body) return;
    const at = toWorld(e);
    drag.current = { id, moved: false, x: at.x - body.x, y: at.y - body.y };
    clickSuppressed.current = false;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const p = toWorld(ev);
      const x = p.x - d.x;
      const y = p.y - d.y;
      if (!d.moved && Math.hypot(x - body.x, y - body.y) < 3 / camera.current.k) return;
      d.moved = true;
      body.pinned = true;
      body.x = x;
      body.y = y;
      el.classList.add("is-dragging");
      layout.current?.reheat(0.18);
      wake();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("is-dragging");
      if (drag.current?.moved) clickSuppressed.current = true;
      if (id !== PROJECT) body.pinned = false;
      drag.current = null;
      wake();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // What to bring forward: the selection's neighbourhood, or the hovered
  // node's while nothing but the project is selected. The project selected is
  // the overview, so it dims nothing.
  const focus = selected !== PROJECT ? selected : hovered;
  const lit = focus ? new Set([focus, ...(near.get(focus) ?? [])]) : null;
  const dim = (id: string) =>
    (matches !== null && !matches.has(id)) || (matches === null && !!lit && !lit.has(id));

  return (
    <div className="nt-graph-stage">
      <div ref={viewport} className="nt-graph-viewport" onPointerDown={onBackgroundDown}>
        <svg className="nt-graph-lines" aria-hidden>
          <defs>
            <marker
              id="nt-graph-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M1 1 L7 4 L1 7" className="nt-graph-arrowhead" />
            </marker>
            <marker
              id="nt-graph-arrow-lit"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M1 1 L7 4 L1 7" className="nt-graph-arrowhead is-lit" />
            </marker>
          </defs>
          <g ref={lines}>
            {edges.map((edge) => {
              // A search, while there is one, decides what is forward.
              const on =
                matches === null && !!focus && (edge.source === focus || edge.target === focus);
              const off = dim(edge.source) || dim(edge.target);
              return (
                <path
                  key={edge.id}
                  ref={(el) => {
                    if (el) pathEls.current.set(edge.id, el);
                    else pathEls.current.delete(edge.id);
                  }}
                  className={`nt-graph-line is-${edge.kind}${on ? " is-lit" : ""}${off && !on ? " is-dim" : ""}`}
                  style={
                    edge.kind === "works"
                      ? { strokeWidth: Math.min(3, 0.75 + Math.log2(1 + (edge.weight ?? 0)) * 0.5) }
                      : undefined
                  }
                  markerEnd={
                    edge.kind === "mentions"
                      ? `url(#${on ? "nt-graph-arrow-lit" : "nt-graph-arrow"})`
                      : undefined
                  }
                />
              );
            })}
          </g>
        </svg>

        <div ref={world} className="nt-graph-world">
          {nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              ref={(el) => {
                if (el) nodeEls.current.set(node.id, el);
                else nodeEls.current.delete(node.id);
              }}
              className={nodeClass(node, {
                selected: node.id === selected,
                dim: dim(node.id),
                match: !!matches?.has(node.id),
              })}
              aria-pressed={node.id === selected}
              aria-label={ariaLabel(node)}
              onPointerDown={onNodeDown(node.id)}
              onPointerEnter={() => setHovered(node.id)}
              onPointerLeave={() => setHovered((h) => (h === node.id ? null : h))}
              onClick={() => {
                if (clickSuppressed.current) {
                  clickSuppressed.current = false;
                  return;
                }
                onSelect(node.id);
              }}
              onDoubleClick={() => {
                if (node.kind === "page") onOpen(node.page.pageId);
              }}
            >
              {node.kind === "folder" && (
                <RowIcon icon={node.folder.icon} kind="folder" size={13} className="nt-gnode-icon" />
              )}
              {node.kind === "page" && (
                <RowIcon icon={node.page.icon} kind="page" size={13} className="nt-gnode-icon" />
              )}
              {node.kind === "repo" && <Code width={13} height={13} className="nt-gnode-icon" />}
              {node.kind === "document" &&
                (node.doc.source === "notion" ? (
                  <NotionMark width={13} height={13} className="nt-gnode-icon" />
                ) : (
                  <FileDoc width={13} height={13} className="nt-gnode-icon" />
                ))}
              {node.kind === "concern" && node.concern.styling && (
                <span className="nt-gnode-swatch" aria-hidden />
              )}
              <span className="nt-gnode-title">{label(node)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="nt-graph-zoom" role="group" aria-label="Zoom">
        <button
          type="button"
          className="nt-icon-btn"
          aria-label="Zoom out"
          onClick={() => easeTo(zoomBy(1 / 1.25))}
        >
          <Minus />
        </button>
        <button type="button" className="nt-graph-zoom-level" onClick={() => fit()} title="Fit to view">
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="nt-icon-btn"
          aria-label="Zoom in"
          onClick={() => easeTo(zoomBy(1.25))}
        >
          <Plus />
        </button>
      </div>
    </div>
  );
}

function label(node: ViewNode): string {
  switch (node.kind) {
    case "project":
      return node.title.trim() || "Untitled project";
    case "folder":
      return node.folder.title.trim() || "Untitled folder";
    case "page":
      return node.page.title.trim() || "Untitled";
    case "repo":
      return node.repo.fullName;
    case "area":
      return node.area.title;
    case "concern":
      return node.concern.title;
    case "document":
      return node.doc.title;
  }
}

const SPOKEN = {
  project: "Project",
  folder: "Folder",
  page: "Page",
  repo: "Repository",
  area: "Area",
  concern: "Concern",
  document: "Document",
} as const;

function ariaLabel(node: ViewNode): string {
  return `${SPOKEN[node.kind]}: ${label(node)}`;
}

function nodeClass(
  node: ViewNode,
  s: { selected: boolean; dim: boolean; match: boolean },
): string {
  return [
    "nt-gnode",
    `is-${node.kind}`,
    node.kind === "page" && !node.page.digested ? "is-unread" : "",
    node.kind === "repo" && node.repo.state !== "ready" ? `is-${node.repo.state}` : "",
    node.kind === "concern" && node.concern.styling ? "is-styling" : "",
    s.selected ? "is-selected" : "",
    s.dim ? "is-dim" : "",
    s.match ? "is-match" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A line from box to box, ending on the target's edge rather than its centre
 * so an arrowhead lands where it can be seen. Mentions and ties between
 * concerns bow slightly, so two lines between the same pair — or one beside a
 * containment line — never sit on top of each other.
 */
function route(a: Body, b: Body, bow: boolean): string {
  const from = exit(a, b.x, b.y, 2);
  const to = exit(b, a.x, a.y, bow ? 5 : 2);
  if (!bow) return `M${from.x} ${from.y}L${to.x} ${to.y}`;
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bend = 0.12;
  return `M${from.x} ${from.y}Q${mx - dy * bend} ${my + dx * bend} ${to.x} ${to.y}`;
}

/** Where the line toward (tx, ty) leaves the body's box, `pad` beyond it. */
function exit(body: Body, tx: number, ty: number, pad: number) {
  const dx = tx - body.x;
  const dy = ty - body.y;
  const hw = body.w / 2 + pad;
  const hh = body.h / 2 + pad;
  if (dx === 0 && dy === 0) return { x: body.x, y: body.y };
  const t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: body.x + dx * Math.min(t, 1), y: body.y + dy * Math.min(t, 1) };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
