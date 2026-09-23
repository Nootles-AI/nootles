import { describe, expect, test } from "vitest";
import { verifySvix } from "./svix";

/**
 * Svix's own worked example from its docs on verifying webhooks by hand,
 * which the reference `standardwebhooks` signer reproduces byte for byte.
 */
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TIMESTAMP = 1614265330;
const BODY = '{"test": 2432232314}';
const SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
const SENT = TIMESTAMP * 1000;
const MINUTE = 60 * 1000;

function headers(overrides: Record<string, string | null> = {}) {
  const all: Record<string, string | null> = {
    "svix-id": ID,
    "svix-timestamp": String(TIMESTAMP),
    "svix-signature": SIGNATURE,
    ...overrides,
  };
  return new Headers(
    Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

describe("verifySvix", () => {
  test("accepts Svix's worked example, with or without the secret's prefix", async () => {
    await expect(verifySvix(SECRET, headers(), BODY, SENT)).resolves.toBe(true);
    await expect(verifySvix(SECRET.slice(6), headers(), BODY, SENT)).resolves.toBe(true);
  });

  test("accepts one good signature among several, as during a rotation", async () => {
    const rotating = `v1,${btoa("stale")} v2,whatever ${SIGNATURE}`;
    await expect(
      verifySvix(SECRET, headers({ "svix-signature": rotating }), BODY, SENT),
    ).resolves.toBe(true);
  });

  test("refuses anything that changed what was signed", async () => {
    const cases: [Record<string, string>, string][] = [
      [{}, '{"test": 2432232315}'],
      [{ "svix-id": "msg_other" }, BODY],
      [{ "svix-timestamp": String(TIMESTAMP + 1) }, BODY],
      [{ "svix-signature": SIGNATURE.replace("v1,g", "v1,h") }, BODY],
      [{ "svix-signature": SIGNATURE.replace("v1,", "v2,") }, BODY],
    ];
    for (const [overrides, body] of cases) {
      await expect(verifySvix(SECRET, headers(overrides), body, SENT)).resolves.toBe(false);
    }
    await expect(
      verifySvix("whsec_" + btoa("another secret"), headers(), BODY, SENT),
    ).resolves.toBe(false);
  });

  test("refuses a delivery more than five minutes from now, either way", async () => {
    await expect(verifySvix(SECRET, headers(), BODY, SENT + 4 * MINUTE)).resolves.toBe(true);
    await expect(verifySvix(SECRET, headers(), BODY, SENT + 6 * MINUTE)).resolves.toBe(false);
    await expect(verifySvix(SECRET, headers(), BODY, SENT - 6 * MINUTE)).resolves.toBe(false);
    await expect(
      verifySvix(SECRET, headers({ "svix-timestamp": "soon" }), BODY, SENT),
    ).resolves.toBe(false);
  });

  test("refuses missing headers, and secrets or signatures that aren't base64", async () => {
    for (const name of ["svix-id", "svix-timestamp", "svix-signature"]) {
      await expect(verifySvix(SECRET, headers({ [name]: null }), BODY, SENT)).resolves.toBe(
        false,
      );
    }
    for (const secret of ["", "whsec_", "whsec_not base64!"]) {
      await expect(verifySvix(secret, headers(), BODY, SENT)).resolves.toBe(false);
    }
    await expect(
      verifySvix(SECRET, headers({ "svix-signature": "v1,not base64!" }), BODY, SENT),
    ).resolves.toBe(false);
  });
});
