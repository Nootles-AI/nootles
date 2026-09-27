"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "@/app/components/Icons";
import {
  declareVariable,
  nextVariableName,
  refName,
  removeVariable,
  resolveVars,
  toVariableName,
  useColorVariables,
  varLabel,
  varRef,
  type ColorVariable,
  type ColorVariablesApi,
} from "../colorVariables";
import {
  canSampleScreen,
  colorPick,
  useColorPick,
  usePickHost,
  type PickDestination,
  type PickResult,
  type PickSource,
} from "./colorPick";
import { Dropper } from "./glyphs";
import { useLiveEdit } from "./live";
import { Popover } from "./Popover";
import { track } from "./track";
import {
  displayColor,
  formatColor,
  hsvToRgb,
  parseColor,
  parseColorText,
  readColor,
  rgbToHsv,
  toHex,
  writeColor,
  type RGBA,
} from "./color";
import "./controls.css";

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };
const NO_VARS: readonly ColorVariable[] = [];

/** How long the first click waits to see whether a second one is coming. */
const DOUBLE_MS = 220;

/** `.nt-ctl-tag` shown after the swatch text for a value authored in a
 *  gamut wider than sRGB — the reader's cue that the hex shown is not the
 *  whole story. */
function wideGamutTag(value: string): string | null {
  const read = readColor(value);
  if (!read) return null;
  if (read.form === "display-p3") return "P3";
  if (read.form === "oklch" || read.form === "oklab") return "OKLCH";
  return null;
}

export function ColorField({
  label,
  value,
  onChange,
  onPreview,
  mixed,
  accepts = "color",
}: {
  /** The mark drawn inside the control, as on every other field. */
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * Where there is no live context because writing the colour is too expensive
   * to do per frame, but the caller can show it itself: called once per frame of
   * a drag with the colour under the pointer, `onChange` still landing once on
   * release. Ignored for a field bound to a variable, whose picker edits the
   * variable's declaration rather than the field.
   */
  onPreview?: (value: string) => void;
  mixed?: boolean;
  /**
   * `"paint"` also accepts a whole gradient — Shift-pick on a gradient hit
   * converts this field's row to that gradient. Only the box-fill solid row
   * and the diagram background field pass `"paint"`; every other colour
   * field (stroke, effects, typography, a gradient stop, a path's SVG fill)
   * stays `"color"`, the default (COLOR §2.4a).
   */
  accepts?: "color" | "paint";
}) {
  const api = useColorVariables();
  const vars = api?.variables ?? NO_VARS;
  const bound = refName(value);
  // The panel lives outside `<nt-diagram>`, so a reference has to be resolved
  // by hand before anything can paint it.
  const paint = resolveVars(value, vars);
  const rgba = parseColor(paint);
  const [typing, setTyping] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  /**
   * The picker opens on a click, so the click that opens it cannot also be the
   * first half of a double click — the open waits out the second one instead.
   * A bound field reads as a name rather than a hex and has nothing to type
   * into, so it keeps opening at once.
   */
  const click = (open: () => void) => {
    if (bound !== null) return open();
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
      return setTyping(true);
    }
    pending.current = setTimeout(() => {
      pending.current = null;
      open();
    }, DOUBLE_MS);
  };

  const commitHex = (text: string | null) => {
    setTyping(false);
    if (text === null) return;
    const next = parseColorText(text);
    if (!next) return;
    // A plain hex says nothing about opacity, so the colour keeps its own.
    const a = rgba && !mixed && isPlainHex(text) ? rgba.a : next.a;
    onChange(formatColor({ ...next, a }));
  };

  if (typing) {
    return (
      <HexInput
        seed={mixed ? "" : rgba ? toHex(rgba) : value.trim()}
        onDone={commitHex}
      />
    );
  }

  return (
    <Popover
      width={224}
      label="Colour"
      trigger={(p) => (
        <button
          {...p}
          className="nt-ctl-swatch"
          aria-label={label}
          onClick={() => click(p.onClick)}
        >
          {label !== undefined && (
            <span className="nt-ctl-mark" aria-hidden>
              {label}
            </span>
          )}
          <Swatch color={mixed ? undefined : paint} />
          <span className="nt-ctl-swatch-text">
            {mixed ? "Mixed" : bound ? varLabel(bound) : displayColor(value)}
          </span>
          {!mixed && !bound && wideGamutTag(value) && (
            <span className="nt-ctl-tag" title={value}>
              {wideGamutTag(value)}
            </span>
          )}
        </button>
      )}
    >
      {() => (
        <Body
          value={paint}
          bound={bound}
          api={api}
          onChange={onChange}
          onPreview={onPreview}
          accepts={accepts}
        />
      )}
    </Popover>
  );
}

