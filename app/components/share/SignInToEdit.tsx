"use client";

import { useEffect, useRef } from "react";
import { DialogBox } from "../Dialog";
import { GoogleButton } from "../signin/GoogleButton";
import "@/app/sign-in/signin.css";

/**
 * The answer to a guest reaching for the pen. Opened by any edit attempt on an
 * editable share link — a press into the document, the chat, a key — and it
 * asks for exactly one thing, with the way in right there rather than behind a
 * redirect to the door. The round trip lands back on the share link, which
 * claims the project and carries them into the real workspace.
 *
 * On a read-only link the pen is not the link's to give, so the same door asks
 * for the same thing on behalf of a different next step: `intent="request"`
 * carries `?request=1` home, and the share page turns that into the ask the
 * owner answers. One door either way — what changes is who grants it.
 */
export function SignInToEdit({
  token,
  intent = "edit",
  onClose,
}: {
  token: string;
  intent?: "edit" | "request";
  onClose: () => void;
}) {
  // Opened mid-gesture, so focus is still out in the page — often on nothing
  // focusable at all. The one control here takes it, and gives it back on
  // close so a keyboard visitor lands where they were, not on the body.
  // A frame late, because the press that opened this is still being
  // dispatched: the browser moves focus for the mousedown after mount and
  // would steal it right back.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    const raf = requestAnimationFrame(() => {
      box.current?.querySelector("button")?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  const requesting = intent === "request";
  const label = requesting ? "Sign in to request edit access" : "Sign in to edit";

  return (
    <DialogBox label={label} onClose={onClose}>
      <div ref={box}>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1.5 text-[13px] text-muted">
          {requesting
            ? "This link is read-only, so the owner has to hand over the pen. Signing in is what gives them a name to hand it to."
            : "This project is editable by anyone with the link. Signing in is what puts your name on your edits."}
        </p>
        <div className="mt-4">
          <GoogleButton
            compact
            redirectTo={`/share/${token}${requesting ? "?request=1" : ""}`}
          />
        </div>
      </div>
    </DialogBox>
  );
}
