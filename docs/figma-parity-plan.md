# Figma parity plan for the canvas

Status: proposed. Nothing here is built.

The goal is a canvas that can hold everything a Figma paste carries, so the Figma →
Nootles translation layer is a compiler and not a compromise. "Everything" is measured
against what the Figma Plugin API exposes on a node, because that is exactly what the
plugin will hand us. One thing is allowed to stay missing by decision: the **glass**
effect. Everything else Figma can put on a layer must have a place in the grammar, a
faithful render, and a control in the panel.

## The one rule: native inline CSS is the spelling

The canvas grammar is HTML elements carrying inline `style`. That is not a convenience,
it is the product bet: the AI reads and writes diagrams in a language a browser already
speaks, and a human reading the markup needs no glossary. So every property this plan
adds is spelled as the CSS a browser would accept for it, on the element it belongs to.

- **Spelling is native; technique is free.** The renderer may realise a declaration any
  way it must — the canvas already turns `background` on a polygon into a clipped box —
  but the document never learns about the technique. No custom `--properties` standing
  in for real CSS, no manifests, no `<defs>` blocks, no side registries.
- **Attributes for geometry and relationships; CSS for looks.** `x`, `y`, `from`, `to`
  have always been attributes: where a thing is and what it is joined to are not
  appearance. `sides`, `points`, `d`, `op`, `constraints` follow them. Nothing that is a
  look goes in an attribute, and nothing that is a relationship is smuggled into CSS.
- **When native CSS has no exact form, the plan says so** in one list at the end, and the
  choice between an approximation and a non-native spelling is made there, out loud, not
  row by row.

Three levels of parity, and every row below is held to all three:

- **Model.** The property has a native spelling in `<nt-diagram>`.
  `serialize(parse(html)) === html` stays exact.
- **Render.** The result matches Figma's PNG export within a tolerance, at 1x and 2x.
- **Edit.** The property is visible and editable in the style panel. A property that can
  be pasted but not touched is a trap, and the AI would inherit it.

Measured against the canvas on `main` as of 2026-09-07 (`app/components/editor/canvas`).

## What already matches

Worth stating so the plan is about the gaps, not the whole surface.

- Node kinds: rectangle, ellipse with arc and ring (`start`, `sweep`, `inner` map
  Figma's pie controls exactly), regular polygon, text, image, vector path with cubic
  and quadratic curves and multiple subpaths, group.
- Position, size, rotation, lock, hide, z-order, groups nested to any depth.
- Fills as a `background` stack: solid, linear and radial gradients, image with fill and
  fit, multiple layers, per-layer position, size and repeat.
- Strokes: colour, width, solid/dashed/dotted, inside/centre/outside position, line caps
  on paths.
- Corner radius, per corner.
- Effects as stacks: drop shadow, inner shadow, layer blur, background blur, several of
  each, with spread and colour.
- Opacity, blend modes, brightness/contrast/saturation/grayscale adjustments.
- Auto layout: row, column, grid, gap, per-side padding, align, justify, hug via
  `fit-content`, per-child stretch.
- Colour variables as custom properties on the diagram, referenced by `var()`. (The one
  sanctioned custom property, because CSS variables *are* the native spelling of a
  variable.)
- Connectors with elbow routing, an end arrow, a label, dash and width.
- Text: size, weight, family from a short list, line height, letter spacing, horizontal
  and vertical alignment, case, underline and strikethrough, bold runs, page-reference
  chips.

## The gaps, by phase

Ordered by how much pasted content each phase unblocks. Sizes are rough and relative.

### Phase 1 — Text

The largest gap and the one every paste hits: nearly every Figma frame carries text, and
Figma text is styled per character range.

| Figma | Native spelling | Render | Edit | Size |
|---|---|---|---|---|
| Styled ranges: weight, italic, size, colour, family, decoration, link | The label grammar (`scene/label.ts`) grows from `<b>` and `<nt-ref>` to the inline subset the AST doc already reserves for canvas text: `<b> <i> <u> <s> <a href>` and `<span style="font-size… color… font-family…">`. Plain HTML, nothing invented | Runs render as the inline elements they are | Selection-scoped typography: the panel edits the selected range while the label is open, the whole node otherwise | L |
| Italic | `font-style: italic` | passes through | Add to Typography | S |
| Auto width / auto height / fixed | `width: max-content` for auto width, `height: auto` for auto height, nothing for fixed. The `w`/`h` attributes keep holding the *measured* box, exactly as `x`/`y` hold the computed position of an auto-layout child today, so hit-testing and the AI never need a DOM | Browser sizes the text; a measurement service writes the result back into `w`/`h` | Three-state toggle beside the size fields | M |
| Paragraph spacing, indent, lists | Paragraphs as `<p style="margin-bottom: 8px">` runs; `text-indent`; `<ul>`/`<ol>` with `list-style` | native | Typography fields | M |
| Truncation with max lines | `-webkit-line-clamp: 3; overflow: hidden` | native | Field | S |
| Any font family | `font-family: "Inter", sans-serif`, verbatim. No manifest: the loader scans the scene's `font-family` values and resolves each family by name (Google Fonts first, then the user's own faces), loading through `document.fonts` before first paint, metric-compatible fallback while it loads | Font loader | Family field becomes a search over known families plus "any name" | M |
| Variable weights 100–900 | numeric `font-weight` | native | Weight field accepts any hundred | S |
| Text on vectors, vertical trim, OpenType features | out of scope for rendering parity; the plugin flattens text-on-path to a path | | | — |

