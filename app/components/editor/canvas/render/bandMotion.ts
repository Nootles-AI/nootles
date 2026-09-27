/**
 * How a band moves when its geometry changes by commit rather than by hand.
 *
 * A committed height — Auto height, a typed H, an undo, a collaborator's edit,
 * a diagram drawn onto the page opening — glides from what is on screen to
 * what the scene says, so the text under the band glides with it instead of
 * jumping. Whatever follows the pointer stays 1:1: a gesture writes the height
 * straight to the element, and every such write, and every press anywhere,
 * stops a glide first, so the inline height is what shows and nothing measured
 * mid-gesture is caught mid-flight.
 *
 * The height is the one layout property animated here, on purpose: the page
 * below *should* move. One WAAPI animation and no per-frame reads of its own,
 * but it resizes the editor root every frame for its 270ms, so the editor's
 * ResizeObservers — comment margin, side menu, nested band anchors, a
 * cross-diagram selection — re-measure each frame, as they do under a grip.
 */

const REDUCED = "(prefers-reduced-motion: reduce)";

/** The id a band's height glide carries, for whoever has to wait one out. */
export const BAND_GLIDE = "nt-band-glide";

const tokens = new Map<string, string>();

/** A motion token from `globals.css`, read once: the app has one theme. */
export function motionToken(name: "--ease" | "--dur" | "--dur-slow", fallback: string): string {
  let value = tokens.get(name);
  if (value === undefined) {
    value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    tokens.set(name, value);
  }
  return value;
}

/** A CSS time as milliseconds. */
export function toMs(time: string): number {
  const n = parseFloat(time);
  if (!Number.isFinite(n)) return 0;
  return time.trim().endsWith("ms") ? n : n * 1000;
}

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED).matches;
}

const glides = new WeakMap<HTMLElement, Animation>();
const running = new Set<HTMLElement>();
/** Bands whose next committed height is to land as it is — see {@link holdBandStill}. */
const still = new WeakSet<HTMLElement>();

// Capture phase, ahead of every handler: a press starts whatever it starts on
// the band's committed height.
const stopAll = () => {
  for (const el of [...running]) stopBandGlide(el);
};

function forget(el: HTMLElement) {
  glides.delete(el);
  running.delete(el);
  if (!running.size) document.removeEventListener("pointerdown", stopAll, true);
}

/** The glide running on this band, if one is. */
export function bandGlide(el: HTMLElement): Animation | undefined {
  return glides.get(el);
}

/** Lets the band show its inline height at once — before any write to it. */
export function stopBandGlide(el: HTMLElement): void {
  const glide = glides.get(el);
  if (!glide) return;
  forget(el);
  glide.cancel();
}

/**
 * The band's next committed height lands without a glide: a change the page
 * makes up for around it — a merge, whose band grows by what the block taken
 * out below it held — would otherwise shove the text down and back.
 */
export function holdBandStill(el: HTMLElement): void {
  still.add(el);
  requestAnimationFrame(() => still.delete(el));
}

/** Whether a band `from`/`to` px tall at its current top is nowhere on screen. */
function offscreen(el: HTMLElement, from: number, to: number): boolean {
  const r = el.getBoundingClientRect();
  const k = el.offsetHeight ? r.height / el.offsetHeight : 1;
  return r.top > window.innerHeight || r.top + Math.max(from, to) * k < 0;
}

/**
 * Glides the band from `from` px to `to` px, its inline height already `to`.
 * A glide under way is taken over from where it has got to. Skipped under
 * reduced motion, and for a band nobody can see: the band is the page's
 * scroll anchor, and moving what is off screen only moves the reader.
 */
export function glideBandHeight(el: HTMLElement, from: number, to: number): void {
  const shown = glides.has(el) ? el.offsetHeight : from;
  stopBandGlide(el);
  if (still.has(el)) {
    still.delete(el);
    return;
  }
  if (Math.abs(shown - to) < 1 || reducedMotion() || offscreen(el, shown, to)) return;
  const glide = el.animate([{ height: `${shown}px` }, { height: `${to}px` }], {
    id: BAND_GLIDE,
    duration: toMs(motionToken("--dur-slow", "270ms")),
    easing: motionToken("--ease", "ease-out"),
  });
  if (!running.size) document.addEventListener("pointerdown", stopAll, true);
  glides.set(el, glide);
  running.add(el);
  glide.finished.then(
    () => {
      if (glides.get(el) === glide) forget(el);
    },
    () => {},
  );
}

const widths = new WeakMap<HTMLElement, Animation>();

/**
 * A band gone wide or back to the column, as its dot grid shows it: the grid
 * wipes out into the margins or back in from them over the drawing, which
 * does not move. Its edges travel while its background travels the other way
 * by as much, so every dot stays where it was. Nothing measures the grid, so
 * it runs to the end whatever the pointer does.
 */
export function glideBandWidth(grid: HTMLElement, margin: number, widening: boolean): void {
  widths.get(grid)?.cancel();
  widths.delete(grid);
  if (!margin || reducedMotion()) return;
  const edge = widening ? margin : -margin;
  const x = parseFloat(grid.style.backgroundPositionX || "0") || 0;
  const wipe = grid.animate(
    [
      { left: `${edge}px`, right: `${edge}px`, backgroundPositionX: `${x - edge}px` },
      { left: "0px", right: "0px", backgroundPositionX: `${x}px` },
    ],
    {
      duration: toMs(motionToken("--dur-slow", "270ms")),
      easing: motionToken("--ease", "ease-out"),
    },
  );
  widths.set(grid, wipe);
  wipe.finished.then(
    () => {
      if (widths.get(grid) === wipe) widths.delete(grid);
    },
    () => {},
  );
}
