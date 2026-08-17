import { SignInScreen } from "@/app/components/signin/SignInScreen";

/**
 * The door.
 *
 * The only screen a signed-out person ever sees, so it shows rather than tells:
 * a page writes itself beside the way in, with a line being finished, a diagram
 * being drawn from a sentence, and that diagram being dragged into shape. The
 * composition lives in `SignInScreen`; "centred" is the treatment of the mark
 * that won the signin-mock comparison.
 */
export default function SignInPage() {
  return <SignInScreen variant="centred" />;
}