**Gate:** a Figma frame of mixed-style paragraphs in three families exports and pastes
pixel-equivalent at 1x, and every run is editable in place.

### Phase 2 — Fills and strokes

| Figma | Native spelling | Render | Edit | Size |
|---|---|---|---|---|
| Angular gradient | `conic-gradient(from 90deg at 50% 50%, …)` | native on boxes; SVG kinds already take CSS paints through the clipped box | Gradient field gains the kind | S |
| Diamond gradient | Exactly four `linear-gradient` layers, one per quadrant, each `50% 50%` and positioned at its corner, at 45°/135°/225°/315°. A diamond gradient's iso-lines are 45° lines in each quadrant, so this is not an approximation, it is the same picture in native CSS | native | Gradient field gains the kind; the panel writes and reads the four-layer form as one gradient | M |
| Gradient handles: offset and scale | `background-size` and `background-position` on the gradient layer, which the grammar already carries — a gradient scaled to `200% 100%` and positioned is exactly an offset, stretched gradient | native | Handles on the canvas | M |
| Gradient handles: shear | No native form. See *Where native CSS has no exact form* | | | — |
| Per-fill opacity and blend | colour alpha for opacity; `background-blend-mode` per layer | native | Layer row gains opacity and blend | S |
| Multiple strokes | Boxes: extra strokes as `box-shadow: 0 0 0 Npx colour` layers, which is how the web has always spelled a second border. SVG kinds: the same spelling, realised by the renderer as stacked strokes | technique per kind | Stroke section becomes a stack like Fill | M |
| Per-side stroke weights | `border-top-width` etc. already round-trip | native | Four-field expansion in Stroke | S |
| Stroke join, miter limit, dash cap | `stroke-linejoin`, `stroke-miterlimit`, `stroke-linecap` | native on paths | Fields on Stroke for path kinds | S |
| Custom dash patterns | `stroke-dasharray: 12 4 2 4` on every kind. It is already the spelling on paths; on a box the renderer draws the border through an SVG stroke when a pattern is present | technique for boxes | Dash field accepts a pattern | M |
| Image fill crop and tile | `background-size` and `background-position` in px for crop, `background-repeat: repeat` for tile — all already in the grammar | native | Crop mode with a draggable window; Tile option | M |
| Image adjustments: exposure, contrast, saturation, temperature, tint | `filter` functions: `brightness()`, `contrast()`, `saturate()`, and `sepia()`+`hue-rotate()` composites for temperature and tint | native | Appearance gains the sliders | M |
| Image adjustments: highlights, shadows | No native filter function. See *Where native CSS has no exact form* | | | — |
| Fill rule (even-odd) on vectors | `fill-rule: evenodd`, already passes through | native | Toggle on vector selection | S |

**Gate:** Figma's fill and stroke inspector, every option, round-trips and renders.

### Phase 3 — Effects

