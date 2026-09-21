"use client";

import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown } from "./icons";
import { Pop } from "./overlays";
import { swatches } from "./data";

export function IconBtn({
  tip,
  keys,
  side,
  on,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tip: string; keys?: string; side?: "bottom"; on?: boolean }) {
  return (
    <button
      type="button"
      aria-label={tip}
      aria-pressed={on}
      data-tip={tip}
      data-keys={keys}
      data-tip-side={side}
      className={`ek-icon-btn ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A well with a thumb that travels to the chosen segment (`--at`, `--n`). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; tip?: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  const at = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="group" aria-label={label} className={`ek-seg ${className}`} style={{ "--at": at, "--n": options.length } as CSSProperties}>
      <span className="ek-seg-thumb" aria-hidden />
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} data-tip={o.tip} className="ek-seg-btn" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A number with a name. Dragging the name scrubs the value, which is how the
 * panel is meant to be played: by hand, watching the shape.
 */
export function NumberField({
  lead,
  label,
  value,
  unit,
  min = -9999,
  max = 9999,
  onStart,
  onChange,
}: {
  lead: ReactNode;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  onStart?: () => void;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  const scrub = useRef<{ x: number; from: number } | null>(null);
  return (
    <label className="ek-num" data-tip={label}>
      <span
        className="ek-num-lead"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub.current = { x: e.clientX, from: value };
          onStart?.();
        }}
        onPointerMove={(e) => {
          if (scrub.current) onChange(clamp(scrub.current.from + (e.clientX - scrub.current.x)));
        }}
        onPointerUp={() => (scrub.current = null)}
      >
        {lead}
      </span>
      <input
        aria-label={label}
        inputMode="numeric"
        value={value}
        onFocus={(e) => {
          onStart?.();
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (!Number.isNaN(v)) onChange(clamp(v));
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 1;
          if (e.key === "ArrowUp") onChange(clamp(value + step));
          else if (e.key === "ArrowDown") onChange(clamp(value - step));
          else return;
          e.preventDefault();
        }}
      />
      {unit && <span className="ek-num-unit">{unit}</span>}
    </label>
  );
}

export function Slider({ value, label, onStart, onChange }: { value: number; label: string; onStart?: () => void; onChange: (v: number) => void }) {
  const set = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onChange(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100));
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      className="ek-slider"
      style={{ "--v": value / 100 } as CSSProperties}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onStart?.();
        set(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && set(e)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onChange(Math.min(100, value + 1));
        if (e.key === "ArrowLeft") onChange(Math.max(0, value - 1));
      }}
    >
      <span className="ek-slider-fill" />
      <span className="ek-slider-thumb" />
    </div>
  );
}

export function ColorField({ label, value, onStart, onChange }: { label: string; value: string; onStart?: () => void; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="ek-color">
      <button
        ref={anchor}
        type="button"
        aria-label={`${label} colour`}
        aria-expanded={open}
        className="ek-swatch"
        style={{ "--c": value } as CSSProperties}
        onClick={() => setOpen((o) => !o)}
      />
      <input aria-label={`${label} hex`} value={value.replace("#", "").toUpperCase()} onFocus={onStart} onChange={(e) => onChange(`#${e.currentTarget.value}`)} />
      <Pop open={open} onClose={() => setOpen(false)} anchor={anchor} side="left" label={`${label} colours`} role="dialog" className="ek-pop-colors">
        <div className="ek-group-label">Document colours</div>
        <div className="ek-swatches">
          {swatches.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={c.toLowerCase() === value.toLowerCase()}
              className="ek-swatch"
              style={{ "--c": c } as CSSProperties}
              onClick={() => {
                onStart?.();
                onChange(c);
              }}
            />
          ))}
        </div>
      </Pop>
    </div>
  );
}

/** A panel section that folds. The body is always laid out; the row height animates. */
export function Section({ title, end, open: initial = true, children }: { title: string; end?: ReactNode; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="ek-section" data-open={open}>
      <header className="ek-section-head">
        <button type="button" aria-expanded={open} className="ek-section-title" onClick={() => setOpen((o) => !o)}>
          {title}
        </button>
        {end}
        <button type="button" aria-label={open ? `Collapse ${title}` : `Expand ${title}`} className="ek-icon-btn is-sm ek-section-twist" onClick={() => setOpen((o) => !o)}>
          <ChevronDown width={12} height={12} />
        </button>
      </header>
      <div className="ek-section-fold" inert={!open}>
        <div className="ek-section-body">{children}</div>
      </div>
    </section>
  );
}

/**
 * Text the mockup does not own once it is on screen: set on mount, then the
 * browser's. React never re-renders it, so typing is never fought over.
 */
export const Editable = memo(
  function Editable({
    initial,
    className,
    placeholder,
    autoFocus,
    tag: Tag = "div",
    onKeyDown,
    onInput,
    onBlur,
  }: {
    initial: string;
    className?: string;
    placeholder?: string;
    autoFocus?: boolean;
    tag?: "div" | "span" | "h1" | "h2";
    onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
    onInput?: (el: HTMLElement) => void;
    onBlur?: (text: string) => void;
  }) {
    const el = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
      const node = el.current;
      if (!node) return;
      node.textContent = initial;
      if (autoFocus) {
        node.focus();
        const range = document.createRange();
        range.selectNodeContents(node);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
      // Set once: after this the text belongs to whoever is typing in it.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <Tag
        ref={el as never}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder={placeholder}
        className={className}
        onKeyDown={onKeyDown}
        onInput={(e) => onInput?.(e.currentTarget)}
        onBlur={(e) => onBlur?.(e.currentTarget.textContent ?? "")}
      />
    );
  },
  () => true,
);
