"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { Menu, MenuItem } from "./Menu";

/** First letter of whatever we know them by — name, else the email. */
function initial(name: string | null | undefined, email: string | undefined) {
  return (name?.trim() || email || "?").charAt(0).toUpperCase();
}

/**
 * The account control: initials, and a menu holding the address it belongs to.
 *
 * A monogram rather than the Google avatar — a photo is the loudest thing on a
 * surface this quiet, and it would be the only remote image in the app.
 */
export function AccountMenu() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();

  // Nothing rather than an empty circle: this sits in a header, and a element
  // that changes size on load moves the things next to it.
  if (!isLoaded || !user) return null;

  const email = user.primaryEmailAddress?.emailAddress;
  const label = user.fullName || email || "Account";

  return (
    <Menu
      label="Account"
      side="bottom"
      align="end"
      trigger={(t) => (
        <button {...t} aria-label={`Account — ${label}`} className="nt-icon-btn">
          <span className="nt-monogram">{initial(user.fullName, email)}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="nt-menu-caption">
            <span className="nt-row-label">{label}</span>
          </div>
          <div className="nt-menu-sep" />
          <MenuItem
            onClick={() => {
              close();
              void signOut({ redirectUrl: "/sign-in" });
            }}
          >
            Sign out
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
