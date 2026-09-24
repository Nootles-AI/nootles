"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { usePlan } from "@/app/lib/usePlan";
import { Menu, MenuItem, MenuLink } from "./Menu";
import { Settings, Sparkle } from "./Icons";
import { useNotionAvailable } from "./notion/NotionAvailable";
import { useContainer } from "./workspaces/ContainerContext";
import { useAccountSettingsName } from "./workspaces/useAccountSettingsName";

/** First letter of whatever we know them by — name, else the email. */
function initial(name: string | null | undefined, email: string | undefined) {
  return (name?.trim() || email || "?").charAt(0).toUpperCase();
}

/**
 * The account control: initials, and a menu holding the address it belongs to.
 *
 * A monogram rather than the Google avatar — a photo is the loudest thing on a
 * surface this quiet. One exception stands since the sharing work (2026-08):
 * OTHER people show as photos in the presence facepile, because a face answers
 * "who is that caret" faster than an initial. You, to yourself, stay a
 * monogram.
 */
export function AccountMenu({
  align = "end",
  onShowKeys,
}: {
  align?: "start" | "end";
  /** Where the keyboard reference lives; absent where there is none to show. */
  onShowKeys?: () => void;
} = {}) {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const { entitlement: plan } = usePlan();
  // Inside a workspace the AI spends the workspace's allowance, not this one,
  // so the plan line says whose it is.
  const inWorkspace = useContainer().kind === "workspace";
  // Settings holds one thing, the Notion connection; a deployment without the
  // integration has nothing to settle, so the door to it is not offered.
  const settings = useNotionAvailable();
  const settingsName = useAccountSettingsName(!!settings);

  // Nothing rather than an empty circle: this sits in a header, and a element
  // that changes size on load moves the things next to it.
  if (!isLoaded || !user) return null;

  const email = user.primaryEmailAddress?.emailAddress;
  const label = user.fullName || email || "Account";

  return (
    <Menu
      label="Account"
      side="bottom"
      align={align}
      trigger={(t) => (
        <button {...t} aria-label={`Account — ${label}`} className="nt-icon-btn">
          <span className="nt-monogram">{initial(user.fullName, email)}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          {/* Who this is, and where the free run stands — said in the one
              place the account already lives. A limit nobody can look up
              before they hit it is a limit that arrives as an accusation. */}
          <div className="nt-account-who">
            <span className="nt-monogram is-lg" aria-hidden="true">
              {initial(user.fullName, email)}
            </span>
            <span className="nt-account-text">
              <span className="nt-account-name">{label}</span>
              {plan && (
                <span className="nt-account-plan">
                  {inWorkspace && "My Nootles · "}
                  {plan.left === null
                    ? "Pro"
                    : `Free · ${plan.left.completions} completions, ${plan.left.chats} chats left`}
                </span>
              )}
            </span>
          </div>
          <div className="nt-menu-sep" />
          {settings && (
            <MenuLink href="/settings" onClick={() => close()}>
              <Settings width={16} height={16} className="nt-menu-icon" />
              {settingsName}
            </MenuLink>
          )}
          {onShowKeys && (
            <MenuItem
              onClick={() => {
                close();
                onShowKeys();
              }}
            >
              <Keys />
              Keyboard shortcuts
              <kbd className="nt-menu-kbd">?</kbd>
            </MenuItem>
          )}
          <MenuLink href="/upgrade" onClick={() => close()}>
            <Sparkle width={16} height={16} className="nt-menu-icon" />
            {plan?.left === null ? "Plan & billing" : "Upgrade to Pro"}
          </MenuLink>
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

/** A keyboard, in the app's 24-grid stroke. */
function Keys() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="nt-menu-icon"
    >
      <path d="M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8" />
    </svg>
  );
}
