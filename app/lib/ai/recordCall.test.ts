import { getFunctionName } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import { afterEach, describe, expect, test, vi } from "vitest";
import { verifyCall } from "@/convex/ai/callSignature";
import { recordAiCall } from "./recordCall";

/**
 * The route's half of the ledger's signature: what it sends is what Convex
 * checks (`convex/ledger.test.ts` is the other half). Signed for the session's
 * own user, over the cost worked out here, and only with the secret set.
 */

const SECRET = "a-shared-ledger-secret";

afterEach(() => vi.unstubAllEnvs());

/** A client that remembers what it was asked to write. */
function client() {
  const mutation = vi.fn(async (..._args: unknown[]) => null);
  return { convex: { mutation } as unknown as ConvexHttpClient, mutation };
}

const CALL = {
  feature: "chat" as const,
  model: "not-a-priced-model",
  projectId: "p1",
  promptTokens: 1000,
  completionTokens: 200,
  latencyMs: 12,
  status: "ok" as const,
};

async function sent(mutation: ReturnType<typeof client>["mutation"]) {
  await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
  const [ref, args] = mutation.mock.calls[0] as [never, Record<string, unknown>];
  expect(getFunctionName(ref)).toBe("ai/calls:record");
  return args;
}

describe("recordAiCall", () => {
  test("signs the row for the session's user, in a form Convex verifies", async () => {
    vi.stubEnv("AI_LEDGER_SECRET", `${SECRET}\n`);
    const { convex, mutation } = client();
    recordAiCall(convex, { ownerId: "user_1", ...CALL });
    const args = await sent(mutation);

    expect(args).not.toHaveProperty("ownerId");
    expect(args).toMatchObject({ ...CALL, signedAt: expect.any(Number) });
    const row = { ...(args as typeof CALL), signedAt: args.signedAt as number };
    expect(await verifyCall(SECRET, { ownerId: "user_1", ...row }, args.signature as string)).toBe(
      true,
    );
    // Bound to its user: the same row is nobody else's.
    expect(await verifyCall(SECRET, { ownerId: "user_2", ...row }, args.signature as string)).toBe(
      false,
    );
  });

  test("records unsigned without the secret, or without a user to sign for", async () => {
    for (const [secret, ownerId] of [
      ["", "user_1"],
      [SECRET, null],
    ] as const) {
      vi.stubEnv("AI_LEDGER_SECRET", secret);
      const { convex, mutation } = client();
      recordAiCall(convex, { ownerId, ...CALL });
      const args = await sent(mutation);
      expect(args).not.toHaveProperty("signature");
      expect(args).not.toHaveProperty("signedAt");
      expect(args).toMatchObject(CALL);
    }
  });
});
