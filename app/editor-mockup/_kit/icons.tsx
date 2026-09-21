import type { ReactNode, SVGProps } from "react";
import * as App from "@/app/components/Icons";

export { Brandmark } from "@/app/components/Brand";
export {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileDoc,
  Folder,
  FolderPlus,
  LinkIcon,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkle,
  Trash,
  X,
  Diagram,
} from "@/app/components/Icons";
// The panel's own glyphs and the toolbar's own tools: one drawing of each,
// however many mockups carry it.
export {
  Align,
  AspectLock,
  Corner,
  Eye,
  FontSize,
  LetterSpacing,
  LineHeight,
  Rotation,
  StrokeWeight,
} from "@/app/components/editor/canvas/panels/controls/glyphs";
export { Glyph, PADLOCK } from "@/app/components/editor/canvas/panels/layerGlyph";

type Props = SVGProps<SVGSVGElement>;

/** Slash-menu icons are named in the data, so the menu stays a list. */
export function BlockIcon({ name, ...props }: Props & { name: string }) {
  const Icon = (App as unknown as Record<string, (p: Props) => ReactNode>)[name] ?? App.Paragraph;
  return <Icon width={16} height={16} {...props} />;
}

const stroke = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const line = (d: string) =>
  function Icon(props: Props) {
    return (
      <svg {...stroke} {...props}>
        <path d={d} />
      </svg>
    );
  };

export const Undo = line("M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3");
export const Redo = line("m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3");
export const Expand = line("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5");
export const Shrink = line("M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5");
export const ArrowUp = line("M12 19V5M6 11l6-6 6 6");
export const Bold = line("M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z");
export const ItalicMark = line("M10 5h8M6 19h8M14 5l-4 14");
export const Underline = line("M7 5v6a5 5 0 0 0 10 0V5M5 20h14");
export const Strike = line("M4 12h16M16 7a4 4 0 0 0-4-2c-2.5 0-4 1.3-4 3 0 1 .5 1.8 1.4 2.4M8 17a4 4 0 0 0 4 2c2.5 0 4-1.3 4-3");
export const CodeMark = line("m8 8-4 4 4 4M16 8l4 4-4 4");
export const At = line("M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1");
export const Copy = line("M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM16 5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h1");
export const Duplicate = line("M8 8h12v12H8zM4 16V4h12");
export const Globe = line("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.500 5.600 12 3Z");
export const Keyboard = line("M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8");
export const Context = line("M4 5h16M4 10h10M4 15h16M4 20h7");
export const Layers = line("m12 3 9 5-9 5-9-5zM3 13l9 5 9-5");
export const Sliders = line("M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4");
export const Chat = line("M4 5h16v11H9l-5 4z");
export const Home = line("M4 11 12 4l8 7v9h-5v-6H9v6H4z");
export const ChevronDown = line("m6 9 6 6 6-6");
export const Rewind = line("M11 6 5 12l6 6M5 12h9a5 5 0 0 1 0 10");

export function Grip(props: Props) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      {[6, 12, 18].flatMap((y) => [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.5} />))}
    </svg>
  );
}

export function Lock({ open, ...props }: Props & { open?: boolean }) {
  return (
    <svg {...stroke} {...props}>
      <path d="M6 10h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
      <path d={open ? "M8 10V7a4 4 0 0 1 7.5-2" : "M8 10V7a4 4 0 0 1 8 0v3"} />
    </svg>
  );
}
