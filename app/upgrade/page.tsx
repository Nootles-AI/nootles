import type { Metadata } from "next";
import { Authed } from "@/app/components/Authed";
import { Upgrade } from "@/app/components/billing/Upgrade";

export const metadata: Metadata = {
  title: "Plan — Nootles",
};

/**
 * The plan screen, and where Stripe sends people back to. `?checkout=done` or
 * `?checkout=cancelled` is the only thing it reads off the URL — what actually
 * happened is decided by the webhook and read from the entitlement, because a
 * query string is something anyone can type.
 */
export default async function UpgradePage({ searchParams }: PageProps<"/upgrade">) {
  const { checkout } = await searchParams;
  return (
    <Authed>
      <Upgrade outcome={typeof checkout === "string" ? checkout : null} />
    </Authed>
  );
}
