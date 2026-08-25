import { SVGProps } from "react";

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ChevronLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function ChevronRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function ChevronsUpDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
    </svg>
  );
}

export function Plus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function PanelLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

export function PanelRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

export function Check(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function Settings(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

export function Trash(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
    </svg>
  );
}

export function MoreHorizontal(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  );
}

/** The two ways the projects screen can be laid out. */
export function GridView(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function ListView(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function ArrowLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

export function LinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/** A page's outline, shared with the label editor, which builds chips as DOM. */
export const FILE_DOC_PATHS = [
  "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
  "M14 2v4a2 2 0 0 0 2 2h4",
] as const;

/**
 * What a reference chip points at today: a page. Each referent kind carries its
 * own glyph, so a chip can say what it is before you follow it — a ticket, a
 * file, whatever the integrations bring — without the text having to.
 */
export function FileDoc(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      {FILE_DOC_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The sidebar tree's container, shared by its rows and its "new" button. */
const FOLDER_PATH =
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";

export function Folder(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d={FOLDER_PATH} />
    </svg>
  );
}

export function FolderPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d={FOLDER_PATH} />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

export function Code(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  );
}

export function Search(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}

export function Paperclip(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5" />
    </svg>
  );
}

export function X(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function RotateCcw(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

export function MediaPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="M8 12h8" />
      <path d="M12 8v8" />
    </svg>
  );
}

export function Columns(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </svg>
  );
}

export function Minus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M5 12h14" />
    </svg>
  );
}

export function Shuffle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.8-1.1 2-1.7 3.3-1.7H22" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
      <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
      <path d="m18 14 4 4-4 4" />
    </svg>
  );
}

export function Crop(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  );
}

export function Scissors(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12" />
      <path d="M20 4 8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8 20 20" />
    </svg>
  );
}

export function Car(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M5 17h14M5 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm14 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z" />
      <path d="M3 17v-4.2a2 2 0 0 1 .2-.9l2.4-4.8A2 2 0 0 1 7.4 6h9.2a2 2 0 0 1 1.8 1.1l2.4 4.8a2 2 0 0 1 .2.9V17" />
      <path d="M3.5 12h17" />
    </svg>
  );
}

export function Play(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M6 4.5a1 1 0 0 1 1.5-.87l13 7.5a1 1 0 0 1 0 1.74l-13 7.5A1 1 0 0 1 6 19.5Z" />
    </svg>
  );
}

export function Pause(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 5v14M16 5v14" />
    </svg>
  );
}

export function ChevronsLeftRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m9 7-5 5 5 5" />
      <path d="m15 7 5 5-5 5" />
    </svg>
  );
}

export function ChevronsRightLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m20 17-5-5 5-5" />
      <path d="m4 7 5 5-5 5" />
    </svg>
  );
}

export function Info(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8h.01" />
      <path d="M12 12v4" />
    </svg>
  );
}

export function Bug(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1" />
      <path d="M18 11a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4v3a6 6 0 0 0 12 0Z" />
      <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
    </svg>
  );
}

export function Sparkles(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M11.02 3.55c.3-1.16 1.66-1.16 1.96 0l1.06 4.1a2 2 0 0 0 1.44 1.43l4.1 1.06c1.15.3 1.15 1.66 0 1.96l-4.1 1.06a2 2 0 0 0-1.44 1.44l-1.06 4.1c-.3 1.15-1.66 1.15-1.96 0l-1.06-4.1a2 2 0 0 0-1.44-1.44l-4.1-1.06c-1.15-.3-1.15-1.66 0-1.96l4.1-1.06a2 2 0 0 0 1.44-1.44Z" />
      <path d="M19 3v3M20.5 4.5h-3M5 17v2M6 18H4" />
    </svg>
  );
}

/** The nib's outline, its breather hole and its slit, as one even-odd path.
 *  Shared with the canvas cursor, which must be the same object at 24px. */
