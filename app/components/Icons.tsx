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

export function Code(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
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
