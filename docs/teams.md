# Teams: confirming who someone is

An invitation opens only for the address it was sent to, and a join domain lets
in only people whose address is on it. Both read `auth.verifiedEmail`, so each
deployment needs one of the two setups below. Without either, nobody's address
can be confirmed: invitations say “We couldn’t confirm your email address”,
join domains let nobody in, and workspace people show as “Someone”.

Clerk's default session token names the account (`sub`) and nothing else — no
email, no name, no picture.

## Either: give Convex the Clerk secret key (recommended)

Set it on **each** deployment, dev and prod, from that Clerk instance's
dashboard (API keys → Secret keys):

```
npx convex env set CLERK_SECRET_KEY sk_test_…          # dev
npx convex env set CLERK_SECRET_KEY sk_live_… --prod   # prod
```

Once per signed-in session the app calls `identity.sync`, which asks Clerk's
Backend API (`GET /v1/users/{id}`) for the account's **primary** address and
stamps it only if Clerk marks it verified, with the name and picture. A stamp
is trusted for a day before Clerk is asked again, so this is at most one Clerk
call per active account per day. If Clerk is down, the previous stamp stands.

## Or: put the claims in the token

Customise the token Convex receives — Clerk dashboard → Sessions → Customize
session token (or the `convex` JWT template, on an instance without the Convex
integration) — so it carries:

```json
{
  "email": "{{user.primary_email_address}}",
  "email_verified": "{{user.email_verified}}",
  "name": "{{user.full_name}}",
  "picture": "{{user.image_url}}"
}
```

`email_verified` is not optional: a token with an `email` and no
`email_verified` is taken at its word. When the token carries an address,
`identity.sync` stamps it without calling Clerk, and `CLERK_SECRET_KEY` is not
needed.
