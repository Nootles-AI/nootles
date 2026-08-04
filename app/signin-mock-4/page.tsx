import { SignInScreen } from "@/app/components/signin/SignInScreen";

/** Door variation 4 — the stacked mark leading, and the page
 *  running off the right edge at full size rather than lying on a desk.
 *
 *  Throwaway. Delete all four `signin-mock-*` routes once one of them wins. */
export default function Mock4Page() {
  return <SignInScreen variant="bleed" />;
}
