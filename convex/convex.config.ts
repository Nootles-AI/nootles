import { defineApp } from "convex/server";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import stripe from "@convex-dev/stripe/convex.config.js";

const app = defineApp();
// Collaborative sync for each page's block flow (BlockNote/ProseMirror).
app.use(prosemirrorSync);
// The admission authority's storage: token buckets and fixed windows, keyed
// per user and per lane. `requestLimits.ts` is the only module that reads it —
// nothing calls that module yet, so mounting this changes no behavior.
app.use(rateLimiter);
// Checkout, the customer portal, and a synced copy of Stripe's own subscription
// state. It is NOT the source of truth for access — `entitlements.ts` is, and a
// subscription is one of the four things it consults.
app.use(stripe);

export default app;
