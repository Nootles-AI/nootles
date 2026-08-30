import { defineApp } from "convex/server";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config";
import stripe from "@convex-dev/stripe/convex.config.js";

const app = defineApp();
// Collaborative sync for each page's block flow (BlockNote/ProseMirror).
app.use(prosemirrorSync);
// Checkout, the customer portal, and a synced copy of Stripe's own subscription
// state. It is NOT the source of truth for access — `entitlements.ts` is, and a
// subscription is one of the four things it consults.
app.use(stripe);

export default app;
