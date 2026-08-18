"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LinkIcon } from "../../Icons";
import { useReadOnly } from "../readOnly";
import { parseLink } from "./parse";
import { serializeLink } from "./serialize";
import { useLinkShell } from "./shell";
import type { Link } from "./types";
import "./link.css";

/**
 * A link, as a card. Thin wrapper over LinkPreview: holds state as markup
 * in the `data` prop, and the surface is just the card and its editor panel.
 */
export function LinkSurface({
  blockId,
  source,
  onChange,
}: {
  blockId: string;
  source: string;
  onChange: (markup: string) => void;
}) {
  const readOnly = useReadOnly();
  const shell = useLinkShell();
  const [draft, setDraft] = useState("");
  const link = parseLink(source);

  // Pin the onChange callback behind a ref so republishing doesn't loop.
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  const set = useCallback(
    (next: Link) => latest.current(serializeLink(next)),
    [],
  );

  // Claim the panel on pointer or when the block has a URL.
  const mine = shell.active?.blockId === blockId;
  const claim = () => {
    if (!readOnly && link.href) shell.set({ blockId, link, set });
  };

  // Don't show empty input state in read-only mode.
  if (!link.href && readOnly) return null;

  return (
    <div className={`nt-link-card ${mine ? "is-active" : ""}`} onPointerDown={claim}>
      {!link.href ? (
        <div className="nt-link-empty">
          <div className="nt-link-drop">
            <LinkIcon />
            <input
              type="text"
              className="nt-link-input"
              placeholder="Paste a link"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const url = draft.trim();
                if (!url) return;
                try {
                  new URL(url);
                  set({ href: url, title: "", subtitle: "", image: "" });
                  setDraft("");
                } catch {
                  // Invalid URL
                }
              }}
              autoFocus
            />
          </div>
        </div>
      ) : (
        <div className="nt-link-card-content">
          {link.image && (
            <div className="nt-link-card-image">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={link.image} alt="" loading="lazy" />
            </div>
          )}
          <div className="nt-link-card-text">
            <div className="nt-link-card-title">{link.title || extractDomain(link.href)}</div>
            {link.subtitle && (
              <div className="nt-link-card-subtitle">{link.subtitle}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}
