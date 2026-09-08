"use client";

import type { NmlBlock } from "@/app/lib/nml/schema";
import { isSafeUrl } from "@/app/lib/nml/validate";
import { CodeSurface } from "../codemirror/CodeSurface";
import { languageLabel } from "../codemirror/languages";
import { Katex } from "../math/katex";
import { CanvasSurface } from "../canvas/render/CanvasSurface";
import { serializeScene } from "../canvas/scene/serialize";
import { AlbumSurface } from "../album/AlbumSurface";
import { serializeAlbum } from "../album/serialize";
import { StoryboardSurface } from "../storyboard/StoryboardSurface";
import { serializeStoryboard } from "../storyboard/serialize";
import { LocationSurface } from "../location/LocationSurface";
import { serializeLocation } from "../location/serialize";
import { MediaSurface } from "../media/MediaSurface";
import "../editor.css";
import "../canvas/canvas.css";

const noChange = () => {};

export default function ReadOnlyDomainContent({ block, resolveStorageUrl }: {
  block: NmlBlock;
  resolveStorageUrl?: (storageId: string) => string | undefined;
}) {
  switch (block.type) {
    case "codeBlock": return <div className="nt-code"><div className="nt-code-topbar"><span className="nt-code-lang-label">{languageLabel(block.props.language)}</span></div><CodeSurface initialValue={block.code} language={block.props.language} onChange={noChange} readOnly /></div>;
    case "mathBlock": return <div className="nt-mathblock">{block.rows.map((row) => <div key={row.id} data-nml-id={row.id} className="nt-mathblock-row"><Katex latex={row.latex} /></div>)}</div>;
    case "canvas": return <CanvasSurface source={serializeScene(block.scene)} onChange={noChange} readOnly />;
    case "album": return <AlbumSurface source={serializeAlbum(block.domain)} onChange={noChange} />;
    case "storyboard": return <StoryboardSurface blockId={block.id} source={serializeStoryboard(block.domain)} onChange={noChange} readOnly />;
    case "location": return <LocationSurface blockId={block.id} source={serializeLocation(block.domain)} onChange={noChange} />;
    case "image":
    case "video":
    case "audio":
    case "file": {
      const source = block.props.source;
      const candidate = source?.kind === "url" ? source.url : source ? resolveStorageUrl?.(source.storageId) : undefined;
      const url = candidate && isSafeUrl(candidate) ? candidate : undefined;
      if (source && !url) return <span role="note">This {block.type} is preserved; its media is unavailable.</span>;
      if (block.type === "video" || block.type === "audio") return <MediaSurface blockId={block.id} url={url ?? ""} title={block.props.caption || block.props.name || ""} fallbackKind={block.type} onSet={noChange} />;
      if (!url) return null;
      if (block.type === "file") return <a href={url} rel="noopener noreferrer" target="_blank">{block.props.name || block.props.caption || "File"}</a>;
      // eslint-disable-next-line @next/next/no-img-element -- Storage/media URLs are resolved by the authorized host.
      return <figure><img src={url} alt={block.props.caption ?? ""} style={{ maxWidth: "100%" }} />{block.props.caption && <figcaption>{block.props.caption}</figcaption>}</figure>;
    }
    default: return null;
  }
}
