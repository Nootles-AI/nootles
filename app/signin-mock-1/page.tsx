import { SignInScreen } from "@/app/components/signin/SignInScreen";

/** Door variation 1 — the wordmark as a header, the heading
 *  carrying the page.
 *
 *  Throwaway. Delete all four `signin-mock-*` routes once one of them wins. */
export default function Mock1Page() {
  return <SignInScreen variant="wordmark" />;
}
