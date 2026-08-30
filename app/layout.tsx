import type { Metadata } from "next";
import { Caveat, Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { TelemetryProvider } from "./components/TelemetryProvider";
import { UpdateToast } from "./components/UpdateToast";
import { StandInProvider } from "./components/StandIn";

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

export const metadata: Metadata = {
  title: "Nootles",
  description: "An AI-native planning surface — notes, canvas, and an ambient copilot.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${caveat.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ClerkProvider>
          <ConvexClientProvider>
            <TelemetryProvider>
              <StandInProvider>{children}</StandInProvider>
              <UpdateToast />
            </TelemetryProvider>
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
