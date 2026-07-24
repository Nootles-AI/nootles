import { defineApp } from "convex/server";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config";

const app = defineApp();
// Collaborative sync for each page's block flow (BlockNote/ProseMirror).
app.use(prosemirrorSync);

export default app;
