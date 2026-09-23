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

When a signed-in session starts, and when a tab comes back into view an hour
or more later, the app calls `identity.sync`. That asks Clerk's Backend API
(`GET /v1/users/{id}`) for the account's **primary** address and stamps it
only if Clerk marks it verified, with the name and picture. A verified stamp
is trusted for a day before Clerk is asked again. Whatever Clerk answered —
including "no verified address" — an account is not asked about again within
a minute of the last ask, or within five seconds of one Clerk never answered.
However often its client calls, an account costs at most one Clerk call a
minute while Clerk answers, and one every five seconds while it doesn't. An account with a verified address typically costs one a day. If Clerk
is down, the previous stamp stands; with no previous stamp, `identity.sync`
says it got no answer, and the app retries a couple of times before offering
"Try again".

The account's own app decides whether it calls `identity.sync`, so the
re-check is the app's courtesy, not a guarantee. What is enforced is an upper
bound: an address Clerk has not vouched for in **three days** admits nobody.
Accepting an invitation, joining by domain and adding a join domain all
refuse it, and an hourly job (`identity.expire`) takes it off the stamp so
the pages stop offering those doors too.

### And the Clerk webhook (recommended with the secret key)

Without it, an address removed from a Clerk account, or replaced as its
primary, keeps admitting the account for up to those three days, whether the
account changed it or an operator did. The webhook makes the change count
at once. In the Clerk dashboard (Webhooks → Add endpoint), for each instance:

- **Endpoint URL:** the deployment's HTTP actions URL plus `/clerk/webhook`,
  for example `https://<deployment>.convex.site/clerk/webhook`
- **Events:** `user.created`, `user.updated`, `user.deleted`

Then give Convex the endpoint's signing secret:

```
npx convex env set CLERK_WEBHOOK_SECRET whsec_…          # dev
npx convex env set CLERK_WEBHOOK_SECRET whsec_… --prod   # prod
```

The handler checks Svix's signature and refuses anything it can't verify. It
treats an event only as a signal to ask Clerk again, and stamps Clerk's
current answer rather than the event's contents, because deliveries can
arrive late and out of order. A deleted account's address is dropped
outright. If Clerk doesn't answer, the handler returns 503 and Svix delivers
the event again later.

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