export const NIB_PATH =
  "M14 .1 23.9 9.8 20.6 11.5 17.1 18.9 2.6 23.3 .2 20.9 5.4 6.9 13.6 4.3 12.6 3.3Z" +
  "M9.9 11a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 1 0 0-6.2Z" +
  "M7.15 14.9 8.95 16.5 3.15 23.3 1.65 22.3Z";

/**
 * The pen tool, drawn the way Figma and Illustrator draw it: the nib itself,
 * not the pen holding it — the blade, the breather hole, and the slit splitting
 * the tine. Those three marks are what say "nib" rather than "wedge".
 *
 * Filled rather than stroked, unlike every other icon here, because that is what
 * the shape is: an outline version loses the hole and the slit to their own
 * stroke weight long before 17px. The fill is stated AFTER `props` on purpose —
 * callers spread a preset carrying `fill: none`, which would erase it.
 */
export function FountainPen(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props} fill="currentColor" stroke="none">
      <path d={NIB_PATH} fillRule="evenodd" />
    </svg>
  );
}

/**
 * Marks something the model is offering. Filled rather than stroked — at 11px a
 * 2px stroke closes up into a blob, and this needs to read at chip size.
 */
export function Sparkle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} fill="currentColor" stroke="none" {...props}>
      <path d="M12 2.6c.45 4.85 4.1 8.5 8.95 8.95v.9c-4.85.45-8.5 4.1-8.95 8.95h-.9c-.45-4.85-4.1-8.5-8.95-8.95v-.9c4.85-.45 8.5-4.1 8.95-8.95Z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Block glyphs — the slash menu's set.
 *
 * One family, one grid: content sits inside x3–21 / y3.5–20.5, list rows run
 * x11–21 with the leading mark in x3–9, and every framed block (image, media,
 * table, code, math) uses the same 18×16 rx-2.5 frame so a column of them reads
 * flush. Pairs are deliberate — a bare mark is the inline form of the framed
 * one (Equation/MathBlock, InlineCode/CodeBlock).
 * ------------------------------------------------------------------ */

/** The 18×16 card every framed block glyph is drawn inside. */
const BLOCK_FRAME = { x: 3, y: 4, width: 18, height: 16, rx: 2.5 } as const;

export function Paragraph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h16M4 12h16M4 18h9" />
    </svg>
  );
}

/** The H the three heading levels share; only the numeral beside it changes. */
const HEADING_H = "M4 12h8M4 18V6M12 18V6";

export function Heading1(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d={HEADING_H} />
      <path d="m17 12 3-2v8" />
    </svg>
  );
}

export function Heading2(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d={HEADING_H} />
      <path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1" />
    </svg>
  );
}

export function Heading3(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d={HEADING_H} />
      <path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2" />
      <path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2" />
    </svg>
  );
}

/** The block quote as it looks on the page: the rule, then the indented text. */
export function Quote(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5v14" />
      <path d="M9 9h12M9 15h7" />
    </svg>
  );
}

export function BulletList(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
      <path d="M11 6h10M11 12h10M11 18h10" />
    </svg>
  );
}

/**
 * Two rows, not three. A drawn numeral needs roughly six units of height to
 * keep its counter open at 16px, and three of those don't fit down the box —
 * so the icons whose leading mark is a *glyph* (this, TodoList) run two rows on
 * the same y8/y16.5 rhythm, while the ones led by a dot or a caret run three.
 */
export function NumberedList(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4.5 5h1.2v6M4.1 11h3.2" />
      <path d="M7.4 19.5H4c0-1.3 3-2.3 3-4.2a1.7 1.7 0 0 0-3-1.2" />
      <path d="M11 8h10M11 16.5h10" />
    </svg>
  );
}

/** One box still to tick, one already ticked — the check sits outside the box
 *  on purpose; inside it there is no counter left at 16px. */
export function TodoList(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="5" width="6" height="6" rx="1.5" />
      <path d="m3.2 16.4 2.1 2.1 4-4.2" />
      <path d="M11 8h10M11 16.5h10" />
    </svg>
  );
}

/** Closed disclosure, with the one line it would reveal indented beneath. */
export function ToggleList(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m4.5 6 3 3-3 3" />
      <path d="M11 9h10" />
      <path d="M14 17.5h7" />
    </svg>
  );
}

