"use client";

import { LinkPreview } from "@/app/components/LinkPreview";

/**
 * Demo page showcasing the LinkPreview component.
 * Layout matches the location card pattern: text on left, image on right like a pin.
 */
export default function LinkDemoPage() {
  return (
    <div style={{ maxWidth: "600px", margin: "0 auto", padding: "40px 16px" }}>
      <h1 style={{ fontSize: "30px", marginBottom: "8px", fontWeight: 600 }}>
        Link Card
      </h1>
      <p style={{ color: "var(--muted)", marginBottom: "40px" }}>
        Rich link previews with title, subtitle, and image (like a map pin).
      </p>

      <div style={{ marginBottom: "32px" }}>
        <h2 style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          With Full Metadata
        </h2>
        <LinkPreview
          href="https://www.wikipedia.org/wiki/Artificial_intelligence"
          title="Artificial Intelligence"
          subtitle="From Wikipedia, the free encyclopedia"
          image="https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/240px-Cat03.jpg"
        />
      </div>

      <div style={{ marginBottom: "32px" }}>
        <h2 style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Title and Subtitle (No Image)
        </h2>
        <LinkPreview
          href="https://github.com/torvalds/linux"
          title="Linux Kernel Repository"
          subtitle="Official Linux kernel source code and development"
        />
      </div>

      <div style={{ marginBottom: "32px" }}>
        <h2 style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Beautiful Images
        </h2>
        <LinkPreview
          href="https://unsplash.com/photos/forest"
          title="Misty Forest Path"
          subtitle="Unsplash Photography"
          image="https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=240&h=180&fit=crop"
        />
      </div>

      <div style={{ marginBottom: "32px" }}>
        <h2 style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Minimal (Domain Only)
        </h2>
        <LinkPreview href="https://example.com/some/long/path/to/article" />
      </div>

      <div>
        <h2 style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Multiple Links in Sequence
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <LinkPreview
            href="https://react.dev"
            title="React"
            subtitle="A JavaScript library for building UIs"
            image="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%2361DAFB'/%3E%3C/svg%3E"
          />
          <LinkPreview
            href="https://nextjs.org"
            title="Next.js"
            subtitle="The React Framework for Production"
            image="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23000'/%3E%3Ctext x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='%23fff' font-weight='bold' font-size='20'%3EN%3C/text%3E%3C/svg%3E"
          />
          <LinkPreview
            href="https://tailwindcss.com"
            title="Tailwind CSS"
            subtitle="Utility-first CSS framework"
          />
        </div>
      </div>
    </div>
  );
}
