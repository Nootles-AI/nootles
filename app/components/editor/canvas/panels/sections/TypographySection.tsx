"use client";

import { formatMark, formatStyle, useLabelSelection } from "../../render/labelEditing";
import { familyName } from "../../render/fonts";
import {
  indentOf,
  listOf,
  paragraphSpacingOf,
  withIndent,
  withList,
  withParagraphSpacing,
  type ListKind,
} from "../../scene/label";
import { DEFAULT_FONT_SIZE, hasText, type SceneNode, type StylePatch } from "../../scene/types";
import { ColorField } from "../controls/ColorField";
import { FontCombobox } from "../controls/FontCombobox";
import {
  AutoHeight,
  AutoWidth,
  Dots,
  FixedSize,
  FontSize,
  Indent,
  Italic,
  LetterSpacing,
  LineHeight,
  ParagraphSpacing,
  TextAlign,
} from "../controls/glyphs";
import { IconToggle, type ToggleOption } from "../controls/IconToggle";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { Popover } from "../controls/Popover";
import { SelectField } from "../controls/SelectField";
import { FONT_OPTIONS } from "../fontCatalog";
import type { SectionProps } from "../StylePanel";
import { Tooltip } from "../../../../Tooltip";

type Option = { value: string; label: string };

/** Every hundred, named as Figma names them. */
const WEIGHTS: Option[] = [
  { value: "", label: "Default" },
  { value: "100", label: "Thin" },
  { value: "200", label: "Extralight" },
  { value: "300", label: "Light" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
  { value: "800", label: "Extrabold" },
  { value: "900", label: "Black" },
];

const TRANSFORMS: Option[] = [
  { value: "", label: "Default" },
  { value: "uppercase", label: "Uppercase" },
  { value: "lowercase", label: "Lowercase" },
  { value: "capitalize", label: "Capitalize" },
];

const DECORATIONS: Option[] = [
  { value: "", label: "Default" },
  { value: "underline", label: "Underline" },
  { value: "line-through", label: "Strikethrough" },
];

const LISTS: Option[] = [
  { value: "", label: "None" },
  { value: "ul", label: "Bulleted" },
  { value: "ol", label: "Numbered" },
];

const H_ALIGN: ToggleOption<string>[] = [
  { value: "left", label: "Align left", d: "M3 5.5h10M3 10.5h6" },
  { value: "center", label: "Align centre", d: "M3 5.5h10M5 10.5h6" },
  { value: "right", label: "Align right", d: "M3 5.5h10M7 10.5h6" },
  { value: "justify", label: "Justify", d: "M3 5.5h10M3 10.5h10" },
].map(({ value, label, d }) => ({ value, label, icon: <TextAlign d={d} /> }));

/**
 * Where each text alignment puts the label's own box. `justify` has no box
 * placement of its own — it is about the lines within one — so it is absent and
 * leaves whatever placement was already there.
 */
const JUSTIFY: Record<string, string | undefined> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

const V_ALIGN: ToggleOption<string>[] = [
  { value: "flex-start", label: "Align top", d: "M3 3h10M3 6.5h6" },
  { value: "center", label: "Align middle", d: "M3 6h10M3 9.5h6" },
  { value: "flex-end", label: "Align bottom", d: "M3 9h10M3 12.5h6" },
].map(({ value, label, d }) => ({ value, label, icon: <TextAlign d={d} /> }));

/** Grid resolves `start`/`end`; accept both spellings on the way in. */
const V_ALIAS: Record<string, string> = {
  start: "flex-start",
  end: "flex-end",
};

/**
 * Figma's three text sizings, as the CSS that means each. Auto width lets the
 * words set both axes; auto height keeps the width and lets the lines set the
 * height; fixed keeps the box.
 */
type Sizing = "width" | "height" | "fixed";
const SIZINGS: ToggleOption<Sizing>[] = [
  { value: "width", label: "Auto width", icon: <AutoWidth /> },
  { value: "height", label: "Auto height", icon: <AutoHeight /> },
  { value: "fixed", label: "Fixed size", icon: <FixedSize /> },
];
const SIZING_DECLS: Record<Sizing, StylePatch> = {
  width: { width: "max-content", height: "auto" },
  height: { width: undefined, height: "auto" },
  fixed: { width: undefined, height: undefined },
};
function sizingOf(node: SceneNode): Sizing {
  if (node.style.width === "max-content") return "width";
  if (node.style.height === "auto") return "height";
  return "fixed";
}

/**
 * The synthetic option a mixed selection shows, spelled so it cannot collide
 * with a real CSS value. Plain ASCII on purpose: this was a literal NUL byte,
 * which made git treat the whole file as binary and refuse to diff it.
 */
const MIXED = "__mixed__";

type Read = { value: string; mixed: boolean };

function read(nodes: SceneNode[], prop: string): Read {
  const first = nodes[0].style[prop] ?? "";
  return {
    value: first,
    mixed: nodes.some((n) => (n.style[prop] ?? "") !== first),
  };
}

function num({ value }: Read, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** A select over a property, carrying its own name and its own Mixed. */
function Choice({
  label,
  state,
  options,
  onChange,
}: {
  label: string;
  state: Read;
  options: Option[];
  onChange: (value: string) => void;
}) {
  return (
    <SelectField
      label={label}
      value={state.mixed ? MIXED : state.value}
      options={
        state.mixed ? [{ value: MIXED, label: "Mixed" }, ...options] : options
      }
      onChange={(value) => {
        if (value !== MIXED) onChange(value);
      }}
    />
  );
}

/** The catalog value whose first family is the one the browser resolved. */
function familyOption(resolved: string): string {
  const name = familyName(resolved);
  if (!name) return "";
  return FONT_OPTIONS.find((o) => familyName(o.value) === name)?.value ?? resolved;
}

export function TypographySection({ selection, patch, setStyle }: SectionProps) {
  const nodes = selection.filter(
    (node) => hasText(node) && (node.kind === "text" || node.label.trim() !== ""),
  );
  // The selected range inside the open label, if there is one. While it is
  // live the section edits it, the way Figma's does, and node-level fields
  // that have no meaning for a range step aside.
  const range = useLabelSelection();
  if (nodes.length === 0) return null;

  const size = read(nodes, "font-size");
  const height = read(nodes, "line-height");
  const spacing = read(nodes, "letter-spacing");
  const align = read(nodes, "text-align");
  const vAlign = read(nodes, "align-items");
  const colour = read(nodes, "color");
  const family = read(nodes, "font-family");
  const weight = read(nodes, "font-weight");
  const slant = read(nodes, "font-style");
  const transform = read(nodes, "text-transform");
  const decoration = read(nodes, "text-decoration");
  const clamp = read(nodes, "-webkit-line-clamp");

  // A unitless `line-height` is a multiplier and a px one is a length; scrubbing
  // must not silently reinterpret whichever the document already had.
  const heightUnit = height.value.endsWith("px") ? "px" : "";
  const vAlignValue = vAlign.mixed
    ? ""
    : (V_ALIAS[vAlign.value] ?? (vAlign.value || "flex-start"));

  /** One declaration, to the range when there is one and to the nodes otherwise. */
  const decl = (prop: string, value: string | undefined) =>
    range ? formatStyle({ [prop]: value }) : setStyle({ [prop]: value });

  const italic = range ? range.italic : !slant.mixed && slant.value === "italic";
  const setItalic = () => {
    if (range) formatMark("italic");
    else setStyle({ "font-style": italic ? undefined : "italic" });
  };

  /** Whole-label rewrites: paragraphs and lists live in the label, not its style. */
  const relabel = (fn: (label: string) => string) =>
    patch((node) => (hasText(node) ? { label: fn(node.label) } : {}));

  const texts = nodes.filter((node) => node.kind === "text");
  const sizing = texts.length ? sizingOf(texts[0]) : null;
  const sizingMixed = texts.some((node) => sizingOf(node) !== sizing);

  const first = nodes[0];
  const paragraphSpacing = paragraphSpacingOf(first.label);
  const indent = indentOf(first.label);
  const list = listOf(first.label);

  return (
    <PanelSection title={range ? "Selected text" : "Text"}>
      <div className="nt-ctl-group">
        <div className="nt-ctl-row">
          <FontCombobox
            value={range ? familyOption(range.fontFamily) : family.value}
            mixed={!range && family.mixed}
            onChange={(value) => decl("font-family", value || undefined)}
          />
        </div>
        <div className="nt-ctl-grid">
          {/* The weight takes both columns and italic the gutter: a weight
              name needs the room, and italic is one pressed letter, the way
              Figma's style row draws it. */}
          <div className="nt-ctl-wide">
            <Choice
              label="Weight"
              state={range ? { value: range.fontWeight, mixed: false } : weight}
              options={WEIGHTS}
              onChange={(value) => decl("font-weight", value || undefined)}
            />
          </div>
          <Tooltip label="Italic">
            <button
              type="button"
              className="nt-icon-btn is-sm"
              aria-label="Italic"
              aria-pressed={italic}
              onClick={setItalic}
            >
              <Italic />
            </button>
          </Tooltip>
        </div>

        <div className="nt-ctl-grid">
          <NumberField
            label={<FontSize />}
            name="Font size"
            value={range ? Math.round(range.fontSize) : num(size, DEFAULT_FONT_SIZE)}
            mixed={!range && size.mixed}
            unit="px"
            min={1}
            max={400}
            onChange={(n) => decl("font-size", `${n}px`)}
          />
          <NumberField
            label={<LineHeight />}
            name="Line height"
            value={num(height, 1.2)}
            mixed={height.mixed}
            unit={heightUnit || undefined}
            min={0}
            step={heightUnit ? 1 : 0.1}
            onChange={(n) => setStyle({ "line-height": `${n}${heightUnit}` })}
          />
        </div>
        <div className="nt-ctl-grid">
          <NumberField
            label={<LetterSpacing />}
            name="Letter spacing"
            value={range ? Number.parseFloat(range.letterSpacing) || 0 : num(spacing, 0)}
            mixed={!range && spacing.mixed}
            unit="px"
            step={0.1}
            onChange={(n) => decl("letter-spacing", n === 0 ? undefined : `${n}px`)}
          />
          {!range && (
            <NumberField
              label={<ParagraphSpacing />}
              name="Paragraph spacing"
              value={paragraphSpacing}
              mixed={nodes.some((n) => paragraphSpacingOf(n.label) !== paragraphSpacing)}
              unit="px"
              min={0}
              onChange={(n) => relabel((label) => withParagraphSpacing(label, n))}
            />
          )}
        </div>
        {sizing && !range && (
          <div className="nt-ctl-row">
            <IconToggle
              value={sizingMixed ? "" : sizing}
              options={SIZINGS}
              // Only the text kind: a rect sized by its caption would shrink
              // around its words, which is not what a box is for.
              onChange={(value) =>
                patch((node) =>
                  node.kind === "text"
                    ? { style: merge(node.style, SIZING_DECLS[value]) }
                    : {},
                )
              }
            />
          </div>
        )}
      </div>

      {/* One row each. Both toggles used to share a line beside a 54px label
          column, which put 173px of fixed-width buttons into a 161px box. */}
      {!range && (
        <div className="nt-ctl-group">
          <div className="nt-ctl-row">
            <IconToggle
              value={align.mixed ? "" : align.value || "left"}
              options={H_ALIGN}
              // `text-align` alone moves the text inside its box, and a shape's
              // label is a flex item sized to its own content — so with a single
              // word the box is exactly as wide as the word and there is nothing
              // to move it within. `justify-content` is what places the box, so
              // both are written: the box goes where you asked, and `text-align`
              // still governs the lines once the text wraps.
              //
              // Through `patch` rather than `setStyle` for the same reason the
              // vertical control below is: `justify-content` written to a group
              // caught in the same selection would be read as auto-layout.
              onChange={(value) =>
                patch((node) =>
                  hasText(node)
                    ? {
                        style: {
                          ...node.style,
                          "text-align": value,
                          ...(JUSTIFY[value] ? { "justify-content": JUSTIFY[value] } : {}),
                        },
                      }
                    : {},
                )
              }
            />
          </div>
          <div className="nt-ctl-row">
            <IconToggle
              value={vAlignValue}
              options={V_ALIGN}
              // The label is a bare text child, so it needs a formatting context
              // before `align-items` means anything: `display:grid` wraps it in an
              // anonymous grid item that stretches horizontally, which is why
              // `text-align` above keeps working. It goes through `patch` rather
              // than `setStyle` because writing `display` to a group caught in the
              // same selection would turn that group into an auto-layout group.
              onChange={(value) =>
                patch((node) =>
                  hasText(node)
                    ? {
                        style: {
                          ...node.style,
                          display: "grid",
                          "align-items": value,
                        },
                      }
                    : {},
                )
              }
            />
          </div>
        </div>
      )}

      <div className="nt-ctl-group">
        <div className="nt-ctl-row">
          <ColorField
            label="Colour"
            value={range ? range.color : colour.value}
            mixed={!range && colour.mixed}
            onChange={(value) => decl("color", value || undefined)}
          />
        </div>
        <div className="nt-ctl-row">
          {/* Figma's "Type settings": the choices made once a paragraph, not
              once a word, behind the row's own door rather than crowding a
              223px column with four selects. */}
          <Popover
            width={223}
            label="Type settings"
            trigger={(p) => (
              <button {...p} className="nt-ctl-select" aria-label="Type settings">
                <span className="nt-ctl-mark" aria-hidden>
                  <Dots />
                </span>
                <span className="nt-ctl-select-value">Type settings</span>
              </button>
            )}
          >
            {() => (
              <div className="nt-ctl-section-body">
                <div className="nt-ctl-group">
                  <div className="nt-ctl-row">
                    <Choice
                      label="Case"
                      state={range ? { value: range.textTransform === "none" ? "" : range.textTransform, mixed: false } : transform}
                      options={TRANSFORMS}
                      onChange={(value) => decl("text-transform", value || undefined)}
                    />
                  </div>
                  <div className="nt-ctl-row">
                    <Choice
                      label="Line"
                      state={
                        range
                          ? { value: range.underline ? "underline" : range.strike ? "line-through" : "", mixed: false }
                          : decoration
                      }
                      options={DECORATIONS}
                      onChange={(value) => {
                        if (!range) {
                          setStyle({ "text-decoration": value || undefined });
                          return;
                        }
                        // On a range these are marks, toggled as ⌘U would.
                        if (value === "underline" || (value === "" && range.underline)) formatMark("underline");
                        if (value === "line-through" || (value === "" && range.strike)) formatMark("strike");
                      }}
                    />
                  </div>
                  {!range && (
                    <>
                      <div className="nt-ctl-row">
                        <Choice
                          label="List"
                          state={{ value: list, mixed: nodes.some((n) => listOf(n.label) !== list) }}
                          options={LISTS}
                          onChange={(value) => relabel((label) => withList(label, value as ListKind))}
                        />
                      </div>
                      <div className="nt-ctl-grid">
                        <NumberField
                          label={<Indent />}
                          name="Indent"
                          value={indent}
                          mixed={nodes.some((n) => indentOf(n.label) !== indent)}
                          unit="px"
                          onChange={(n) => relabel((label) => withIndent(label, n))}
                        />
                        <NumberField
                          label="Max"
                          name="Max lines"
                          value={num(clamp, 0)}
                          mixed={clamp.mixed}
                          min={0}
                          onChange={(n) =>
                            setStyle({ "-webkit-line-clamp": n > 0 ? String(n) : undefined })
                          }
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </Popover>
        </div>
      </div>
    </PanelSection>
  );
}

function merge(style: SceneNode["style"], decls: StylePatch): SceneNode["style"] {
  const next = { ...style };
  for (const prop in decls) {
    const value = decls[prop];
    if (value === undefined) delete next[prop];
    else next[prop] = value;
  }
  return next;
}
