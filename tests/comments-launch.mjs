/**
 * The browser every comment harness drives. Locally that is system Chrome
 * (`channel: "chrome"`); CI has no Chrome and sets
 * `COMMENTS_BROWSER_CHANNEL=chromium`, Playwright's own build, as the canvas
 * job does. `COMMENTS_CHROME_PATH` points at any other executable.
 */
export async function launchBrowser() {
  const { chromium } = await import("playwright");
  const channel = process.env.COMMENTS_BROWSER_CHANNEL || "chrome";
  return chromium.launch({
    headless: true,
    ...(process.env.COMMENTS_CHROME_PATH ? { executablePath: process.env.COMMENTS_CHROME_PATH } : { channel }),
  });
}
