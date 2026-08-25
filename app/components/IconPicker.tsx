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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ICON_CHOICES, RowIcon, type RowIconValue } from "./rowIcon";
import { Search, Trash, X } from "./Icons";
import "./iconPicker.css";

type Tab = "emoji" | "icons" | "upload";

type EmojiEntry = { id: string; native: string; name: string; keywords: string[] };

/** What the picker accepts. Anything a browser can draw at 20px. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * emoji-mart ships its data as a map of ids to entries whose skins carry the
 * character. Flattened once per session into the shape the grid reads.
 */
let emojiCache: EmojiEntry[] | null = null;
async function loadEmoji(): Promise<EmojiEntry[]> {
  if (emojiCache) return emojiCache;
  const mod = await import("@emoji-mart/data");
  const data = ("default" in mod ? mod.default : mod) as {
    emojis: Record<
      string,
      { id: string; name: string; keywords?: string[]; skins: { native: string }[] }
    >;
  };
  emojiCache = Object.values(data.emojis)
    .map((e) => ({
      id: e.id,
      native: e.skins?.[0]?.native ?? "",
      name: e.name,
      keywords: e.keywords ?? [],
    }))
    .filter((e) => e.native);
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

  const q = query.trim().toLowerCase();

  const emojiHits = useMemo(() => {
    if (!emoji) return [];
    if (!q) return emoji.slice(0, 240);
    return emoji
      .filter((e) => e.id.includes(q) || e.name.toLowerCase().includes(q) ||
        e.keywords.some((k) => k.includes(q)))
      .slice(0, 240);
  }, [emoji, q]);

  const iconHits = useMemo(
    () => (q ? ICON_CHOICES.filter(([name]) => name.includes(q)) : ICON_CHOICES),
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
              aria-selected={tab === t}
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
          />
        </div>
      )}

      {tab === "emoji" && (
        <div className="nt-iconpicker-body">
          {loadFailed ? (
            <p className="nt-iconpicker-note">Emoji could not load.</p>
          ) : !emoji ? (
            <p className="nt-iconpicker-note">Loading emoji…</p>
          ) : emojiHits.length === 0 ? (
            <p className="nt-iconpicker-note">No emoji match “{query.trim()}”.</p>
          ) : (
            <div className="nt-iconpicker-grid">
              {emojiHits.map((e) => (
                <button
                  key={e.id}
                  className="nt-iconpicker-cell"
                  title={e.name}
                  onClick={() => onPick({ kind: "emoji", value: e.native })}
                >
                  <span className="nt-iconpicker-emoji">{e.native}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "icons" && (
        <div className="nt-iconpicker-body">
          {iconHits.length === 0 ? (
            <p className="nt-iconpicker-note">No icons match “{query.trim()}”.</p>
          ) : (
            <div className="nt-iconpicker-grid">
              {iconHits.map(([name]) => (
                <button
                  key={name}
                  className="nt-iconpicker-cell"
                  title={name}
                  onClick={() => onPick({ kind: "icon", name })}
                >
                  <RowIcon
                    icon={{ kind: "icon", name }}
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
        <div className="nt-iconpicker-body nt-iconpicker-upload">
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
