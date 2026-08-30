/**
 * Convex trusts tokens minted by this Clerk instance.
 *
 * `applicationID` matches the `aud` claim Clerk's Convex integration puts on the
 * session token — enabling that integration in the Clerk dashboard is what makes
 * the raw session token usable here, so there is no custom JWT template to keep
 * in sync.
 */
const authConfig = {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
    /**
     * The deployment itself, for operator stand-in sessions only.
     *
     * `convex/http.ts` serves the discovery document and JWKS, and
     * `impersonationMint.ts` holds the private half — so this trusts nothing
     * that isn't already inside this deployment. The issuer is read from the
     * built-in `CONVEX_SITE_URL` rather than configured, which is what keeps
     * dev and prod from ever accepting each other's tokens.
     *
     * A token from here always carries an `act` claim, and every write gate in
     * `auth.ts` refuses one. Trusting this issuer can only widen reads.
     */
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
