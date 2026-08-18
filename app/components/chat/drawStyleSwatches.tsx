import type { ReactNode } from "react";
import type { DrawStyleName } from "@/app/lib/ai/drawStyles";

/**
 * One scene, drawn every way the picker offers.
 *
 * A style picker is a specimen sheet: the way to judge a face is to set the
 * same sentence in every one of them. So every swatch is the same sun over the
 * same two hills, and the only thing that changes between cells is how that
 * scene is drawn — flat fills, carved gouges, marker lines, paper layers.
 * Comparing them is then reading one difference instead of twelve pictures.
 *
 * Authored rather than generated: a real Recraft sample costs four cents and
 * arrives at a thousand paths, where a swatch has to read at 62 pixels. Hand
 * geometry is also the only way the scene can stay identical across all of
 * them, which is the whole point of a specimen.
 */

const INK = "#26241f";
const PAPER = "#f6f3ec";
const SUN = "#d9a441";
const HILL = "#8a9a8f";
const DEEP = "#5c6b66";
const CLAY = "#b4553f";
const SLATE = "#5b6b84";

/** The scene, as measurements every renderer draws from. */
const SKY = { x: 0, y: 0, w: 32, h: 24 };
const SUN_C = { cx: 22.5, cy: 7, r: 3.4 };
const HILL_A = { cx: 9, cy: 17.5, rx: 11, ry: 6.5 };
const HILL_B = { cx: 25, cy: 18.5, rx: 9.5, ry: 5.5 };
const HORIZON = 15.5;

function Paper({ fill = PAPER }: { fill?: string }) {
  return <rect x={SKY.x} y={SKY.y} width={SKY.w} height={SKY.h} fill={fill} />;
}

/** The land as one silhouette — the shape most styles fill or carve. */
const LAND = `M0 ${HORIZON} Q ${HILL_A.cx} ${HILL_A.cy - HILL_A.ry} ${HILL_A.cx + HILL_A.rx} ${HORIZON} Q ${HILL_B.cx} ${HILL_B.cy - HILL_B.ry} 32 ${HORIZON} L32 24 L0 24 Z`;

const strokeScene = (color: string, width: number, extra = {}) => (
  <g fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" {...extra}>
    <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} />
    <path d={`M0 ${HORIZON} Q ${HILL_A.cx} ${HILL_A.cy - HILL_A.ry} ${HILL_A.cx + HILL_A.rx} ${HORIZON}`} />
    <path d={`M13 ${HORIZON} Q ${HILL_B.cx} ${HILL_B.cy - HILL_B.ry} 32 ${HORIZON}`} />
    <path d={`M0 ${HORIZON}h32`} />
  </g>
);

/** Evenly spaced marks — hatching, tiles, hairlines. */
const series = (n: number, f: (i: number) => ReactNode) =>
  Array.from({ length: n }, (_, i) => f(i));

export const STYLE_SWATCHES: Record<DrawStyleName, ReactNode> = {
  "Vector art": (
    <>
      <Paper />
      <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} fill={SUN} />
      <path d={LAND} fill={HILL} />
      <ellipse cx={HILL_B.cx} cy={HILL_B.cy} rx={HILL_B.rx} ry={HILL_B.ry} fill={DEEP} />
    </>
  ),

  "Line art": (
    <>
      <Paper />
      {strokeScene(INK, 1)}
    </>
  ),

  "Bold stroke": (
    <>
      <Paper />
      {strokeScene(INK, 2.6)}
    </>
  ),

  "Marker outline": (
    <>
      <Paper />
      <path d={LAND} fill={SUN} opacity={0.4} transform="translate(1 -0.8)" />
      {/* One unbroken hill line: two arcs meeting mid-swatch tied a knot. */}
      <g fill="none" stroke={INK} strokeWidth={1.5} strokeLinecap="round" opacity={0.9}>
        <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} />
        <path d="M0 16.4 Q 8 10.6 16 15.4 Q 24 19 32 14.6" />
      </g>
    </>
  ),

  Linocut: (
    <>
      <Paper />
      <path d={LAND} fill={INK} />
      <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} fill={INK} />
      <g stroke={PAPER} strokeWidth={0.9} strokeLinecap="round">
        {series(4, (i) => (
          <path key={i} d={`M${2 + i * 7} ${19 + (i % 2)}h5`} />
        ))}
        <path d={`M${SUN_C.cx - 2} ${SUN_C.cy - 1}h4`} />
      </g>
    </>
  ),

  "Sharp contrast": (
    <>
      <Paper fill="#ffffff" />
      <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} fill="#000000" />
      <path d={LAND} fill="#000000" />
      <path d="M2 19h7" stroke="#ffffff" strokeWidth={1.2} />
    </>
  ),

  Editorial: (
    <>
      <Paper />
      <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} fill={CLAY} />
      <path d={LAND} fill={INK} />
      <path d={`M0 ${HORIZON}h32`} stroke={CLAY} strokeWidth={1.2} />
    </>
  ),

  Cutout: (
    <>
      <Paper />
      <g>
        <circle cx={SUN_C.cx + 0.5} cy={SUN_C.cy + 0.6} r={SUN_C.r} fill={INK} opacity={0.16} />
        <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} fill={SUN} />
        <path d={LAND} fill={INK} opacity={0.16} transform="translate(0.6 0.7)" />
        <path d={LAND} fill={HILL} />
        <ellipse cx={HILL_B.cx} cy={HILL_B.cy + 0.6} rx={HILL_B.rx} ry={HILL_B.ry} fill={INK} opacity={0.14} />
        <ellipse cx={HILL_B.cx} cy={HILL_B.cy} rx={HILL_B.rx} ry={HILL_B.ry} fill={DEEP} />
      </g>
    </>
  ),

  "Roundish flat": (
    <>
      <Paper />
      <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} fill={SUN} />
      <rect x={-2} y={13} width={22} height={16} rx={8} fill={HILL} />
      <rect x={14} y={16} width={22} height={12} rx={6} fill={DEEP} />
    </>
  ),

  "Colored stencil": (
    <>
      <Paper />
      <path d={LAND} fill={CLAY} />
      <g fill={PAPER}>
        <rect x={0} y={18} width={32} height={0.9} />
        <rect x={11} y={15.5} width={1.1} height={8.5} />
      </g>
      <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r} fill={SUN} />
    </>
  ),

  "Color blobs": (
    <>
      <Paper />
      <g opacity={0.85}>
        <ellipse cx={20} cy={9} rx={8} ry={7} fill={SUN} />
        <ellipse cx={11} cy={16} rx={11} ry={8} fill={HILL} opacity={0.9} />
        <ellipse cx={25} cy={18} rx={9} ry={6} fill={SLATE} opacity={0.75} />
      </g>
    </>
  ),

  "Vivid shapes": (
    <>
      <Paper fill="#fff8e8" />
      <circle cx={SUN_C.cx} cy={SUN_C.cy} r={SUN_C.r + 0.4} fill="#f5a524" />
      <path d={LAND} fill="#2fa87a" />
      <ellipse cx={HILL_B.cx} cy={HILL_B.cy} rx={HILL_B.rx} ry={HILL_B.ry} fill="#1f7fa8" />
    </>
  ),
};
