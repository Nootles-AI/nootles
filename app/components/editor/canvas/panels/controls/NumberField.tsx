"use client";

import { useRef, useState, type ReactNode } from "react";
import { Tooltip } from "@/app/components/Tooltip";
import { useLiveEdit } from "./live";
import "./controls.css";

/**
 * Recursive descent over `+ - * / ( )`. A number field that accepts "120+8" is
 * worth the forty lines; `eval` on a string a document can reach is not.
 * Returns null for anything it does not fully consume, and the field keeps the
 * value it had.
 */
function evaluate(src: string): number | null {
  let i = 0;
  const ws = () => {
    while (src[i] === " ") i++;
  };

  const atom = (): number | null => {
    ws();
    if (src[i] === "-") {
      i++;
      const v = atom();
      return v === null ? null : -v;
    }
    if (src[i] === "+") {
      i++;
      return atom();
    }
    if (src[i] === "(") {
      i++;
      const v = sum();
      ws();
      if (v === null || src[i] !== ")") return null;
      i++;
      return v;
    }
    const start = i;
    while (i < src.length && (src[i] === "." || (src[i] >= "0" && src[i] <= "9")))
      i++;
    if (i === start) return null;
    const n = Number(src.slice(start, i));
    return Number.isFinite(n) ? n : null;
  };

  const product = (): number | null => {
    let left = atom();
    for (;;) {
      if (left === null) return null;
      ws();
      const op = src[i];
      if (op !== "*" && op !== "/") return left;
      i++;
      const right = atom();
      if (right === null) return null;
      left = op === "*" ? left * right : left / right;
    }
  };

  const sum = (): number | null => {
    let left = product();
    for (;;) {
      if (left === null) return null;
      ws();
      const op = src[i];
      if (op !== "+" && op !== "-") return left;
      i++;
      const right = product();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
  };

  const out = sum();
  ws();
  return out !== null && i === src.length && Number.isFinite(out) ? out : null;
}

/** Enough precision for a 0.1x scrub, without printing float noise. */
const snap = (n: number) => Math.round(n * 1000) / 1000;
const format = (n: number) => String(Math.round(n * 100) / 100);

/**
 * The units a CSS length may be authored in, the default first. A property that
 * takes fewer passes its own list; everything the panel edits takes these.
 */
export const LENGTH_UNITS = ["px", "%", "em", "rem", "vw", "vh"] as const;

/**
 * A typed entry: an expression, and the unit written after it if there was one.
 * `12` keeps the unit the field already had — a bare number means "this many of
 * whatever this is", which is how every other design tool reads it.
 */
function parseEntry(
  src: string,
  units: readonly string[] | undefined,
  fallback: string,
): { value: number; unit: string } | null {
  const trimmed = src.trim();
  const suffix = /[a-z%]+$/i.exec(trimmed);
  if (units && suffix) {
    const unit = suffix[0].toLowerCase();
    // A unit the property does not take is a typo, not a bare number: keeping
    // the digits and dropping it would quietly write the wrong length.
    if (!units.includes(unit)) return null;
    const value = evaluate(trimmed.slice(0, suffix.index));
    return value === null ? null : { value, unit };
  }
  const value = evaluate(trimmed);
  return value === null ? null : { value, unit: fallback };
}

export function NumberField({
  label,
  name,
  value,
  onChange,
  onPreview,
  unit,
  units,
  min,
  max,
  step = 1,
  mixed,
}: {
  /**
   * What is drawn inside the field: a letter where one is universal (X, W), a
   * glyph from `./glyphs` where it is not. "R" used to mean rotation in one
   * section and right-padding in another, sitting one row from "C" for corner
   * radius — a letter can only carry a name the whole app already agrees on.
   */
  label?: ReactNode;
  /**
   * The field's real name: its accessible name, and its tooltip. Always spell
   * this out — the mark beside it is shorthand, and shorthand is exactly what
   * a screen reader and a new user cannot expand.
   */
  name?: string;
  value: number;
  /** `unit` is the one the edit was made in — the field's own when untouched. */
  onChange: (value: number, unit: string) => void;
  /**
   * A field that can show a scrub itself: called once per frame with the value
   * under the pointer, instead of the scene hearing it. For an edit too
   * expensive to apply per frame, where the commit still lands on release.
   */
  onPreview?: (value: number) => void;
  unit?: string;
  /**
   * Makes the unit editable: typing `50%` or `1.5em` changes it, and a scrub
   * keeps it. Absent, `unit` is decoration and the value is a plain number.
   */
  units?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  mixed?: boolean;
}) {
  /** Non-null only while you are typing into it. */
  const [text, setText] = useState<string | null>(null);
  /** Non-null only while you are scrubbing it. */
  const [preview, setPreview] = useState<number | null>(null);
  const scrub = useRef<{
    x: number;
    from: number;
    next: number;
    /** The last value handed to `onChange`, so a frame that changed nothing
     *  costs nothing and one that undid the last frame still lands. */
    sent: number;
    frame: number;
    moved: boolean;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useLiveEdit();

  const clamp = (n: number) =>
    Math.min(max ?? Infinity, Math.max(min ?? -Infinity, snap(n)));

  const own = unit ?? "";

  const emit = (n: number, u = own) => {
    const next = clamp(n);
    if (mixed || next !== value || u !== own) onChange(next, u);
  };

  /** The scrub's value, out to the scene. */
  const push = () => {
    const s = scrub.current;
    if (!s || s.sent === s.next) return;
    s.sent = s.next;
    onChange(s.next, own);
  };

  const commitText = () => {
    if (text === null) return;
    const entry = parseEntry(text, units, own);
    setText(null);
    if (entry) emit(entry.value, entry.unit);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitText();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText(null);
      e.currentTarget.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const entry = text !== null ? parseEntry(text, units, own) : null;
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      setText(null);
      emit(
        (entry?.value ?? value) + step * mult * (e.key === "ArrowUp" ? 1 : -1),
        entry?.unit ?? own,
      );
    }
  };

  // The whole box scrubs — label, number, unit, padding — until you are
  // actually typing in it, at which point dragging selects text like any other
  // field. Pointer capture is released implicitly on pointerup.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || document.activeElement === inputRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Mixed has no value to compare against, so every frame counts as a change.
    scrub.current = {
      x: e.clientX,
      from: value,
      next: value,
      sent: mixed ? NaN : value,
      frame: 0,
      moved: false,
    };
    live?.begin();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (!s.moved && Math.abs(dx) < 3) return;
    s.moved = true;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    s.next = clamp(s.from + dx * step * mult);
    // One write per frame, however fast the events arrive. Where a live edit is
    // cheap it goes straight to the scene, so the canvas moves with the drag;
    // where it is not, the value is previewed — by the caller if it can show
    // one, otherwise by the field alone — and the scene hears once, at the end.
    if (s.frame === 0)
      s.frame = requestAnimationFrame(() => {
        s.frame = 0;
        setPreview(s.next);
        if (onPreview) onPreview(s.next);
        else if (live) push();
      });
  };

  const end = (commit: boolean) => {
    const s = scrub.current;
    if (!s) return;
    if (s.frame) cancelAnimationFrame(s.frame);
    setPreview(null);
    if (!s.moved) inputRef.current?.select();
    else if (commit) push();
    // A cancelled scrub leaves a preview on screen that nothing will overwrite.
    else onPreview?.(s.from);
    scrub.current = null;
    live?.end();
  };

  const shown =
    text ?? (preview !== null ? format(preview) : mixed ? "" : format(value));

  // Where the unit is editable, the default one is not drawn: a length is px
  // unless it says otherwise, and four corner fields reading "px" is noise.
  const suffix = units && unit === units[0] ? undefined : unit;

  const field = (
    <div
      className={`ab-num${preview !== null ? " is-scrubbing" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
    >
      {label !== undefined && (
        <span className="ab-ctl-mark" aria-hidden>
          {label}
        </span>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        className="ab-num-input"
        aria-label={name}
        value={shown}
        placeholder={mixed ? "Mixed" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={onKeyDown}
      />
      {suffix !== undefined && <span className="ab-num-unit">{suffix}</span>}
    </div>
  );

  // The mark inside the field is shorthand; the tooltip is where it is spelled
  // out. Skipped when there is no mark to explain.
  return name !== undefined && label !== undefined ? (
    <Tooltip label={name} className="ab-ctl-anchor">
      {field}
    </Tooltip>
  ) : (
    field
  );
}