| Figma | Native spelling | Render | Edit | Size |
|---|---|---|---|---|
| Drop shadow on non-rectangular shapes | The same `box-shadow` stack. Today the box takes it, so a polygon shadows its rectangle | Renderer realises `box-shadow` on SVG kinds as `filter: drop-shadow()`, one per layer, so the shadow follows the shape | none | M |
| Inner shadow on non-rectangular shapes | `box-shadow: inset …`, same stack | Renderer realises it through an SVG filter it owns; the document keeps the `inset` spelling | none | M |
| Shadows and blur on frames and groups | Same stack on `<nt-group>` | A filled frame is a box and works today; a hugging group with no fill is realised with `filter: drop-shadow` so children cast as one | none | S |
| Noise, texture | `filter: url("data:image/svg+xml,…")` — a native inline `filter` value pointing at an SVG filter carried as a data URI in the declaration itself. No `<defs>`, nothing outside the element | native | Effects list gains both; the panel writes the URI from amount, size and colour | M |
| Effect visibility toggle | Already modelled per layer | — | — | — |
| Glass | **Deferred by decision.** | | | — |

**Gate:** each effect type on each node kind matches Figma's export.

### Phase 4 — Geometry

| Figma | Native spelling | Render | Edit | Size |
|---|---|---|---|---|
| Flip horizontal / vertical | `scale: -1 1` / `scale: 1 -1`, the CSS individual transform property, which composes with the renderer's own `transform` | native | Two buttons in Position | S |
| Corner smoothing (squircle) | `corner-shape: superellipse(k)` — the CSS Borders 4 property, shipping in Chromium since 139. Figma's 0–1 smoothing maps onto the exponent | native where supported; the renderer polyfills with a generated `clip-path` elsewhere | Slider beside radius | M |
| Star | New kind `nt-star` with `points` and `inner` attributes, mirroring `nt-polygon`'s `sides`. Geometry, so an attribute | SVG like polygon | Shape section | S |
| Line node | A two-anchor `nt-path`; nothing new | exists | — | — |
| Line and path end caps: arrow, triangle, reversed, circle, diamond, bar, round, square | `marker-start` / `marker-end` — SVG's own presentation properties — with a fixed vocabulary of ids (`url(#arrow)`, `url(#circle)`, …) the renderer defines once, the way it already defines `#nt-edge-arrow`; `stroke-linecap` for round and square | markers coloured with `context-stroke` | Cap pickers on Stroke for path kinds | M |
| Arc commands in path data | `parsePath` reads M L H V C S Q T Z; add `A` | Arcs become cubics on parse, as the pen tool has no arc anchor | none | S |
| Boolean operations: union, subtract, intersect, exclude | An `nt-group` with `op="union"` holding the operand paths, so the operation stays editable and the result is derived. Geometry, so an attribute; there is no CSS for a boolean | Derived path computed on render | Four buttons on a multi-path selection, plus Flatten | L |
| Vector networks | Out of scope: the plugin flattens to subpaths, which the model already holds | | | — |

**Gate:** Figma's shape tools and vector editor output, pasted, is the same picture and stays editable.

### Phase 5 — Frames, layout and constraints

| Figma | Native spelling | Render | Edit | Size |
|---|---|---|---|---|
| Frame vs group vs section | All `nt-group`. A frame is a group with its own box and paint, which the model already allows; a Figma group hugs, which is `width: fit-content; height: fit-content`. A section is a frame. No new attribute | exists | Layers glyph tells them apart from their style | S |
| Clip content | `overflow: hidden`; groups currently force `overflow: visible` | Honour the declaration when present | Toggle on frames | S |
| Wrap | `flex-wrap: wrap`; `autoLayout.ts` today models one line | Engine models wrapping | Toggle in Layout | M |
| Min and max width/height | `min-width`, `max-width`, `min-height`, `max-height` | Engine reads them | Fields | S |
| Fill / hug / fixed per child | `flex: 1` for fill along the main axis and `align-self: stretch` across it, `fit-content` for hug, px for fixed | Engine reads all three | Per-child sizing pickers | M |
| Absolute-positioned child inside auto layout | `position: absolute` on the child; its authored `x`/`y` stay | Engine skips it in flow | Toggle on the child | S |
| Canvas stacking (first on top) | `order` on children, or the existing `*-reverse` directions | Engine reads `order` | — | S |
| Grid: spans, explicit tracks, per-axis gaps | `grid-template-rows`, `grid-column: span 2`, `row-gap`, `column-gap` — already carried, partly read | Engine reads all | Grid fields | M |
| Constraints | `constraints="left top"` attribute on children of a plain frame, values from Figma's own vocabulary per axis: `left`, `right`, `center`, `scale`, `stretch` / `top`, `bottom`, `center`, `scale`, `stretch`. Omitted when `left top`, the default. A relationship to the parent, not a look, so an attribute beside `x`/`y` rather than `left`/`right` in CSS, which an agent would read as positioning | The `resize` op on a frame re-solves each child from its constraint and its box | Constraint picker, like Figma's | M |
| Stroke included in layout, text baseline alignment | `box-sizing`, and `align-items: baseline` (already in the union) | Engine reads baseline | Toggles | S |

