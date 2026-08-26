"use client";

/**
 * A page's or folder's chosen icon, and the one place that decides what each
 * kind looks like.
 *
 * Three sources reach this file — an emoji, one of the app's own drawn glyphs
 * by name, an uploaded picture — and every surface that shows an icon (the
 * sidebar tree, the page header, an `@` chip) renders through {@link RowIcon}
 * so a page looks the same wherever it is named.
 *
 * The fallback is not an error state: a row with no icon, or one naming a glyph
 * this build no longer ships, draws the fixed page/folder mark it always had.
 * That is what makes the feature additive — nothing looks broken or empty
 * before anyone chooses anything.
 */

import { createElement, type SVGProps } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Album,
  Bolt,
  Book,
  Briefcase,
  Bulb,
  Calendar,
  Chart,
  Clock,
  Code,
  Compass,
  Diagram,
  FileDoc,
  Flag,
  Folder,
  Heart,
  Image as ImageGlyph,
  Leaf,
  Location,
  Map as MapGlyph,
  MathBlock,
  Person,
  Rocket,
  Star,
  Storyboard,
  Table,
  Target,
} from "./Icons";

/** The shape stored on a page or folder row. Mirrors `rowIcon` in the schema. */
export type RowIconValue =
  | { kind: "emoji"; value: string }
  | { kind: "icon"; name: string; d?: string; box?: number }
  | { kind: "image"; storageId: Id<"_storage">; url: string };

type Glyph = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;

/**
 * The drawn glyphs offered as page icons, by the name stored on the row.
 *
 * SUBJECTS, not commands. The block glyphs elsewhere in `Icons.tsx` name what a
 * block IS — a heading, a bulleted list, a code fence — and a page wearing one
 * of those reads as a heading rather than as itself. What someone answers when
 * they give a page an icon is what the page is ABOUT, so these are nouns.
 *
 * Three deliberate exclusions: the AI's sparkle, because amber and that mark
 * mean "the model did this" and a page may not claim it; the trash glyph,
 * because it is the Remove button in the very popover that offers it; and the
 * plain page and folder marks, because they are already the default and
 * choosing one would be an invisible no-op.
 *
 * Each carries the words someone would actually search — "photo" finds the
 * picture, "task" finds the target — because the stored slug is a key, not
 * vocabulary. Names are stored rather than components, so this list can grow
 * without a migration.
 */
const ICON_CHOICES: ReadonlyArray<{
  readonly name: string;
  readonly label: string;
  readonly glyph: Glyph;
  readonly keywords: readonly string[];
}> = [
  { name: "rocket", label: "Rocket", glyph: Rocket, keywords: ["launch", "ship", "start", "space"] },
  { name: "star", label: "Star", glyph: Star, keywords: ["favourite", "favorite", "important"] },
  { name: "flag", label: "Flag", glyph: Flag, keywords: ["milestone", "goal", "mark"] },
  { name: "target", label: "Target", glyph: Target, keywords: ["goal", "task", "aim", "objective"] },
  { name: "bolt", label: "Bolt", glyph: Bolt, keywords: ["fast", "energy", "power", "quick"] },
  { name: "bulb", label: "Idea", glyph: Bulb, keywords: ["idea", "thought", "insight", "light"] },
  { name: "heart", label: "Heart", glyph: Heart, keywords: ["love", "like", "care"] },
  { name: "calendar", label: "Calendar", glyph: Calendar, keywords: ["date", "schedule", "plan", "week"] },
  { name: "clock", label: "Clock", glyph: Clock, keywords: ["time", "history", "log", "later"] },
  { name: "book", label: "Book", glyph: Book, keywords: ["notes", "read", "journal", "docs"] },
  { name: "chart", label: "Chart", glyph: Chart, keywords: ["data", "metrics", "graph", "numbers"] },
  { name: "briefcase", label: "Work", glyph: Briefcase, keywords: ["work", "business", "job", "client"] },
  { name: "person", label: "Person", glyph: Person, keywords: ["people", "team", "who", "user"] },
  { name: "map", label: "Map", glyph: MapGlyph, keywords: ["plan", "route", "roadmap", "where"] },
  { name: "compass", label: "Compass", glyph: Compass, keywords: ["direction", "explore", "find"] },
  { name: "location", label: "Place", glyph: Location, keywords: ["place", "pin", "address", "where"] },
  { name: "leaf", label: "Leaf", glyph: Leaf, keywords: ["nature", "growth", "green", "new"] },
  { name: "image", label: "Picture", glyph: ImageGlyph, keywords: ["photo", "picture", "image", "art"] },
  { name: "album", label: "Gallery", glyph: Album, keywords: ["photos", "gallery", "album"] },
  { name: "diagram", label: "Diagram", glyph: Diagram, keywords: ["flow", "system", "architecture"] },
  { name: "storyboard", label: "Storyboard", glyph: Storyboard, keywords: ["shots", "film", "scenes"] },
  { name: "table", label: "Table", glyph: Table, keywords: ["grid", "rows", "spreadsheet"] },
  { name: "code", label: "Code", glyph: Code, keywords: ["code", "dev", "engineering", "api"] },
  { name: "math", label: "Maths", glyph: MathBlock, keywords: ["math", "maths", "formula", "calc"] },
];

const BY_NAME = new Map<string, Glyph>(ICON_CHOICES.map((c) => [c.name, c.glyph]));

/** Whether this build still draws that glyph. */
export function hasIcon(name: string): boolean {
  return BY_NAME.has(name);
}

export function RowIcon({
  icon,
  kind,
  size = 14,
  className,
}: {
  icon: RowIconValue | null | undefined;
  /** What to draw when there is no icon, or the named one is gone. */
  kind: "page" | "folder";
  size?: number;
  className?: string;
}) {
  const cls = className ?? "nt-row-icon";

  if (icon?.kind === "emoji" && icon.value) {
    return (
      <span
        className={`${cls} nt-icon-emoji`}
        style={{ fontSize: size + 2, lineHeight: 1 }}
        aria-hidden
      >
        {icon.value}
      </span>
    );
  }

  if (icon?.kind === "image" && icon.url) {
    return (
      // Not next/image: the source is a Convex bearer URL whose host varies by
      // deployment, and the optimizer would need it whitelisted per deployment.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={icon.url}
        alt=""
        width={size}
        height={size}
        className={`${cls} nt-icon-image`}
        style={{ width: size, height: size }}
      />
    );
  }

  if (icon?.kind === "icon" && icon.d) {
    // Filled outlines from Phosphor Regular: the line IS the shape, so this
    // paints with fill and no stroke, unlike the drawn set below.
    const box = icon.box ?? 256;
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${box} ${box}`}
        fill="currentColor"
        className={cls}
        aria-hidden
      >
        <path d={icon.d} />
      </svg>
    );
  }

  const named = icon?.kind === "icon" ? BY_NAME.get(icon.name) : undefined;
  const draw = named ?? (kind === "folder" ? Folder : FileDoc);
  // `createElement` rather than JSX: which glyph to draw is data, and rendering
  // a component held in a variable reads to the compiler as minting a new
  // component on every render.
  return createElement(draw, { width: size, height: size, className: cls });
}
