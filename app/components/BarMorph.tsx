"use client";

import { Component, createRef, type ReactNode } from "react";

/**
 * The foot-of-the-page bar turning over between the page's tools and a
 * diagram's, as one object changing shape rather than one bar leaving and
 * another arriving.
 *
 * The two bars are different components, so there is nothing to animate
 * between in React's terms. What they share is what they show: the same
 * buttons under the same names. So the outgoing bar is measured the instant
 * before it is replaced (`getSnapshotBeforeUpdate`, the one moment the old
 * DOM and the new props coexist) and the incoming one is played back from it,
 * FLIP-style — its surface stretched from the old outline, each button it
 * shares sliding from where it was, the shapes folding into (or fanning out
 * of) their slot, and anything only one bar has fading through.
 *
 * Everything the morph draws is placed in the incoming bar's own frame, never
 * the dock's or the window's: the column the bar centres on can be resizing
 * under it (entering a diagram with the sidebar put away opens the layers
 * rail), and a piece pinned anywhere else would slide off the bar it dresses.
 */

type Part = { el: HTMLElement; rect: DOMRect; shape: boolean };
type Shot = { bar: DOMRect; parts: Map<string, Part>; slot: DOMRect | null };

const BAR = ".nt-toolbar-dock:not([data-leaving]) > .nt-toolbar";
const MS = 370;
const OUT_MS = 95;
/** Between one shape folding (or fanning) and the next. */
const STAGGER = 40;
/** One shape's fold into the slot. */
const FOLD = 220;
const EASE = "cubic-bezier(0.25, 0, 0, 1)";

/** Every piece of a bar, by a name both bars would give it. */
function partsOf(bar: HTMLElement): Map<string, HTMLElement> {
  const parts = new Map<string, HTMLElement>();
  let sep = 0;
  for (const el of bar.querySelectorAll<HTMLElement>("button, .nt-toolbar-mark, .nt-toolbar-sep")) {
    if (el.closest(".nt-toolbar-ghost")) continue;
    const name = el.dataset.morph
      ? el.dataset.morph
      : el.classList.contains("nt-toolbar-mark")
      ? "mark"
      : el.classList.contains("nt-toolbar-sep")
        ? `sep:${sep++}`
        : (el.getAttribute("aria-label") ?? el.textContent?.trim());
    if (name) parts.set(name, el);
  }
  return parts;
}

function measure(root: HTMLElement | null): Shot | null {
  const bar = root?.querySelector<HTMLElement>(BAR);
  if (!bar) return null;
  // Caught mid-morph, the outline is the skin's: the bar itself is already
  // at its destination size with its surface lent out.
  const skin = bar.querySelector<HTMLElement>(":scope > .nt-toolbar-skin");
  const parts = new Map<string, Part>();
  for (const [name, el] of partsOf(bar)) {
    parts.set(name, { el, rect: el.getBoundingClientRect(), shape: el.dataset.shape !== undefined });
  }
  const slot = bar.querySelector(".nt-toolbar-shapes")?.getBoundingClientRect() ?? null;
  return { bar: (skin ?? bar).getBoundingClientRect(), parts, slot };
}

const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const distance = (a: DOMRect, b: DOMRect) => Math.abs(centre(a).x - centre(b).x);

/** The move from `to` back to `from`, as the `translate`/`scale` a FLIP starts at. */
function offset(from: DOMRect, to: DOMRect, scale = true) {
  const a = centre(from);
  const b = centre(to);
  return {
    translate: `${a.x - b.x}px ${a.y - b.y}px`,
    scale: scale ? `${from.width / to.width} ${from.height / to.height}` : "1",
  };
}

