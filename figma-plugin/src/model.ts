/**
 * The Figma Plugin API, as much of it as the converter reads.
 *
 * Deliberately a subset written by hand rather than the SDK's own types: the
 * converter is a pure function, and a test hands it plain objects shaped like
 * this. Everything is optional past the few fields every node has, because
 * Figma's node types share these fields unevenly and the converter asks
 * before it reads. Where the SDK answers `figma.mixed` (a symbol) the field
 * is typed to admit it, and `num()` below is how a caller keeps a number.
 */

export type Vec = { x: number; y: number };
export type RGB = { r: number; g: number; b: number };
export type RGBA = RGB & { a: number };
/** `[[a, b, tx], [c, d, ty]]`, the Plugin API's row-major 2×3. */
export type Transform = [[number, number, number], [number, number, number]];

export type ColorStop = { position: number; color: RGBA };

export type Paint = {
  type:
    | "SOLID"
    | "GRADIENT_LINEAR"
    | "GRADIENT_RADIAL"
    | "GRADIENT_ANGULAR"
    | "GRADIENT_DIAMOND"
    | "IMAGE"
    | "VIDEO"
    | string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: RGB;
  gradientStops?: ColorStop[];
  gradientTransform?: Transform;
  imageHash?: string | null;
  scaleMode?: "FILL" | "FIT" | "CROP" | "TILE";
};

export type Effect = {
  type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR" | string;
  visible?: boolean;
  radius: number;
  color?: RGBA;
  offset?: Vec;
  spread?: number;
};

export type FontName = { family: string; style: string };
export type Measure = { value: number; unit: "PIXELS" | "PERCENT" | "AUTO" };

export type StyledSegment = {
  characters: string;
  start: number;
  end: number;
  fontSize?: number;
  fontName?: FontName;
  fills?: Paint[];
  textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  textCase?: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";
  letterSpacing?: Measure;
  hyperlink?: { type: "URL" | "NODE"; value: string } | null;
  listOptions?: { type: "ORDERED" | "UNORDERED" | "NONE" };
};

export type ConnectorEnd =
  | { endpointNodeId: string; magnet?: string }
  | { position: Vec };

export type Mixed = symbol;

export interface FigNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  locked?: boolean;
  /** Masks every sibling after it in `children` — the layers above it. */
  isMask?: boolean;
  maskType?: "ALPHA" | "VECTOR" | "LUMINANCE";

  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  relativeTransform?: Transform;
  absoluteTransform?: Transform;

  opacity?: number;
  blendMode?: string;
  fills?: Paint[] | Mixed;
  strokes?: Paint[];
  strokeWeight?: number | Mixed;
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  dashPattern?: number[];
  strokeCap?: string | Mixed;
  strokeJoin?: string | Mixed;
  cornerRadius?: number | Mixed;
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomRightRadius?: number;
  bottomLeftRadius?: number;
  effects?: Effect[];

  children?: FigNode[];

  // Frames and auto layout.
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  layoutWrap?: "NO_WRAP" | "WRAP";
  itemSpacing?: number;
  counterAxisSpacing?: number | null;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  clipsContent?: boolean;

  // Ellipse, polygon, star.
  arcData?: { startingAngle: number; endingAngle: number; innerRadius: number };
  pointCount?: number;

  // Vectors.
  booleanOperation?: "UNION" | "INTERSECT" | "SUBTRACT" | "EXCLUDE";
  vectorPaths?: { windingRule: string; data: string }[];
  fillGeometry?: { windingRule?: string; data: string }[];
  strokeGeometry?: { windingRule?: string; data: string }[];

  // Text.
  characters?: string;
  fontSize?: number | Mixed;
  fontName?: FontName | Mixed;
  textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
  textAutoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE";
  maxLines?: number | null;
  lineHeight?: Measure | Mixed;
  letterSpacing?: Measure | Mixed;
  paragraphSpacing?: number;
  textCase?: StyledSegment["textCase"] | Mixed;
  textDecoration?: StyledSegment["textDecoration"] | Mixed;
  getStyledTextSegments?: (fields: string[]) => StyledSegment[];

  // FigJam.
  connectorStart?: ConnectorEnd;
  connectorEnd?: ConnectorEnd;
  connectorLineType?: "ELBOWED" | "STRAIGHT" | "CURVED";
  text?: { characters: string };
  shapeType?: string;
}

/** A number, or nothing when the field is `figma.mixed` or absent. */
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An object field, or nothing when it is `figma.mixed` or absent. */
export function obj<T extends object>(value: T | Mixed | undefined): T | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

export function paints(value: Paint[] | Mixed | undefined): Paint[] {
  return Array.isArray(value) ? value : [];
}
