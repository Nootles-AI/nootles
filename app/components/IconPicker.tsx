"use client";

/**
 * Choosing a page's or folder's icon: an emoji, one of the app's own glyphs, or
 * a picture you upload.
 *
 * Three sources behind one search box rather than three separate controls,
 * because the question a person arrives with is "what should this page look
 * like", not "which library should I browse". The tabs order themselves by how
 * often that question is answered each way.
 *
 * The emoji set is loaded on demand. `@emoji-mart/data` is already in the tree
 * (BlockNote's own ":" picker depends on it) and is a megabyte of JSON, so it
 * is imported when the tab is first opened and never from the shell.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ICON_CHOICES, RowIcon, type RowIconValue } from "./rowIcon";
import { Search, Trash, X } from "./Icons";
import "./iconPicker.css";

type Tab = "emoji" | "icons" | "upload";

type EmojiEntry = {
  id: string;
  native: string;
  name: string;
  keywords: string[];
  group: string;
};

/** What the picker accepts. Anything a browser can draw at 20px. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * emoji-mart ships its data as a map of ids to entries whose skins carry the
 * character. Flattened once per session into the shape the grid reads.
 */
/** emoji-mart's category ids, in the product's own words. */
const GROUP_LABELS: Record<string, string> = {
  frequent: "Frequent",
  people: "Smileys & people",
  nature: "Animals & nature",
  foods: "Food & drink",
  activity: "Activity",
  places: "Travel & places",
  objects: "Objects",
  symbols: "Symbols",
  flags: "Flags",
};

let emojiCache: EmojiEntry[] | null = null;
async function loadEmoji(): Promise<EmojiEntry[]> {
  if (emojiCache) return emojiCache;
  const mod = await import("@emoji-mart/data");
  const data = ("default" in mod ? mod.default : mod) as {
    categories: { id: string; emojis: string[] }[];
    emojis: Record<
      string,
      { id: string; name: string; keywords?: string[]; skins: { native: string }[] }
    >;
  };
  // Walked in CATEGORY order rather than key order. Raw key order puts every
  // face first, which filled the whole panel with expressions and left objects
  // and symbols unreachable without typing.
  const seen = new Set<string>();
  const out: EmojiEntry[] = [];
  for (const category of data.categories ?? []) {
    for (const id of category.emojis ?? []) {
      const e = data.emojis[id];
      const native = e?.skins?.[0]?.native;
      if (!e || !native || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        native,
        name: e.name,
        keywords: e.keywords ?? [],
        group: GROUP_LABELS[category.id] ?? category.id,
      });
    }
  }
  emojiCache = out;
  return emojiCache;
}

