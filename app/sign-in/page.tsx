import { SignInScreen } from "@/app/components/signin/SignInScreen";

/**
 * The door.
 *
 * The only screen a signed-out person ever sees, so it shows rather than tells:
 * a page writes itself beside the way in, with a line being finished, a diagram
 * being drawn from a sentence, and that diagram being dragged into shape. The
 * composition lives in `SignInScreen`, which the `signin-mock-*` routes render
 * with the other candidate treatments of the mark — one component, so what is
 * being compared is the only thing that differs.
 */
export default function SignInPage() {
  return <SignInScreen variant="centred" />;
}
