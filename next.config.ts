import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Hide the on-screen dev indicator so it doesn't overlap the bottom-left
  // project switcher. Compile/runtime errors are still surfaced.
  devIndicators: false,
  env: {
    // Build-time git SHA for Sentry releases and feedback reports.
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
  },
};

export default withSentryConfig(nextConfig, { silent: true });
