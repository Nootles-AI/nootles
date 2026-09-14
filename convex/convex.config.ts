import { defineApp } from "convex/server";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import stripe from "@convex-dev/stripe/convex.config.js";

const app = defineApp();
// Collaborative sync for each page's block flow (BlockNote/ProseMirror).
app.use(prosemirrorSync);
// Token buckets and fixed windows, for two readers. `requestLimits.ts` is the
// admission authority, keyed per user and per lane, that the AI routes consult.
// `notion/pacing.ts` is the queue each Notion connection's requests wait in.
app.use(rateLimiter);
// Checkout, the customer portal, and a synced copy of Stripe's own subscription
// state. It is NOT the source of truth for access — `entitlements.ts` is, and a
// subscription is one of the four things it consults.
app.use(stripe);

export default app;
