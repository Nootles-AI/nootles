import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { fontVariables } from "./fonts";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { TelemetryProvider } from "./components/TelemetryProvider";
import { UpdateToast } from "./components/UpdateToast";
import { StandInProvider } from "./components/StandIn";
import { IdentitySync } from "./components/IdentitySync";
import { NotionConfigProvider } from "./components/notion/NotionAvailable";
import { oauthConfig } from "./api/notion/oauth";

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
      className={`${fontVariables} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ClerkProvider>
          <ConvexClientProvider>
            <TelemetryProvider>
              <NotionConfigProvider oauth={oauthConfig() !== null}>
                <StandInProvider>
                  <IdentitySync>{children}</IdentitySync>
                </StandInProvider>
              </NotionConfigProvider>
              <UpdateToast />
            </TelemetryProvider>
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