export function Table(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect {...BLOCK_FRAME} />
      <path d="M3 9.5h18" />
      <path d="M9 9.5V20M15 9.5V20" />
    </svg>
  );
}

/** Full-bleed, unlike `Minus`, which is a control's dash rather than a rule. */
export function Divider(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h18" />
    </svg>
  );
}

/** Two nodes and the elbow between them — the canvas block in miniature. */
export function Diagram(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3.5" width="8" height="7" rx="2" />
      <rect x="13" y="13.5" width="8" height="7" rx="2" />
      <path d="M7 10.5v4.5a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

/** Shot frames with the caption lines that sit under them. */
export function Storyboard(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3.5" width="8" height="7" rx="1.5" />
      <rect x="13" y="3.5" width="8" height="7" rx="1.5" />
      <path d="M3 15h8M13 15h8" />
      <path d="M3 19.5h5M13 19.5h5" />
    </svg>
  );
}

/** The waterfall: one tall column beside two short ones. */
export function Album(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3.5" width="8" height="17" rx="2" />
      <rect x="13" y="3.5" width="8" height="7.5" rx="2" />
      <rect x="13" y="13" width="8" height="7.5" rx="2" />
    </svg>
  );
}

export function MediaPlay(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect {...BLOCK_FRAME} />
      <path d="m10 9 5.5 3-5.5 3Z" />
    </svg>
  );
}

/** The service marks, redrawn in this set's stroke rather than dropped in as
 *  brand artwork — a filled logo beside these would read as a foreign object. */
export function Spotify(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M7.2 9c3.2-.9 6.7-.6 9.7.9" />
      <path d="M7.9 12.5c2.6-.7 5.4-.5 7.9.8" />
      <path d="M8.6 15.9c2-.5 4.2-.3 6 .6" />
    </svg>
  );
}

export function AppleMusic(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M10 15.5V8.6l5.5-1.4v6.9" />
      <circle cx="8.4" cy="15.5" r="1.6" />
      <circle cx="13.9" cy="14.1" r="1.6" />
    </svg>
  );
}

export function Location(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M19.2 10.5c0 4.4-4.9 9-6.6 10.4a1 1 0 0 1-1.2 0C9.7 19.5 4.8 14.9 4.8 10.5a7.2 7.2 0 0 1 14.4 0Z" />
      <circle cx="12" cy="10.5" r="2.7" />
    </svg>
  );
}

export function Image(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect {...BLOCK_FRAME} />
      <circle cx="8.5" cy="9.5" r="1.8" />
      <path d="m21 15.5-3.1-3.1a2 2 0 0 0-2.8 0L7 20" />
    </svg>
  );
}

/** `FileDoc`'s sibling on this grid. The chip glyph runs y2–22 to hold its own
 *  beside text; in a menu column that extra height reads as a size mismatch. */
export function FileBlock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M15 3v4a1 1 0 0 0 1 1h4" />
    </svg>
  );
}

export function Emoji(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 10h.01M15 10h.01" />
      <path d="M8.4 14.5a4.6 4.6 0 0 0 7.2 0" />
    </svg>
  );
}

/** The radical, bare: math running inside a sentence. */
export function Equation(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12.5h2.8l3.4 7L14 4.5h7" />
    </svg>
  );
}

/** The same radical, framed: math that owns the line. */
export function MathBlock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect {...BLOCK_FRAME} />
      <path d="M6.5 12h1.7l2.3 4.8L14 8h3.5" />
    </svg>
  );
}

/** Angle brackets around a character — the inline mark, not `Code`, which runs
 *  the full 24 box and outweighs everything beside it in a menu. */
export function InlineCode(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
      <path d="M13.8 7 10.2 17" />
    </svg>
  );
}

export function CodeBlock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect {...BLOCK_FRAME} />
      <path d="m9.5 9.5-2.5 2.5 2.5 2.5" />
      <path d="m14.5 9.5 2.5 2.5-2.5 2.5" />
    </svg>
  );
}
