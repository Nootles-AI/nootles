"use client";

import { useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { Wordmark } from "../components/Brand";
import { GoogleMark } from "../components/GoogleMark";
import { PreviewBlocks } from "../components/PagePreview";
import { techDesign } from "@/app/lib/onboarding/templates/techDesign";
import { declaredHeight, examplePage } from "@/app/lib/onboarding/preview";
import "./signin.css";

/**
 * The door.
 *
 * Google is the only way in, so this is one button rather than a form. Built
 * headless instead of with Clerk's prebuilt component: the surface is neutral by
 * design and the accent belongs to AI activity, which a vendor stylesheet has no
 * way to know.
 *
 * Driven through `client.signIn` rather than `useSignIn`, which in this version
 * returns the newer signals resource. That one wants the whole transfer ladder
 * spelled out in the callback; this pairs with `AuthenticateWithRedirectCallback`,
 * which already knows how to turn a first-time Google user into an account.
 *
 * It is the only page whose job is to say what this is, so it shows rather than
 * lists: a real Nootles page lies on the desk beside the way in, with prose, a
 * diagram and code on it. Drawn by the same renderer the projects screen uses,
 * from the same template that seeds a real project — so what is promised here
 * cannot drift from what arrives, and the picture is the one still on screen
 * when first run takes over.
 *
 * One template, imported directly rather than through the templates index: this
 * route needs one page, and the other five would be five files a signed-out
 * visitor downloads to look at a picture of something else.
 */

/** The page on the desk. Prose, a diagram, and real code — one document. */
const SHOWN = techDesign;
const PAGE = examplePage(SHOWN);
const DIAGRAM_HEIGHT = declaredHeight(SHOWN.script.draw.html);

export default function SignInPage() {
  const { isLoaded } = useAuth();
  const clerk = useClerk();
  const [failed, setFailed] = useState(false);
  const [going, setGoing] = useState(false);

  const start = async () => {
    if (!isLoaded || going) return;
    setFailed(false);
    setGoing(true);
    try {
      await clerk.client.signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/",
      });
    } catch {
      // The redirect never happened, so this is still mounted to say so.
      setFailed(true);
      setGoing(false);
    }
  };

  return (
    <main className="nt-si">
      <section className="nt-si-door">
        <div className="nt-si-col">
          <header className="nt-si-head">
            <Wordmark role="img" aria-label="Nootles" className="nt-si-mark" />
          </header>

          {/* The heading is the claim, not the name. The mark above already says
              whose product this is, and a page that spends its `h1` on saying it
              again tells somebody arriving cold nothing they can act on. */}
          <div className="nt-si-say">
            <h1 className="nt-si-title">Think it through on one page.</h1>
            <p className="nt-si-note">
              Notes, diagrams and maths in one document, with an AI that reads
              every part of it and edits it the way you would.
            </p>

            <button
              onClick={start}
              disabled={!isLoaded || going}
              aria-busy={going}
              className="nt-si-go"
            >
              <GoogleMark width={16} height={16} />
              {going ? "Taking you to Google…" : "Continue with Google"}
            </button>

            {/*
              One region rather than a message that appears and shoves the page
              down, and `aria-live` rather than a `role` that switches to "alert"
              only once it has something to say — a live region has to be in the
              document before the text lands for the change to be announced.
            */}
            <p
              aria-live="polite"
              className={`nt-si-status${failed ? " is-failure" : ""}`}
            >
              {failed
                ? "That didn’t go through. Try again."
                : "New here? Signing in creates your account."}
            </p>
          </div>
        </div>
      </section>

      <aside className="nt-si-desk">
        <div className="nt-sheet" aria-hidden>
          <div className="nt-sheet-page">
            <PreviewBlocks blocks={PAGE} diagramHeight={DIAGRAM_HEIGHT} />
          </div>
        </div>
        {/* The picture cannot say what it is a picture of, so one line does. */}
        <p className="nt-sheet-caption">{SHOWN.showcase.caption}</p>
      </aside>
    </main>
  );
}