export function IconPicker({
  icon,
  kind,
  onPick,
  onClose,
}: {
  icon: RowIconValue | null | undefined;
  kind: "page" | "folder";
  /** `null` clears the icon. */
  onPick: (next: RowIconValue | null) => void;
  onClose: () => void;
}) {
  const convex = useConvex();
  const [tab, setTab] = useState<Tab>("emoji");
  const [query, setQuery] = useState("");
  const [emoji, setEmoji] = useState<EmojiEntry[] | null>(emojiCache);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  // Escape closes, and a press outside is a decision not to choose.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (!root.current?.contains(e.target)) onClose();
    };
    window.addEventListener("keydown", key, true);
    // Deferred a tick: the press that opened this would otherwise close it.
    const armed = setTimeout(() => window.addEventListener("pointerdown", away), 0);
    return () => {
      clearTimeout(armed);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", away);
    };
  }, [onClose]);

  useEffect(() => {
    if (tab !== "emoji" || emoji) return;
    let live = true;
    loadEmoji().then(
      (all) => live && setEmoji(all),
      () => live && setLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, [tab, emoji]);

  /**
   * Arrow keys walk the grid. Without this the only way through is Tab, and a
   * grid of a thousand emoji is a thousand stops before anything else on the
   * page.
   */
  const roam = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!e.key.startsWith("Arrow")) return;
    const cells = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>(".nt-iconpicker-cell") ?? []),
    ];
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    // One row's worth, measured rather than assumed: the grid is auto-fill and
    // the count changes with the popover's width.
    const top = cells[0].offsetTop;
    const perRow = Math.max(1, cells.findIndex((c) => c.offsetTop > top));
    const step =
      e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? perRow : -perRow;
    const next = cells[at + step];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const q = query.trim().toLowerCase();

  const emojiHits = useMemo(() => {
    if (!emoji) return [];
    if (!q) return emoji;
    return emoji.filter(
      (e) =>
        e.id.includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.keywords.some((k) => k.includes(q)),
    );
  }, [emoji, q]);

  const iconHits = useMemo(
    () =>
      q
        ? ICON_CHOICES.filter(
            (c) =>
              c.name.includes(q) ||
              c.label.toLowerCase().includes(q) ||
              c.keywords.some((k) => k.includes(q)),
          )
        : ICON_CHOICES,
    [q],
  );

  const upload = useCallback(
    async (file: File) => {
      setUploadError(null);
      if (!IMAGE_TYPES.includes(file.type)) {
        setUploadError("PNG, JPEG, WebP, GIF or SVG.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setUploadError("Under 2 MB, please — it is drawn at 20 pixels.");
        return;
      }
      setUploading(true);
      try {
        const postUrl = await convex.mutation(api.albums.generateUploadUrl, {});
        const res = await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!res.ok) throw new Error(String(res.status));
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        const url = await convex.query(api.albums.url, { storageId });
        if (!url) throw new Error("no url");
        onPick({ kind: "image", storageId, url });
      } catch {
        setUploadError("That did not upload. Try again?");
      } finally {
        setUploading(false);
      }
    },
    [convex, onPick],
  );

  return (
    <div className="nt-menu nt-iconpicker" ref={root} role="dialog" aria-label="Choose an icon">
      <div className="nt-iconpicker-head">
        <div className="nt-iconpicker-tabs" role="tablist">
          {(["emoji", "icons", "upload"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              id={`nt-icontab-${t}`}
              aria-selected={tab === t}
              aria-controls="nt-iconpanel"
              className="nt-iconpicker-tab"
              data-active={tab === t || undefined}
              onClick={() => setTab(t)}
            >
              {t === "emoji" ? "Emoji" : t === "icons" ? "Icons" : "Upload"}
            </button>
          ))}
        </div>
        {icon && (
          <button
            className="nt-iconpicker-remove"
            onClick={() => onPick(null)}
            title="Remove icon"
          >
            <Trash width={13} height={13} />
            Remove
          </button>
        )}
        <button className="nt-iconpicker-close" onClick={onClose} aria-label="Close">
          <X width={14} height={14} />
        </button>
      </div>

      {tab !== "upload" && (
        <div className="nt-iconpicker-search">
          <Search width={14} height={14} aria-hidden />
          <input
            ref={field}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "emoji" ? "Search emoji" : "Search icons"}
            aria-label={tab === "emoji" ? "Search emoji" : "Search icons"}
            onKeyDown={(e) => {
              // Typing a name and pressing Enter should take the obvious hit,
              // rather than making you Tab into the grid to reach it.
              if (e.key === "Enter") {
                e.preventDefault();
                root.current?.querySelector<HTMLButtonElement>(".nt-iconpicker-cell")?.click();
                return;
              }
              if (e.key !== "ArrowDown") return;
              e.preventDefault();
              root.current?.querySelector<HTMLButtonElement>(".nt-iconpicker-cell")?.focus();
            }}
          />
        </div>
      )}

      {tab === "emoji" && (
        <div
          id="nt-iconpanel"
          role="tabpanel"
          aria-labelledby={`nt-icontab-${tab}`}
          className="nt-iconpicker-body"
          data-filtered={q || undefined}
          onKeyDown={roam}
        >
          {loadFailed ? (
            <p className="nt-iconpicker-note">Emoji could not load.</p>
          ) : !emoji ? (
            <p className="nt-iconpicker-note">Loading emoji…</p>
          ) : emojiHits.length === 0 ? (
            <p className="nt-iconpicker-note">No emoji match “{query.trim()}”.</p>
          ) : (
            <div className="nt-iconpicker-groups">
              {emojiHits.map((e, i) => (
                <Fragment key={e.id}>
                  {/* A section opens where the category changes. Suppressed
                      while searching: hits are ranked by the query, not by
                      where they happen to live. */}
                  {!q && e.group !== emojiHits[i - 1]?.group && (
                    <p className="nt-iconpicker-group">{e.group}</p>
                  )}
                  <button
                    className="nt-iconpicker-cell"
                    title={e.name}
                    aria-label={e.name}
                    data-current={
                      icon?.kind === "emoji" && icon.value === e.native ? "" : undefined
                    }
                    onClick={() => onPick({ kind: "emoji", value: e.native })}
                  >
                    <span className="nt-iconpicker-emoji">{e.native}</span>
                  </button>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "icons" && (
        <div
          id="nt-iconpanel"
          role="tabpanel"
          aria-labelledby={`nt-icontab-${tab}`}
          className="nt-iconpicker-body"
          data-filtered={q || undefined}
          onKeyDown={roam}
        >
          {iconHits.length === 0 ? (
            <p className="nt-iconpicker-note">No icons match “{query.trim()}”.</p>
          ) : (
            <div className="nt-iconpicker-grid">
              {iconHits.map((choice) => (
                <button
                  key={choice.name}
                  className="nt-iconpicker-cell"
                  title={choice.label}
                  aria-label={choice.label}
                  data-current={
                    icon?.kind === "icon" && icon.name === choice.name ? "" : undefined
                  }
                  onClick={() => onPick({ kind: "icon", name: choice.name })}
                >
                  <RowIcon
                    icon={{ kind: "icon", name: choice.name }}
                    kind={kind}
                    size={18}
                    className="nt-iconpicker-glyph"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "upload" && (
        <div
          id="nt-iconpanel"
          role="tabpanel"
          aria-labelledby="nt-icontab-upload"
          className="nt-iconpicker-body nt-iconpicker-upload"
        >
          <label className="nt-iconpicker-drop">
            <input
              type="file"
              accept={IMAGE_TYPES.join(",")}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }}
            />
            <span>{uploading ? "Uploading…" : "Choose a picture"}</span>
            <span className="nt-iconpicker-hint">PNG, JPEG, WebP, GIF or SVG, under 2 MB</span>
          </label>
          {uploadError && <p className="nt-iconpicker-error">{uploadError}</p>}
        </div>
      )}
    </div>
  );
}