**Gate:** a Figma auto-layout system with nested hug/fill/fixed and wrapping resizes in
Nootles the way it does in Figma.

### Phase 6 — Compositing

| Figma | Native spelling | Render | Edit | Size |
|---|---|---|---|---|
| Masks | Figma's mask is a layer that masks its siblings above. The native spelling is the result, not the mechanism: the masked siblings sit in a group carrying `clip-path: path("…")` for a vector mask, or `mask-image: url("data:…")` with `mask-mode` for an alpha or luminance mask. The masking layer *is* that declaration, so it does not survive as a separate node | native | "Use as mask" on a layer writes the group and the declaration; "Release" reverses it | M |
| Isolate blending | `isolation: isolate` on groups | native | Toggle | S |
| Layer opacity on groups | `opacity` | native | exists | — |

**Gate:** a masked image with a blend-mode overlay matches Figma's export.

### Phase 7 — Connectors (FigJam)

Edges are the one element whose grammar is already attribute-shaped (`from`, `to`),
because a connector has no box and no CSS. The additions stay in that register.

| Figma | Spelling | Render | Edit | Size |
|---|---|---|---|---|
| Straight and curved routing | `route="straight" \| "curved"` on `<nt-edge>`; elbow stays the default and is omitted | `edgePath.ts` grows two routers | Picker | M |
| Start and end caps, all types | `marker-start` / `marker-end` from the Phase 4 vocabulary, in `style` as on paths | Shared markers | Two cap pickers | S |
| Attach anywhere along a side | `from-at="0.25"` / `to-at` — a fraction along the chosen side | Plug point interpolates | Drag the plug along the edge | M |
| Attach to a point on the canvas | `to-x` / `to-y` when `to` is absent | Path ends at the point | Drag off a shape | S |

**Gate:** a FigJam diagram pastes as connectors, not as paths.

## Where native CSS has no exact form

The honest list. Each is a decision to make once, and the recommendation is stated.

| Property | Nearest native | Cost of native | Recommendation |
|---|---|---|---|
| Gradient shear (a handle dragged off-axis) | Rotation, offset and scale all have native spellings; only the residual shear does not | The gradient is decomposed into angle + `background-size` + `background-position`; shear is dropped with a diagnostic. Sheared gradients are rare in practice | Native, with the diagnostic |
| Image highlights and shadows | `contrast()` and `brightness()` composites | Approximate: the two adjust tonal ranges that a linear filter cannot isolate | Native approximation, stated in the paste report. Revisit if it shows up in real pastes |
| Inner shadow on vector shapes | `box-shadow: inset` spelling | None to the document; the renderer needs an SVG filter it owns | Native spelling, renderer technique |
| Corner smoothing outside Chromium | `corner-shape` spelling | None to the document; a `clip-path` polyfill in the renderer | Native spelling, renderer polyfill |
| Boolean operations | none | An `op` attribute on a group | Attribute, as geometry |
| Constraints | `left`/`right`/`top`/`bottom` would work, but on a canvas positioned by `x`/`y` an agent would read them as position | A `constraints` attribute | Attribute, as a relationship |

Everything else in the plan has an exact native spelling.

## The controls

Every property above lands with its control, and every control lands in the panel that
exists: `panels/StylePanel.tsx` already walks Figma's Design tab top to bottom — Position,
Shape, Layout, Typography, Appearance, Fill, Stroke, Effects — with a separate inspector
for a connector. Nothing new is a new panel. The kit it is built from is also fixed:
`NumberField` (scrub, expressions, mixed state), `SelectField`, `IconToggle` (segmented),
`Popover`, `ColorField` with variables, `GradientField`, a slider, and `PanelSection`
with its `+`. Where a phase needs a control the kit lacks, it is listed under *Kit
additions* and built once.

