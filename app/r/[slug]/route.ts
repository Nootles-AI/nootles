import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import {
  DEFAULT_DESTINATION,
  REF_COOKIE,
  clickSecret,
  formatRef,
  isAllowedDestination,
  normalizeAffiliateSlug,
  parseRef,
  signClick,
} from "@/convex/affiliateRules";
import { requireConvexDeploymentUrl } from "@/app/lib/convexDeploymentUrl";
import { REF_MAX_AGE_S, refFromCookies } from "@/app/lib/affiliateRef";

/**
 * An affiliate's link, `/r/<slug>`: count the click, leave the `nt_ref`
 * cookie that lets the account it turns into be attributed, and send the
 * visitor on to the affiliate's destination.
 *
 * Public (`proxy.ts`), and so signed out: the click comes before any account.
 * That is why it is signed with `AFFILIATE_CLICK_SECRET`, which only this
 * server and Convex hold — `affiliates.recordClick` is a public mutation, and
 * the signature makes every click it counts one that came through here. It
 * does not make a click a person's: anyone can still fetch the link in a
 * loop, and each fetch counts. That skews clicks and visitors only — an
 * attribution still needs a new account — and link previews, the common
 * case, are not counted (`automated`).
 *
 * Whatever goes wrong, the visitor still lands somewhere: an unknown slug, a
 * Convex that is down or contended, or a destination this side does not
 * recognise all end at `DEFAULT_DESTINATION`.
 */

type Context = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Context) {
  // A browser fetching the link speculatively has not been clicked yet, and
  // a redirect it keeps would carry the visitor past the count and the cookie
  // when the click does come. Refused, the prefetch is dropped and the real
  // navigation comes here.
  if (prefetching(request)) {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return await follow(request, (await params).slug, !automated(request));
}

/**
 * A link checker asking where the link goes: told, but nothing is counted and
 * no cookie is left. Declared rather than left to Next, which would otherwise
 * answer HEAD by running GET.
 */
export async function HEAD(request: Request, { params }: Context) {
  return await follow(request, (await params).slug, false);
}

function prefetching(request: Request): boolean {
  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`;
  return /\bprefetch\b/i.test(purpose);
}

/**
 * A crawler, or the preview a chat app or social site fetches the moment a
 * link is posted — before anyone has clicked it — by the names they give
 * themselves: `Googlebot/`, `Slackbot-LinkExpanding`, `TelegramBot`,
 * `facebookexternalhit` (also iMessage's), `WhatsApp/`. Narrow on purpose:
 * an in-app browser (Instagram's, TikTok's) is a person clicking, and a phone
 * model can end in "bot".
 */
const AUTOMATED =
  /bot[/-]|telegrambot|facebookexternalhit|facebot|^whatsapp\/|skypeuripreview|embedly|crawler|spider|^curl\/|^wget\//i;

function automated(request: Request): boolean {
  return AUTOMATED.test(request.headers.get("user-agent") ?? "");
}

async function follow(request: Request, raw: string, click: boolean): Promise<Response> {
  const slug = normalizeAffiliateSlug(raw);
  const now = Date.now();
  // One visitor per browser, whichever link they came by last: that is what
  // makes a second click a returning visitor rather than a new one.
  const visitorId =
    parseRef(refFromCookies(request.headers.get("cookie")) ?? "")?.visitorId ??
    crypto.randomUUID();
  // Without a signature the call only asks where the link goes; Convex
  // counts nothing it cannot verify.
  const secret = click ? clickSecret(process.env.AFFILIATE_CLICK_SECRET) : null;

  let destination = DEFAULT_DESTINATION;
  let counted = false;
  if (slug) {
    try {
      const signature = secret
        ? await signClick(secret, { slug, visitorId, signedAt: now })
        : "";
      const convex = new ConvexHttpClient(
        requireConvexDeploymentUrl(process.env.NEXT_PUBLIC_CONVEX_URL),
      );
      ({ destination, counted } = await convex.mutation(api.affiliates.recordClick, {
        slug,
        visitorId,
        signedAt: now,
        signature,
      }));
    } catch (error) {
      console.error(`[affiliates] click on ${slug} not recorded:`, error);
    }
  }

  // Convex already refuses a destination off our own sites; asked again here
  // because this is the line that actually redirects.
  const response = NextResponse.redirect(
    isAllowedDestination(destination) ? destination : DEFAULT_DESTINATION,
  );
  response.headers.set("Cache-Control", "no-store");
  // Only a counted click moves the cookie. Last click wins, so each one
  // rewrites it — but one that cannot be attributed (an unknown or disabled
  // link, a secret the two sides disagree on) must not replace one that can.
  if (slug && secret && counted) {
    response.cookies.set(REF_COOKIE, formatRef({ slug, visitorId, clickedAt: now }), {
      // Not httpOnly: the claim effect reads it in the browser, and clears it.
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: REF_MAX_AGE_S,
    });
  }
  return response;
}
