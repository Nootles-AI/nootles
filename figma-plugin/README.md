# Copy for Nootles — Figma plugin

Select layers in Figma or FigJam, press **Copy**, paste onto a Nootles canvas.

The plugin converts the selection into the canvas's own `<nt-diagram>` markup and
puts that text on the clipboard. The canvas's paste handler already accepts it, so
nothing on the Nootles side changes for a paste to work. The converter is a pure
function over Figma's node shapes (`src/convert.ts`), and the markup is written by
the same serializer the app uses, so what lands is byte for byte what a hand would
have drawn.

## Running it

From the repository root:

```
npm run figma:build
```

Then in the Figma desktop app: **Plugins → Development → Import plugin from
manifest…** and choose `figma-plugin/manifest.json`. The plugin appears under
Development in the plugins menu, in both Figma Design and FigJam. Rebuild after
changes; Figma reloads the bundle on the next run.

The plugin asks for no network access. Image fills are read through the Plugin
API and travel inside the markup as data URIs; the canvas moves them into
storage the moment they land and keeps the URL, so the document never carries
the bytes.

## What is carried

Frames, groups and sections (as groups, with auto layout as flex), rectangles,
ellipses with arcs, polygons, stars, vectors, lines and boolean results (as
paths), text with per-range styling, paragraphs and lists, image fills, solid and
gradient fills including diamond, strokes with position and dashes, corner radii,
shadows and blurs, opacity and blend modes, FigJam shapes, stickies and
connectors. Every node keeps its Figma id as `data-figma-id`.

Anything the canvas has no place for yet becomes a dashed placeholder that names
what it was, and every loss is listed under the Copy button after a copy. The
[parity plan](../docs/figma-parity-plan.md) is the list of what closes those gaps.

## Publishing

The version lives in `src/version.ts` and is shown in the window's header; bump it, run
`npm run figma:build`, then upload `dist/` through Figma's publish dialog with the assets
below. The manifest carries no version field of its own.

The window is Figma's own: it wears the `--figma-color-*` theme tokens and follows the
light and dark themes, with Nootles present only as its mark. Enter copies, Escape
closes. Everything the UI needs is inlined in `src/ui.html`; the plugin loads nothing
over the network.

Listing assets for the Community page are in `assets/`, rendered from the brand paths
in `app/components/Brand.tsx`:

- `icon.png` — 128×128, the mark on the brand green.
- `cover.png` — 1920×960, the wordmark and the one-line description.

Suggested listing copy:

> **Copy for Nootles.** Select layers in Figma or FigJam, press Copy, and paste an
> editable diagram onto a Nootles canvas. Frames and auto layout, text with its
> styling, vectors, booleans, images and connectors all come across as native canvas
> shapes, not a picture. No network access; nothing leaves your file but the clipboard.