Figma's idioms are the reference, and the ones this panel already speaks are kept:

- **A stack is a list of rows** with `+` in the section head, an eye on each row, and
  removal on hover. Fill and Effects do this today; Stroke joins them.
- **Advanced settings live behind a `…` on the row**, in a popover, never inline. Figma
  puts stroke joins, dash patterns and effect settings there, and so does this plan.
- **Numbers scrub and take expressions.** `120+8` is a value. Mixed selections show
  "Mixed" and a typed value applies to all.
- **Segmented toggles for two to four spatial choices** (alignment, direction, caps), a
  select for longer lists (blend, family), a slider paired with a number for a range
  (opacity, smoothing).
- **The panel is an Operate surface**: neutral, `--nt-select` nowhere, glyphs from the
  canvas icon set in one stroke weight, no accent. A control's state is told by the
  segmented well and the number, not by colour.

### Position

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| W and H each gain a sizing dropdown: **Fixed / Hug / Fill** | Text auto-size (P1), child sizing in auto layout (P5) | The little dropdown inside Figma's W/H fields | Reads `width: max-content` / `fit-content` / `flex: 1`; Fill only offered inside an auto-layout parent, Hug only on text and groups |
| **Flip horizontal / Flip vertical** icon pair beside rotation | P4 | Figma's two flip buttons next to the rotation field | Writes `scale` |
| **Constraints widget**: a small frame drawing with a dotted line per side and a dot at centre; click a side to pin, click centre to centre, a select beneath for Scale | P5 | Figma's constraints box, shown only when the selection sits inside a frame that is not auto-layout | Writes the `constraints` attribute; horizontal and vertical are separate picks |

### Shape

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Points** and **Inner** fields for a star, beside the polygon's Sides | P4 | Figma's star has count and ratio in the shape's own row | Same section, same number fields |
| **Boolean row**: Union, Subtract, Intersect, Exclude as an icon toggle, plus Flatten | P4 | Figma's boolean group in the toolbar dropdown and the Shape section | Shown for a selection of two or more vectors, or a boolean group; the toggle reads the group's `op` |

### Layout

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Wrap** toggle beside the direction toggle | P5 | Figma's wrap icon in the auto-layout row | `flex-wrap` |
| **Min / Max** fields under W and H, revealed by a `…` on the Position row when the node is inside auto layout | P5 | Figma's min/max in the W/H field dropdown | `min-width` etc. |
| **Absolute position** toggle on a child | P5 | Figma's "ignore auto layout" position toggle | `position: absolute` |
| **Stacking order** select: First on top / Last on top | P5 | In Figma's auto-layout `…` settings | `order` or `*-reverse` |
| **Clip content** checkbox | P5 | Figma's clip content, in the auto-layout settings | `overflow: hidden`; shown for every frame, not only auto-layout ones |
| **Grid**: row and column track editors, and on a child, Span fields | P5 | Figma's grid layout controls | `grid-template-*`, `grid-column: span n` |
| **Baseline** in the align picker's row options, and **Include stroke** toggle | P5 | Figma's advanced auto-layout settings | `align-items: baseline`, `box-sizing` |

### Typography

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Family becomes a search combobox** over loaded families, recently used first, accepting any typed name | P1 | Figma's font picker | The loader resolves names it has not seen; a name it cannot resolve shows a fallback glyph beside it |
| **Style** select gains Italic and every hundred weight, from the family's real axes | P1 | Figma's style dropdown lists what the font has | `font-weight` + `font-style` |
| **Resizing** icon toggle: Auto width / Auto height / Fixed | P1 | Figma's three text-resize icons | Mirrors the Position sizing dropdown for text |
| **Paragraph spacing** field beside line height; **Indent** in the `…` | P1 | Figma's paragraph spacing field | `<p>` margins, `text-indent` |
| **`…` type settings popover**: decoration, case, list style, truncation with max lines | P1 | Figma's "Type settings" popover | Decoration and case move here from the section body, where they crowd a 223px column |
| **Range editing**: while a label is open, the whole section applies to the selection inside it | P1 | Figma edits the selected range | The section head shows "Selection" while a range is active |

