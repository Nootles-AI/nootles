import type { CSSProperties } from "react";
import { FREE_LIMITS, type Meter } from "@/convex/limits";

/**
 * Pro, pictured: this account's own free run, lifted.
 *
 * The three allowances are drawn as the paywall draws them — a strip of marks
 * per meter, one mark per unit, the spent ones as present as the ones left —
 * so the picture is of something the person has already met, with their own
 * numbers on it. Then ink runs along each strip in turn and fuses the marks
 * into one unbroken bar, and the count becomes "No limit": what Pro changes is
 * exactly that the marks stop being countable. It holds, lets go, and again.
 *
 * Neutral all the way through — the ink is the page's own. Decorative, and
 * marked so: the row it sits beside says what it is.
 */
const SAID: Record<Meter, string> = {
  projects: "Projects",
  completions: "Completions",
  chats: "Conversations",
};

const ORDER: Meter[] = ["projects", "completions", "chats"];

const turn = (n: number) => ({ "--n": n }) as CSSProperties;

export function ProLift({ left }: { left: Record<Meter, number> }) {
  return (
    <div className="nt-pro" aria-hidden="true">
      <div className="nt-pro-sheet">
        <p className="nt-pro-title">
          Nootles <span className="nt-pro-badge">Pro</span>
        </p>
        <p className="nt-pro-sub">Your free run, lifted.</p>
        {ORDER.map((meter, i) => {
          const limit = FREE_LIMITS[meter];
          const spent = limit - Math.max(0, Math.min(limit, left[meter]));
          return (
            <div key={meter} className="nt-pro-row" style={turn(i)}>
              <p className="nt-pro-said">
                {SAID[meter]}
                <span className="nt-pro-count">
                  <span className="is-free">
                    {limit - spent} of {limit} left
                  </span>
                  <span className="is-pro">No limit</span>
                </span>
              </p>
              <div
                className="nt-pro-strip"
                style={{ "--gap": limit > 50 ? "1.5px" : limit > 5 ? "3px" : "5px" } as CSSProperties}
              >
                {Array.from({ length: limit }, (_, unit) => (
                  <span key={unit} className={unit < spent ? "is-spent" : undefined} />
                ))}
                <span className="nt-pro-fill" />
              </div>
            </div>
          );
        })}
        <p className="nt-pro-foot">Everything already here stays exactly as it is.</p>
      </div>
    </div>
  );
}
