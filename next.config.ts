import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the on-screen dev indicator so it doesn't overlap the bottom-left
  // project switcher. Compile/runtime errors are still surfaced.
  devIndicators: false,
};

export default nextConfig;
