"use client";

import { DEFAULT_FONT_SIZE, hasText, type SceneNode } from "../../scene/types";
import { ColorField } from "../controls/ColorField";
import { FontSize, LetterSpacing, LineHeight, TextAlign } from "../controls/glyphs";
import { IconToggle, type ToggleOption } from "../controls/IconToggle";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";
import type { SectionProps } from "../StylePanel";

type Option = { value: string; label: string };

// No webfont is loaded this pass, so every stack here resolves on the machine
// already; "Default" clears the declaration and inherits the app's own face.
const FAMILIES: Option[] = [
  { value: "", label: "Default" },
  { value: "ui-sans-serif, system-ui, sans-serif", label: "Sans" },
  { value: 'ui-serif, Georgia, "Times New Roman", serif', label: "Serif" },
  { value: "ui-monospace, SFMono-Regular, Menlo, monospace", label: "Mono" },
  {
    value: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    label: "Helvetica",
  },
  { value: "Georgia, serif", label: "Georgia" },
];

const WEIGHTS: Option[] = [
  { value: "", label: "Default" },
  { value: "300", label: "Light" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
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

export function TypographySection({ selection, patch, setStyle }: SectionProps) {
  const nodes = selection.filter(
    (node) => hasText(node) && (node.kind === "text" || node.label.trim() !== ""),
  );
  if (nodes.length === 0) return null;

  const size = read(nodes, "font-size");
  const height = read(nodes, "line-height");
  const spacing = read(nodes, "letter-spacing");
  const align = read(nodes, "text-align");
  const vAlign = read(nodes, "align-items");
  const colour = read(nodes, "color");

  // A unitless `line-height` is a multiplier and a px one is a length; scrubbing
  // must not silently reinterpret whichever the document already had.
  const heightUnit = height.value.endsWith("px") ? "px" : "";
  const vAlignValue = vAlign.mixed
    ? ""
    : (V_ALIAS[vAlign.value] ?? (vAlign.value || "flex-start"));

  return (
    <PanelSection title="Text">
      <div className="nt-ctl-group">
        <div className="nt-ctl-row">
          <Choice
            label="Font"
            state={read(nodes, "font-family")}
            options={FAMILIES}
            onChange={(value) => setStyle({ "font-family": value || undefined })}
          />
        </div>
        <div className="nt-ctl-row">
          <Choice
            label="Weight"
            state={read(nodes, "font-weight")}
            options={WEIGHTS}
            onChange={(value) => setStyle({ "font-weight": value || undefined })}
          />
        </div>

        <div className="nt-ctl-grid">
          <NumberField
            label={<FontSize />}
            name="Font size"
            value={num(size, DEFAULT_FONT_SIZE)}
            mixed={size.mixed}
            unit="px"
            min={1}
            max={400}
            onChange={(n) => setStyle({ "font-size": `${n}px` })}
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
            value={num(spacing, 0)}
            mixed={spacing.mixed}
            unit="px"
            step={0.1}
            onChange={(n) =>
              setStyle({ "letter-spacing": n === 0 ? undefined : `${n}px` })
            }
          />
        </div>
      </div>

      {/* One row each. Both toggles used to share a line beside a 54px label
          column, which put 173px of fixed-width buttons into a 161px box. */}
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

      <div className="nt-ctl-group">
        <div className="nt-ctl-row">
          <ColorField
            label="Colour"
            value={colour.value}
            mixed={colour.mixed}
            onChange={(value) => setStyle({ color: value || undefined })}
          />
        </div>
        <div className="nt-ctl-row">
          <Choice
            label="Case"
            state={read(nodes, "text-transform")}
            options={TRANSFORMS}
            onChange={(value) => setStyle({ "text-transform": value || undefined })}
          />
        </div>
        <div className="nt-ctl-row">
          <Choice
            label="Line"
            state={read(nodes, "text-decoration")}
            options={DECORATIONS}
            onChange={(value) =>
              setStyle({ "text-decoration": value || undefined })
            }
          />
        </div>
      </div>
    </PanelSection>
  );
}
