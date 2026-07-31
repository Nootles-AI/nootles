/**
 * The panel's icon language.
 *
 * Two conventions, and a glyph belongs to exactly one of them:
 *
 * **Line glyphs** mark a *property* — they sit inside a field, at the size of a
 * letter, and stand in for a name the field has no room for. Stroked, 1.25 on a
 * 16 grid, no fills.
 *
 * **Solid glyphs** depict an *arrangement* — they fill a segmented button and
 * show a layout rather than naming one. Filled bars at full strength; the
 * button's own colour carries the on/off state, so the glyph never dims itself.
 *
 * Before this module the panel had three drawing conventions, six sizes and two
 * mirror-image eyes in adjacent sections. Add to these rather than drawing a
 * one-off beside the thing that needs it.
 */

import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;

/** A property marker: stroked, sized like a letter, sits inside a field. */
function Line({ children, ...props }: Props) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

/** An arrangement: filled, fills a segmented button. */
function Solid({ children, ...props }: Props) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

/** Bars as `x,y,w,h`, which is how an arrangement is easiest to read as data. */
function Bars({ spec, ...props }: Props & { spec: string }) {
  return (
    <Solid {...props}>
      {spec.split(" ").map((bar) => {
        const [x, y, w, h] = bar.split(",");
        return <rect key={bar} x={x} y={y} width={w} height={h} rx="1" />;
      })}
    </Solid>
  );
}

/* ---- Geometry ----------------------------------------------------------- */

export function Rotation(props: Props) {
  return (
    <Line {...props}>
      <path d="M8 3.4a4.6 4.6 0 1 1-3.9 2.15" />
      <path d="M4.6 2.6v2.9h2.9" />
    </Line>
  );
}

/** The one corner arc, turned. `turn` is quarter-turns clockwise from top-left. */
export function Corner({ turn = 0, ...props }: Props & { turn?: number }) {
  return (
    <Line {...props}>
      <path
        d="M3.2 13V7.2A4 4 0 0 1 7.2 3.2H13"
        transform={turn ? `rotate(${turn * 90} 8 8)` : undefined}
      />
    </Line>
  );
}

export function Sides(props: Props) {
  return (
    <Line {...props}>
      <path d="M8 2.6 13.3 6.4 11.3 12.6H4.7L2.7 6.4Z" />
    </Line>
  );
}

export function ArcStart(props: Props) {
  return (
    <Line {...props}>
      <circle cx="8" cy="8" r="5" strokeOpacity="0.35" />
      <path d="M8 8V3" />
    </Line>
  );
}

export function ArcSweep(props: Props) {
  return (
    <Line {...props}>
      <circle cx="8" cy="8" r="5" strokeOpacity="0.35" />
      <path d="M8 3a5 5 0 0 1 4.33 2.5L8 8Z" fill="currentColor" stroke="none" />
      <path d="M8 8V3M8 8l4.33-2.5" />
    </Line>
  );
}

export function ArcRatio(props: Props) {
  return (
    <Line {...props}>
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="8" r="2" strokeOpacity="0.45" />
    </Line>
  );
}

/* ---- Box model ---------------------------------------------------------- */

/** The box drawn faint with one edge lit: which side, shown rather than named. */
export function PadSide({
  side,
  ...props
}: Props & { side: "top" | "right" | "bottom" | "left" }) {
  const edge = {
    top: "M3.6 3.6h8.8",
    right: "M12.4 3.6v8.8",
    bottom: "M3.6 12.4h8.8",
    left: "M3.6 3.6v8.8",
  }[side];
  return (
    <Line {...props}>
      <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.5" strokeOpacity="0.3" />
      <path d={edge} />
    </Line>
  );
}

export function PadAll(props: Props) {
  return (
    <Line {...props}>
      <rect
        x="3.6"
        y="3.6"
        width="8.8"
        height="8.8"
        rx="1.5"
        strokeDasharray="2.4 2"
      />
    </Line>
  );
}

export function Gap(props: Props) {
  return (
    <Line {...props}>
      <rect x="2.6" y="3.5" width="3.8" height="9" rx="1" strokeOpacity="0.3" />
      <rect x="9.6" y="3.5" width="3.8" height="9" rx="1" strokeOpacity="0.3" />
      <path d="M8 4.2v7.6" />
    </Line>
  );
}

/** Closed when the ratio is held, broken when it is not — the state is the
 *  drawing, not a colour the surrounding button would have to supply. */
export function AspectLock({ on, ...props }: Props & { on: boolean }) {
  return (
    <Line {...props}>
      {on ? (
        <>
          <path d="M6.4 4.6h-1a3.4 3.4 0 0 0 0 6.8h1M9.6 4.6h1a3.4 3.4 0 0 1 0 6.8h-1" />
          <path d="M6.2 8h3.6" />
        </>
      ) : (
        <path d="M6.1 4.6h-.7a3.4 3.4 0 0 0 0 6.8h.7M9.9 4.6h.7a3.4 3.4 0 0 1 0 6.8h-.7" />
      )}
    </Line>
  );
}

/* ---- Type --------------------------------------------------------------- */

export function FontSize(props: Props) {
  return (
    <Line {...props}>
      <path d="M1.9 12.6 4.9 3.6l3 9M2.9 10.1h4" />
      <path d="M9.8 12.6 11.6 7.4l1.8 5.2M10.4 11.1h2.4" />
    </Line>
  );
}

export function LineHeight(props: Props) {
  return (
    <Line {...props}>
      <path d="M6.4 3.6h7.6M6.4 8h7.6M6.4 12.4h7.6" strokeOpacity="0.45" />
      <path d="M3 3.6v8.8M1.8 4.8 3 3.6l1.2 1.2M1.8 11.2 3 12.4l1.2-1.2" />
    </Line>
  );
}

