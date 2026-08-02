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
  ],
};

export default authConfig;
