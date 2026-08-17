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
 */
export function SignInToEdit({
  token,
  onClose,
}: {
  token: string;
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

  return (
    <DialogBox label="Sign in to edit" onClose={onClose}>
      <div ref={box}>
        <p className="text-sm font-medium">Sign in to edit</p>
        <p className="mt-1.5 text-[13px] text-muted">
          This project is editable by anyone with the link. Signing in is what
          puts your name on your edits.
        </p>
        <div className="mt-4">
          <GoogleButton compact redirectTo={`/share/${token}`} />
        </div>
      </div>
    </DialogBox>
  );
}