/** The hex, typed where it is read. Enter or blur commits, Escape drops it. */
function HexInput({
  seed,
  onDone,
}: {
  seed: string;
  onDone: (text: string | null) => void;
}) {
  const dropped = useRef(false);
  // Stable, so the field is selected when it mounts and not on every render.
  const selectAll = useCallback((el: HTMLInputElement | null) => {
    el?.select();
  }, []);

  // `flex-auto` is the swatch's own `flex: 1 1 auto`, so the input occupies
  // exactly the box it replaces and no row reflows around it.
  return (
    <input
      ref={selectAll}
      type="text"
      spellCheck={false}
      className="nt-ctl-text min-w-0 flex-auto"
      aria-label="Hex colour"
      defaultValue={seed}
      onBlur={(e) => onDone(dropped.current ? null : e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.stopPropagation();
          dropped.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Checkerboard behind, colour on top, so alpha reads as alpha. */
export function Swatch({ color }: { color?: string }) {
  return (
    <span className="nt-ctl-chip">
      {color !== undefined && (
        <span className="nt-ctl-chip-fill" style={{ background: color }} />
      )}
    </span>
  );
}

function Body({
  value,
  bound,
  api,
  onChange,
  onPreview,
  accepts,
}: {
  /** Already resolved: the literal colour behind the field. */
  value: string;
  bound: string | null;
  api: ColorVariablesApi | null;
  onChange: (value: string) => void;
  onPreview?: (value: string) => void;
  accepts: "color" | "paint";
}) {
  const rgba = parseColor(value) ?? BLACK;
  const literal = formatColor(rgba);
  const live = useLiveEdit();
  const host = usePickHost();
  const pick = useColorPick();
  // A bound field edits the variable's own declaration — the shape keeps its
  // reference, and every other shape on it follows. Memoised so it has a
  // stable identity across renders that don't actually change it, which is
  // what keeps `applyPick`/`startPick` below from rebuilding every render.
  const target = useMemo(
    () =>
      bound !== null && api !== null && api.variables.some((v) => v.name === bound)
        ? { api, name: bound }
        : null,
    [bound, api],
  );

  /**
   * Exactly once per successful pick — the field's own `onChange` path,
   * **except**: a `var()` result landing on an already-bound field rebinds
   * (the same call `Variables`' row `onClick` makes) rather than editing the
   * bound variable's own declaration. Picking a `var(--brand)` onto a field
   * bound to `--accent` must leave `--accent`'s own declaration — and every
   * other shape that references it — untouched.
   */
  const applyPick = useCallback(
    (picked: string, result: PickResult) => {
      if (result.kind === "authored" && refName(picked) !== null) {
        onChange(picked);
      } else if (target) {
        target.api.setStyle(declareVariable(target.name, picked));
      } else {
        onChange(picked);
      }
    },
    [onChange, target],
  );

  const startPick = useCallback(
    (source: PickSource) => {
      const dest: PickDestination = {
        accepts,
        current: value,
        apply: applyPick,
        preview: target === null ? onPreview : undefined,
      };
      colorPick.start(dest, source, host);
    },
    [host, accepts, value, applyPick, target, onPreview],
  );

  const canScreen = canSampleScreen();

  return (
    // `display: contents`: this wrapper exists only to catch the `I` key
    // while the popover is open — it must not become a second flex box
    // inside `.nt-ctl-pop`, which lays its DIRECT children out with `gap`.
    <div
      style={{ display: "contents" }}
      onKeyDown={(e) => {
        if (e.key.toLowerCase() !== "i") return;
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
        e.preventDefault();
        e.stopPropagation();
        startPick(e.shiftKey && canScreen ? "screen" : "canvas");
      }}
    >
      {bound !== null && (
        <div className="nt-ctl-row">
          <span className="nt-ctl-note min-w-0 flex-1 truncate">
            {target
              ? `Editing ${varLabel(bound)}`
              : `${varLabel(bound)} — undefined`}
          </span>
          <TextButton label="Detach" onClick={() => onChange(literal)} />
        </div>
      )}
      <Picker
        value={rgba}
        base={value}
        // A variable's declaration is the diagram's own style: writing it
        // re-serializes the whole canvas, which is too much to do per frame.
        live={live !== null && target === null}
        onPreview={target === null ? onPreview : undefined}
        onChange={(css) =>
          target
            ? target.api.setStyle(declareVariable(target.name, css))
            : onChange(css)
        }
      />
      <div className="nt-ctl-row">
        {/* One eyedropper, as the key is one: the diagram by default, and
            with Shift anywhere on screen where the browser can sample it. */}
        <button
          type="button"
          className="nt-icon-btn is-sm"
          aria-label="Pick a colour"
          title={canScreen ? "Pick from canvas (I) · Shift for anywhere on screen" : "Pick from canvas (I)"}
          disabled={!host && !canScreen}
          // Matches `Refit`'s own rule in `CanvasSurface.tsx`: a pointerdown
          // on a panel button must not blur — and so end — a label mid-edit
          // before the pick session even starts.
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) =>
            startPick((e.shiftKey || !host) && canScreen ? "screen" : "canvas")
          }
        >
          <Dropper width={15} height={15} />
        </button>
        <span className="nt-ctl-note min-w-0 flex-1 truncate">
          {pick.active ? "Click on the canvas…" : "Pick a colour"}
        </span>
      </div>
      {api && (
        <Variables api={api} bound={bound} literal={literal} onPick={onChange} />
      )}
    </div>
  );
}

function Variables({
  api,
  bound,
  literal,
  onPick,
}: {
  api: ColorVariablesApi;
  bound: string | null;
  literal: string;
  onPick: (value: string) => void;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const vars = api.variables;
  // Stable, so the field is selected when it mounts and not on every render.
  const selectAll = useCallback((el: HTMLInputElement | null) => el?.select(), []);

  const create = (text: string) => {
    setNaming(null);
    const name = toVariableName(text);
    if (!name) return;
    api.setStyle(declareVariable(name, literal));
    onPick(varRef(name));
  };

  // Deleting the variable a field is bound to would leave it painting nothing,
  // so the field keeps the colour it was showing.
  const remove = (v: ColorVariable) => {
    if (v.name === bound) onPick(literal);
    api.setStyle(removeVariable(v.name));
  };

  return (
    <div className="border-border flex flex-col gap-1 border-t pt-2">
      <div className="flex items-center justify-between">
        <span className="nt-ctl-sublabel">Variables</span>
        <button
          className="nt-icon-btn is-sm"
          aria-label="Create variable from this colour"
          title="Create variable from this colour"
          onClick={() => setNaming(varLabel(nextVariableName(vars)))}
        >
          <Plus width={13} height={13} />
        </button>
      </div>

      {naming !== null && (
        <input
          ref={selectAll}
          type="text"
          spellCheck={false}
          className="nt-ctl-text"
          aria-label="Variable name"
          defaultValue={naming}
          onBlur={(e) => create(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.stopPropagation();
              setNaming(null);
            }
          }}
        />
      )}

      {vars.length === 0 ? (
        <span className="nt-ctl-note">No variables yet</span>
      ) : (
        <div className="flex max-h-[124px] flex-col gap-0.5 overflow-y-auto">
          {vars.map((v) => (
            <div key={v.name} className="nt-ctl-row gap-0.5">
              <button
                className="nt-ctl-swatch"
                aria-pressed={v.name === bound}
                onClick={() => onPick(varRef(v.name))}
              >
                <Swatch color={resolveVars(v.value, vars)} />
                <span className="nt-ctl-swatch-text">{varLabel(v.name)}</span>
                <span className="nt-ctl-check">
                  {v.name === bound && <Check width={12} height={12} />}
                </span>
              </button>
              <button
                className="nt-icon-btn is-sm"
                aria-label={`Delete ${varLabel(v.name)}`}
                title="Delete variable"
                onClick={() => remove(v)}
              >
                <X width={12} height={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TextButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="nt-ctl-textbtn">
      {label}
    </button>
  );
}

function Picker({
  value,
  base,
  live,
  onPreview,
  onChange,
}: {
  value: RGBA;
  /**
   * The field's own value **as authored**, before this drag — `writeColor`'s
   * `prev`, so scrubbing hue/saturation/alpha on an `oklch()`/`color(
   * display-p3 …)` fill keeps writing that same form instead of collapsing
   * every edit to hex/rgba (COLOR §5.2). The hex text input below stays on
   * `formatColor` regardless — typing a hex is an intent to leave the wide
   * form, per the same section.
   */
  base: string;
  /** Emit every frame of a drag rather than only its last, so the canvas
   *  previews it. The panel's own bracket keeps that one undo entry. */
  live: boolean;
  /** Where it is not live: the frame goes here instead, and the caller paints
   *  it without the store hearing anything until the drag ends. */
  onPreview?: (value: string) => void;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState<RGBA | null>(null);
  const [text, setText] = useState<string | null>(null);
  // The drag's end handler is built at pointer-down, so it cannot read the
  // draft off that render. The ref is what it commits.
  const held = useRef<RGBA | null>(null);
  /** The last colour sent, so a frame that changed nothing costs nothing. */
  const sent = useRef<string | null>(null);

  const rgba = draft ?? value;
  const hsv = rgbToHsv(rgba);
  // Hue survives a trip through black or grey, where the colour no longer
  // carries one of its own.
  const [lastHue, setLastHue] = useState(hsv.h);
  const hue = hsv.s > 0 && hsv.v > 0 ? hsv.h : lastHue;

  const set = (next: RGBA) => {
    held.current = next;
    setDraft(next);
    const emit = live ? onChange : onPreview;
    if (!emit) return;
    const css = writeColor(base, next);
    if (css === sent.current) return;
    sent.current = css;
    emit(css);
  };
  /** One drag is one edit — a live one already sent its last frame. */
  const commit = () => {
    const next = held.current;
    held.current = null;
    sent.current = null;
    setDraft(null);
    if (next && !live) onChange(writeColor(base, next));
  };
  const withHsv = (h: number, s: number, v: number) => ({
    ...hsvToRgb(h, s, v),
    a: rgba.a,
  });

  return (
    <>
      <div
        className="nt-ctl-sv"
        style={{ backgroundColor: `hsl(${hue} 100% 50%)` }}
        onPointerDown={(e) =>
          track(e, (x, y) => set(withHsv(hue, x, 1 - y)), commit, {
            batch: true,
          })
        }
      >
        <span
          className="nt-ctl-knob"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>

      <div
        className="nt-ctl-slider is-hue"
        onPointerDown={(e) =>
          track(
            e,
            (x) => {
              setLastHue(x * 360);
              set(withHsv(x * 360, hsv.s, hsv.v));
            },
            commit,
            { batch: true },
          )
        }
      >
        <span className="nt-ctl-knob" style={{ left: `${(hue / 360) * 100}%` }} />
      </div>

      <div
        className="nt-ctl-slider is-alpha"
        onPointerDown={(e) =>
          track(e, (x) => set({ ...rgba, a: x }), commit, { batch: true })
        }
      >
        <span
          className="nt-ctl-alpha-fill"
          style={{
            background: `linear-gradient(90deg, ${formatColor({
              ...rgba,
              a: 0,
            })}, ${formatColor({ ...rgba, a: 1 })})`,
          }}
        />
        <span className="nt-ctl-knob" style={{ left: `${rgba.a * 100}%` }} />
      </div>

      {/* Hex here, opacity on the slider above: the two halves a designer
          thinks in, never one string that mixes them. */}
      <input
        type="text"
        spellCheck={false}
        className="nt-ctl-text"
        aria-label="Hex colour"
        value={text ?? toHex(rgba)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = text === null ? null : parseColorText(text);
          setText(null);
          if (!next) return;
          // A plain hex says nothing about opacity, so the slider keeps it.
          const a = text !== null && isPlainHex(text) ? rgba.a : next.a;
          onChange(formatColor({ ...next, a }));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            setText(null);
            e.currentTarget.blur();
          }
        }}
      />
    </>
  );
}

const isPlainHex = (text: string) =>
  /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text.trim());