export function LetterSpacing(props: Props) {
  return (
    <Line {...props}>
      <path d="M2.6 3.2v9.6M13.4 3.2v9.6" strokeOpacity="0.45" />
      <path d="M5.2 8h5.6M6.6 6.6 5.2 8l1.4 1.4M9.4 6.6 10.8 8l-1.4 1.4" />
    </Line>
  );
}

/* ---- Effects ------------------------------------------------------------ */

export function Blur(props: Props) {
  return (
    <Line {...props}>
      <path d="M8 3a5 5 0 0 1 0 10" />
      <path d="M8 3a5 5 0 0 0 0 10" strokeDasharray="1.4 1.8" />
    </Line>
  );
}

export function Spread(props: Props) {
  return (
    <Line {...props}>
      <rect x="5.6" y="5.6" width="4.8" height="4.8" rx="1" />
      <path d="M3 3l1.6 1.6M13 3l-1.6 1.6M3 13l1.6-1.6M13 13l-1.6-1.6" />
    </Line>
  );
}

export function Brightness(props: Props) {
  return (
    <Line {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M3.5 12.5l1-1" />
    </Line>
  );
}

export function Contrast(props: Props) {
  return (
    <Line {...props}>
      <circle cx="8" cy="8" r="5" />
      <path d="M8 3a5 5 0 0 1 0 10Z" fill="currentColor" stroke="none" />
    </Line>
  );
}

export function Saturation(props: Props) {
  return (
    <Line {...props}>
      <path d="M8 2.4c2.6 3 4 5 4 6.6a4 4 0 0 1-8 0c0-1.6 1.4-3.6 4-6.6Z" />
    </Line>
  );
}

export function Grayscale(props: Props) {
  return (
    <Line {...props}>
      <rect x="2.6" y="4" width="10.8" height="8" rx="1.5" />
      <path d="M8 4v8" />
      <path
        d="M8 4h3.9a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 11.9 12H8Z"
        fill="currentColor"
        stroke="none"
      />
    </Line>
  );
}

/* ---- State -------------------------------------------------------------- */

/** The panel's only eye. It used to have two, whose slashes ran opposite ways
 *  in adjacent sections. */
export function Eye({ off, ...props }: Props & { off?: boolean }) {
  return (
    <Line {...props}>
      <path d="M1.8 8S3.9 4.4 8 4.4 14.2 8 14.2 8 12.1 11.6 8 11.6 1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.7" />
      {off && <path d="M3.2 3.2 12.8 12.8" />}
    </Line>
  );
}

/* ---- Stroke ------------------------------------------------------------- */

/** Not a "W": that letter is already Width, two sections up. */
export function StrokeWeight(props: Props) {
  return (
    <Line {...props}>
      <path d="M2.6 5.2h10.8" strokeWidth="2.6" />
      <path d="M2.6 10.6h10.8" strokeWidth="1" />
    </Line>
  );
}

/** Weighted so the three read apart at 14px: the dotted one used to differ from
 *  the dashed one by a hair of dash length and nothing else. */
export function Dash({
  kind,
  ...props
}: Props & { kind: "solid" | "dashed" | "dotted" }) {
  const dash = { solid: undefined, dashed: "3.2 2.4", dotted: "0.1 2.8" }[kind];
  return (
    <Line {...props}>
      <path
        d="M2.4 8h11.2"
        strokeWidth={kind === "dotted" ? 2 : 1.5}
        strokeDasharray={dash}
      />
    </Line>
  );
}

/* ---- Arrangements (solid) ----------------------------------------------- */

export function FlowRow(props: Props) {
  return <Bars spec="3,4,2.6,8 6.7,4,2.6,8 10.4,4,2.6,8" {...props} />;
}

export function FlowColumn(props: Props) {
  return <Bars spec="4,3,8,2.6 4,6.7,8,2.6 4,10.4,8,2.6" {...props} />;
}

export function FlowGrid(props: Props) {
  return (
    <Bars
      spec="3.2,3.2,4.4,4.4 8.4,3.2,4.4,4.4 3.2,8.4,4.4,4.4 8.4,8.4,4.4,4.4"
      {...props}
    />
  );
}

/** Free placement: two blocks that agree with no axis. */
export function FlowNone(props: Props) {
  return <Bars spec="2.6,3.2,5.6,4.8 7.8,8,5.6,4.8" {...props} />;
}

/* ---- Alignment (solid) --------------------------------------------------- */

/** A rule with the bars that answer to it. Both halves are the icon, so the
 *  rule is drawn at full strength rather than as a hairline hint. */
export function Align({
  rule,
  bars,
  ...props
}: Props & { rule?: string; bars: string }) {
  return (
    <Solid {...props}>
      {rule &&
        (() => {
          const [x1, y1, x2, y2] = rule.split(",");
          return (
            <path
              d={`M${x1} ${y1}L${x2} ${y2}`}
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              fill="none"
            />
          );
        })()}
      {bars.split(" ").map((bar) => {
        const [x, y, w, h] = bar.split(",");
        return (
          <rect
            key={bar}
            x={x}
            y={y}
            width={w}
            height={h}
            rx="1"
            fillOpacity="0.5"
          />
        );
      })}
    </Solid>
  );
}

/* ---- Text alignment ------------------------------------------------------ */

export function TextAlign({ d, ...props }: Props & { d: string }) {
  return (
    <Line {...props} strokeWidth="1.4">
      <path d={d} />
    </Line>
  );
}