### Appearance

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Corner smoothing** slider beside the corner-radius field, revealed by the independent-corners toggle's `…` | P4 | Figma's corner smoothing slider in the corner popover | `corner-shape` |
| **Isolate blending** checkbox under blend mode, for groups | P6 | Figma's isolate blending in the blend `…` | `isolation` |
| **Image adjustments** grow: exposure, temperature, tint, highlights, shadows as paired slider-and-number rows in a `…` popover | P2 | Figma's image adjustment panel | `filter` functions; highlights and shadows are marked approximate in the popover's foot, per the gaps list |

### Fill

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Gradient kinds** grow to Linear / Radial / Angular / Diamond in the gradient popover's kind select | P2 | Figma's gradient type dropdown | Diamond reads and writes the four-layer form as one |
| **Gradient handles on the canvas**: two draggable stops on a line, a width handle for radial and diamond | P2 | Figma's on-canvas gradient editor | Writes angle, `background-size`, `background-position`; shear is not offered |
| **Per-layer opacity** field and **blend** select on the fill row | P2 | The opacity field beside every Figma fill; blend in its `…` | colour alpha, `background-blend-mode` |
| **Image mode** select: Fill / Fit / Crop / Tile, and a **Crop** mode on the canvas with a draggable window over the image | P2 | Figma's image fill modes and crop handles | `background-size` / `background-position` / `background-repeat` |
| **Fill rule** toggle on vectors: Non-zero / Even-odd | P2 | Figma's winding rule in the vector's fill `…` | `fill-rule` |

### Stroke

Stroke becomes a stack like Fill, with a `…` per row.

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Stack**: `+` adds a stroke, eye hides it, rows removable | P2 | Figma's multiple strokes | Second and later strokes write `box-shadow: 0 0 0 …` on boxes |
| **Per-side weights**: an independent-sides toggle expanding the width field into four | P2 | Figma's per-side stroke weights | `border-*-width` |
| **`…` advanced popover**: Join (miter / round / bevel), Miter limit, Dash pattern as a dash-gap pair list, Dash cap | P2 | Figma's "Advanced stroke" popover | `stroke-linejoin`, `stroke-miterlimit`, `stroke-dasharray`, `stroke-linecap` |
| **Start and end caps** as two icon selects showing the cap drawn: none, round, square, arrow, triangle, reversed, circle, diamond, bar | P4 | Figma's stroke cap dropdowns, which draw each cap | `marker-start` / `marker-end` / `stroke-linecap`; shown for path kinds and connectors |

### Effects

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Types** grow to Drop shadow / Inner shadow / Layer blur / Background blur / Noise / Texture | P3 | Figma's effect type dropdown | |
| **`…` settings popover per effect**: offset, blur, spread, colour for shadows; amount, size, colour and mode for noise; amount and scale for texture | P3 | Figma's effect settings gear | The popover is the same component for every type, with rows per type |
| No control for glass | — | — | Deferred |

### Layers panel and context menu

Some Figma controls live off the inspector, and this plan keeps them where Figma keeps
them.

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Use as mask / Release mask** in the layer's context menu and the shortcut Figma uses | P6 | Figma's mask command | Writes the clip or mask group; the layers panel shows the masked children indented under a mask glyph |
| **Frame selection / Group selection** in the context menu | P5 | Figma's two commands | Frame writes a group with a box; Group writes a hugging one |
| **Boolean commands** in the context menu, mirroring the Shape row | P4 | Figma's boolean submenu | |
| **Flip** in the context menu, mirroring Position | P4 | | |

### Connector inspector

| Control | For | Figma idiom | Notes |
|---|---|---|---|
| **Route** icon toggle: Elbow / Straight / Curved | P7 | FigJam's connector line-type toggle | `route` |
| **Start and end caps**, the same two icon selects as Stroke | P7 | FigJam's connector end dropdowns | |
| **Plug drag on the canvas** along a side; drop off a shape to end at a point | P7 | FigJam's connector handles | `from-at`, `to-x`/`to-y` |

### On-canvas controls

Some properties are only honest to edit where the shape is.

