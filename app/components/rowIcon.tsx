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
  Bug,
  Car,
  Check,
  Code,
  Columns,
  FileDoc,
  Folder,
  FolderPlus,
  Info,
  LinkIcon,
  MediaPlus,
  Paperclip,
  Play,
  Search,
  Settings,
  Shuffle,
  Sparkle,
  Sparkles,
  Table,
  Trash,
  Diagram,
  Storyboard,
  Album,
  Location,
  Image as ImageGlyph,
  Quote,
  TodoList,
  NumberedList,
  BulletList,
  MathBlock,
  CodeBlock,
  Heading1,
} from "./Icons";

/** The shape stored on a page or folder row. Mirrors `rowIcon` in the schema. */
export type RowIconValue =
  | { kind: "emoji"; value: string }
  | { kind: "icon"; name: string }
  | { kind: "image"; storageId: Id<"_storage">; url: string };

type Glyph = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;

/**
 * The drawn glyphs offered as page icons, by the name stored on the row.
 *
 * A curated subset rather than everything `Icons.tsx` exports: the module also
 * holds chrome that means something specific in this product — the brand mark,
 * the panel toggles, the AI's sparkle — and a page wearing one of those would
 * be claiming something it is not. Names are stored, not components, so this
 * list can grow without a migration.
 */
export const ICON_CHOICES: ReadonlyArray<readonly [string, Glyph]> = [
  ["doc", FileDoc],
  ["folder", Folder],
  ["folder-plus", FolderPlus],
  ["heading", Heading1],
  ["quote", Quote],
  ["todo", TodoList],
  ["numbered", NumberedList],
  ["bullets", BulletList],
  ["table", Table],
  ["diagram", Diagram],
  ["storyboard", Storyboard],
  ["album", Album],
  ["image", ImageGlyph],
  ["media", MediaPlus],
  ["play", Play],
  ["location", Location],
  ["code", Code],
  ["code-block", CodeBlock],
  ["math", MathBlock],
  ["columns", Columns],
  ["search", Search],
  ["link", LinkIcon],
  ["paperclip", Paperclip],
  ["settings", Settings],
  ["info", Info],
  ["bug", Bug],
  ["check", Check],
  ["shuffle", Shuffle],
  ["car", Car],
  ["trash", Trash],
  ["sparkle", Sparkle],
  ["sparkles", Sparkles],
];

const BY_NAME = new Map<string, Glyph>(ICON_CHOICES);

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

  const named = icon?.kind === "icon" ? BY_NAME.get(icon.name) : undefined;
  const draw = named ?? (kind === "folder" ? Folder : FileDoc);
  // `createElement` rather than JSX: which glyph to draw is data, and rendering
  // a component held in a variable reads to the compiler as minting a new
  // component on every render.
  return createElement(draw, { width: size, height: size, className: cls });
}
