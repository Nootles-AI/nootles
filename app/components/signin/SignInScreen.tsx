"use client";

import dynamic from "next/dynamic";
import { LogoStacked, Wordmark } from "../Brand";
import { GoogleButton } from "./GoogleButton";
import "@/app/sign-in/signin.css";

/**
 * Client-only, like every other place the canvas is drawn outside the editor:
 * the diagram grammar is parsed with `DOMParser`, which the prerender does not
 * have. It also keeps the scene graph out of the bundle the button ships in —
 * the way in paints first, and the argument for using it arrives a beat later.
 */
const Recording = dynamic(
  () => import("./Recording").then((m) => m.Recording),
  { ssr: false },
);

/**
 * The door, in four compositions.
 *
 * The variants exist to answer one question — whether the stacked mark or the
 * wordmark should carry the screen — so everything else about them is held
 * still: same words, same button, same recording, same measure. A comparison
 * where two things changed answers neither.
 *
 *  - `wordmark`: the mark as a header, the heading carrying the page.
 *  - `stacked`:  the mark leading the column, on the heading's own left edge.
 *  - `centred`:  the mark and everything under it centred, as the page was
 *                before there was anything beside it to align to.
 *  - `bleed`:    the mark leading, and the page running off the right edge at
 *                full size rather than sitting on a desk.
 */
export type Variant = "wordmark" | "stacked" | "centred" | "bleed";

export function SignInScreen({ variant }: { variant: Variant }) {
  return (
    <main className={`nt-si is-${variant}`}>
      <section className="nt-si-door">
        <div className="nt-si-col">
          {variant === "wordmark" && (
            <header className="nt-si-head">
              <Wordmark role="img" aria-label="Nootles" className="nt-si-mark" />
            </header>
          )}

          {/* The heading is the claim, not the name. The mark says whose claim
              it is, and a page that spends its `h1` on saying it again tells
              somebody arriving cold nothing they can act on. */}
          <div className="nt-si-say">
            {variant !== "wordmark" && (
              <LogoStacked
                role="img"
                aria-label="Nootles"
                className="nt-si-logo"
              />
            )}
            <h1 className="nt-si-title">Think it through on one page.</h1>
            <p className="nt-si-note">
              Notes, diagrams and maths in one document, with an AI that reads
              every part of it and edits it the way you would.
            </p>
            <GoogleButton />
          </div>
        </div>
      </section>

      <aside className="nt-si-desk">
        {/* No caption. A still picture needs one because it cannot say what it
            is a picture of; a recording says it by happening. */}
        <div className="nt-sheet">
          <Recording />
        </div>
      </aside>
    </main>
  );
}
