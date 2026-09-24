import { BillingSettings } from "@/app/components/workspaces/settings/BillingSettings";

/**
 * What a workspace is on and what it has spent, and where Stripe sends an
 * admin back to. `?checkout=done|cancelled` is only the cue for a sentence —
 * whether the plan is live is read from the mirror, as on the plan screen.
 */
type BillingPageProps = {
  searchParams: Promise<{ checkout?: string | string[] }>;
};

export default async function WorkspaceBillingPage({ searchParams }: BillingPageProps) {
  const { checkout } = await searchParams;
  return <BillingSettings outcome={typeof checkout === "string" ? checkout : null} />;
}