| Control | Phase |
|---|---|
| Gradient stop line and width handle | P2 |
| Image crop window with corner and edge handles, Enter to commit, Escape to cancel | P2 |
| Star inner-radius handle on the shape, beside the polygon's existing side count | P4 |
| Corner smoothing shows live as the slider moves, the same live bracket the panel already holds | P4 |
| Constraint preview: resizing a frame while the widget is hovered shows the child's path | P5 |
| Mask outline drawn as a dashed hairline when a masked group is selected | P6 |
| Connector plug and endpoint handles | P7 |

### Kit additions

Built once, used by every section that needs them.

| Control | Used by |
|---|---|
| **StackRow**: eye, body, `…` settings trigger, remove; the one row shape Fill, Stroke and Effects share | Fill, Stroke, Effects |
| **SettingsPopover**: the `…` popover with a title and a grid of labelled rows | Stroke, Effects, Typography, Appearance |
| **SizingSelect**: Fixed / Hug / Fill inside a number field | Position, Typography |
| **ConstraintsWidget** | Position |
| **CapSelect**: an icon select that draws each cap | Stroke, Connector |
| **FontCombobox**: search over loaded families, recent first, free text accepted | Typography |
| **TrackEditor**: a list of grid tracks with a size and unit each | Layout |
| **DashPatternField**: dash-gap pairs, add and remove | Stroke |
| **CropOverlay** and **GradientHandles**: canvas overlays that write through the panel's live bracket, so a drag is one undo | Fill |

Each addition follows the incumbents' rules: the mark is drawn inside the control, the
spoken name is spelled out for assistive tech, mixed state reads "Mixed", every
continuous edit runs inside the store's history bracket so a drag is one undo entry, and
nothing is offered for a selection it cannot apply to.

## The harness that defines "1:1"

Parity is a measurement, not an opinion, so the plan starts with the instrument:

1. A **fixture file** in Figma: one frame per row in the tables above, named after the
   row. Grows with every property added.
2. The plugin exports each frame twice: as `<nt-diagram>` markup, and as a PNG at 1x and
   2x through the Plugin API's `exportAsync`.
3. A Playwright harness renders each markup fixture on a bare page (no editor, no AI
   surfaces, no paid keys) and screenshots it at the same scale.
4. A pixel diff with a per-fixture tolerance. Text fixtures get a looser tolerance and a
   layout-box assertion instead, because anti-aliasing differs between renderers and
   should not fail a build.

The harness lands before Phase 1 and every phase's gate is a green row in it. It is also
what keeps parity from regressing once the translation layer ships.

## Out of scope

Not rendering, so not parity:

- Components, instances, variants, and component properties. The plugin flattens an
  instance to what it looks like. A component model in Nootles is a separate decision.
- Variables other than colour. Number, string and boolean variables resolve at paste;
  modes resolve to the active one.
- Prototyping, interactions, transitions.
- Layout grids and guides, rulers, export settings, slices, Dev Mode annotations.
- Comments and version history.
- Glass, by decision.

## Rules that hold throughout

- Spelling is native inline CSS on the element; the renderer's technique is its own
  business and never reaches the document.
- Attributes for geometry and relationships, as `x`, `y`, `from` and `to` always were.
- Every addition is optional and absent by default, so every document written so far
  serializes byte for byte as it did. No migration in this plan.
- The layout engine (`scene/autoLayout.ts`) stays the single place layout maths is done,
  and never reads a DOM box. Text measurement is the one place a DOM read is unavoidable;
  it is done through a measurement service the engine calls, not by the engine.
- Each phase ships its panel controls with its model. Nothing lands paste-only.

## Order and size

| Phase | Size | Unblocks |
|---|---|---|
| Harness | M | Every gate below |
| 1 Text | L | Nearly every frame |
| 5 Frames, layout, constraints | L | Every product mockup |
| 2 Fills and strokes | M | Most visual polish |
| 4 Geometry | L | Icons, illustrations, vector work |
| 3 Effects | M | Cards, buttons, elevation |
| 6 Compositing | M | Photography, avatars |
| 7 Connectors | M | FigJam |

Text and layout first because they decide whether a paste is usable at all. Geometry
before effects because a shape that is the wrong shape cannot be rescued by a shadow.
Connectors last only because they are FigJam-only; if FigJam is the first source held to
the bar, Phase 7 moves up beside Phase 1.
