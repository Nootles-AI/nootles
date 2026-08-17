"use client";

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
  return (
    <DialogBox label="Sign in to edit" onClose={onClose}>
      <p className="text-sm font-medium">Sign in to edit</p>
      <p className="mt-1.5 text-[13px] text-muted">
        This file is editable by anyone with the link. Signing in is what puts
        your name on your edits.
      </p>
      <div className="mt-4">
        <GoogleButton compact redirectTo={`/share/${token}`} />
      </div>
    </DialogBox>
  );
}