function play(root: HTMLElement | null, shot: Shot) {
  const bar = root?.querySelector<HTMLElement>(BAR);
  if (!bar) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  // It is not arriving, it is changing: no rise from below.
  for (const a of bar.getAnimations()) if (a instanceof CSSAnimation) a.cancel();
  const spring =
    getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || EASE;
  const now = bar.getBoundingClientRect();
  const slotEl = bar.querySelector<HTMLElement>(".nt-toolbar-shapes");
  // Where folded shapes land: under the shape the slot shows, not its middle,
  // which is off towards the caret.
  const slot = slotEl?.querySelector(".nt-toolbar-btn")?.getBoundingClientRect() ?? null;
  /** Where `r` was, as a box inside the bar. */
  const box = (r: DOMRect) => ({
    left: `${r.left - now.left}px`,
    top: `${r.top - now.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  /** The bar's own box, drawn in by as far as it is from `r`. */
  const inset = (r: DOMRect) => ({
    top: `${r.top - now.top}px`,
    right: `${now.right - r.right}px`,
    bottom: `${now.bottom - r.bottom}px`,
    left: `${r.left - now.left}px`,
  });

  // The surface: lent to a skin behind the buttons for the length of the
  // morph, so the outline can stretch while the buttons keep their true size.
  const look = getComputedStyle(bar);
  const skin = document.createElement("div");
  skin.className = "nt-toolbar-skin";
  skin.setAttribute("aria-hidden", "");
  Object.assign(skin.style, {
    background: look.backgroundColor,
    boxShadow: look.boxShadow,
    borderRadius: look.borderRadius,
  });
  bar.prepend(skin);
  bar.dataset.morphing = "";
  skin
    .animate([inset(shot.bar), inset(now)], { duration: MS, easing: spring, fill: "forwards" })
    .finished.catch(() => {})
    .finally(() => {
      skin.remove();
      if (!bar.querySelector(":scope > .nt-toolbar-skin")) delete bar.dataset.morphing;
    });

  const parts = partsOf(bar);
  // Shapes fanning out leave the slot one after another, nearest first.
  const fanned = shot.slot
    ? [...parts.values()]
        .filter((el) => el.dataset.shape !== undefined && !shot.parts.has(el.getAttribute("aria-label") ?? ""))
        .sort((a, b) => distance(a.getBoundingClientRect(), shot.slot!) - distance(b.getBoundingClientRect(), shot.slot!))
    : [];
  // Shapes fold nearest first, and under the bar's own buttons rather than
  // over them, so each one visibly tucks in behind the shape the slot shows.
  const folding = [...shot.parts.entries()]
    .filter(([name, part]) => !parts.has(name) && part.shape && slot)
    .sort(([, a], [, b]) => distance(a.rect, slot!) - distance(b.rect, slot!))
    .map(([name]) => name);
  // When the last of them is in, and the slot takes them.
  const landed = FOLD + Math.max(0, folding.length - 1) * STAGGER;
  // The shapes never travel through anything else: arriving tools wait until
  // the fold has landed, and fanned-out shapes until departing tools are gone.
  const arrive = folding.length ? landed - 80 : 60;
  const departing = [...shot.parts].some(([name, part]) => !parts.has(name) && !part.shape);
  const fanFrom = departing ? OUT_MS : 40;

  const seen = new Set<string>();
  for (const [name, el] of parts) {
    const was = shot.parts.get(name);
    const is = el.getBoundingClientRect();
    // A fresh element's own transitions (the mark inking in) would replay what
    // the morph is already showing.
    for (const a of el.getAnimations()) if (a instanceof CSSTransition) a.finish();
    if (was) {
      seen.add(name);
      el.animate([offset(was.rect, is, name === "mark"), { translate: "0 0", scale: "1" }], {
        duration: MS,
        easing: spring,
      });
    } else if (el.dataset.shape !== undefined && shot.slot) {
      // Fanning out from behind the shape they were folded under: visible from
      // the start, so the eye follows each one out of the slot.
      el.animate(
        [
          { ...offset(shot.slot, is, false), scale: "0.7", opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { translate: "0 0", scale: "1", opacity: 1 },
        ],
        { duration: MS, delay: fanFrom + fanned.indexOf(el) * STAGGER, easing: spring, fill: "backwards" },
      );
    } else if (el.classList.contains("nt-toolbar-caret") && slot) {
      // The caret comes out from under the slot once the shapes are in it.
      el.animate(
        [
          { opacity: 0, translate: "-10px 0", scale: "0.6" },
          { opacity: 1, translate: "0 0", scale: "1" },
        ],
        { duration: 220, delay: landed - 40, easing: spring, fill: "backwards" },
      );
    } else {
      el.animate([{ opacity: 0, scale: "0.6" }, { opacity: 1, scale: "1" }], {
        duration: MS * 0.7,
        delay: arrive,
        easing: spring,
        fill: "backwards",
      });
    }
  }

  // What only the old bar had is gone from the DOM; a copy of it stays for
  // long enough to leave — into the slot if it was a shape, else in place.
  for (const [name, part] of shot.parts) {
    if (seen.has(name)) continue;
    const ghost = part.el.cloneNode(true) as HTMLElement;
    ghost.classList.add("nt-toolbar-ghost");
    ghost.setAttribute("inert", "");
    ghost.setAttribute("aria-hidden", "");
    ghost.removeAttribute("aria-pressed");
    Object.assign(ghost.style, { position: "absolute", margin: "0", pointerEvents: "none", ...box(part.rect) });
    const order = folding.indexOf(name);
    if (order >= 0 && slot) {
      ghost.style.zIndex = "-1";
      skin.after(ghost);
      ghost
        .animate(
          [
            { translate: "0 0", scale: "1", opacity: 1 },
            { opacity: 1, offset: 0.8 },
            { ...offset(slot, part.rect, false), scale: "0.8", opacity: 0 },
          ],
          { duration: FOLD, delay: order * STAGGER, easing: EASE, fill: "both" },
        )
        .finished.catch(() => {})
        .finally(() => ghost.remove());
      continue;
    }
    bar.append(ghost);
    // The caret goes first when the shapes fan out, so they leave from a
    // plain shape rather than from under the caret.
    ghost
      .animate([{ opacity: 1 }, { opacity: 0, scale: "0.6" }], {
        duration: part.el.classList.contains("nt-toolbar-caret") ? OUT_MS * 0.6 : OUT_MS,
        easing: EASE,
        fill: "forwards",
      })
      .finished.catch(() => {})
      .finally(() => ghost.remove());
  }

  // The slot takes the shapes in with a small give, as they land.
  if (folding.length && slotEl) {
    slotEl.animate([{ scale: "1" }, { scale: "1.1" }, { scale: "1" }], {
      duration: 240,
      delay: landed - 60,
      easing: "cubic-bezier(0.3, 0, 0.2, 1)",
    });
  }
}

export class BarMorph extends Component<{ mode: string; children: ReactNode }> {
  private root = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(prev: { mode: string }): Shot | null {
    return prev.mode !== this.props.mode ? measure(this.root.current) : null;
  }

  componentDidUpdate(_prev: unknown, _state: unknown, shot: Shot | null) {
    if (shot) play(this.root.current, shot);
  }

  render() {
    return (
      // The resize handles carry a z-index of their own — hence the stacking
      // context around the bar.
      <div ref={this.root} className="relative" style={{ zIndex: "var(--z-sticky)" }}>
        {this.props.children}
      </div>
    );
  }
}
