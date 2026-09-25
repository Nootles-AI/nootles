import { Caveat, Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The one face in the app that is not the UI's. It is the storyboard's writing
 * hand, and available on any shape through the style panel — nothing else uses
 * it, which is why it loads one weight and no italic.
 */
const caveat = Caveat({
  variable: "--font-hand",
  subsets: ["latin"],
  weight: ["500"],
});

/** The root `<html>`'s font classes; `global-error` replaces that element and needs them too. */
export const fontVariables = `${geistSans.variable} ${geistMono.variable} ${caveat.variable}`;
