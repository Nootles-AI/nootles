# The Nootles GitHub App

Workspaces read their code through a GitHub App that the workspace owns. The
OAuth App (`GITHUB_CLIENT_ID` and the Connect GitHub button) stays as it is:
personal projects keep reading with each person's own connection, and members
still use it to prove the organisation rule (§5).

The code does nothing until the variables below are set. Until then the
workspace's integrations screen says the App isn't set up on this deployment,
and everything else keeps working.

## 1. Register the App

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub
App**. For a company deployment, register it under the organisation that runs
Nootles.

- **Homepage URL**: the app's origin, e.g. `https://nootles.app`.
- **Callback URL**: `https://<app origin>/api/github/app/setup`.
- **Request user authorization (OAuth) during installation**: **on**. This is
  what lets us check an installation (§3), so it isn't optional.
- **Setup URL**: when the option above is on, GitHub greys this field out and
  sends the browser to the callback URL after an install. If the field is
  still editable, set it to the same `/api/github/app/setup`.
- **Webhook**: active. The URL is the Convex **site** URL (`…convex.site`, not
  `…convex.cloud`) followed by `/github/webhook`. Set the secret to a random
  string, for example `openssl rand -hex 32`.
- **Repository permissions**: Contents **read-only**, Metadata **read-only**.
- **Organization permissions**: Members **read-only**. The organisation rule
  needs this.
- **Subscribe to events**: Push, Installation (sent automatically),
  Installation repositories, Organization (member removed), and Member.
- **Where can this GitHub App be installed?** Any account.

After you create it, make a **client secret** and a **private key**. GitHub
gives you the key as a PKCS#1 PEM file. Convert it to one line (the reason is
in §2):

```
openssl pkcs8 -topk8 -nocrypt -in key.pem -outform der | base64
```

## 2. Environment

On the **Convex** deployment (`npx convex env set --prod …`; without `--prod`
you are writing to dev):

| Name | What it is |
|---|---|
| `GITHUB_APP_ID` | The App ID on the App's settings page. It is a number, not the client ID. |
| `GITHUB_APP_PRIVATE_KEY` | The base64 PKCS#8 DER from §1. It is DER rather than PEM because a multi-line PEM gets mangled on the way into an env var (`impersonationMint.ts` has already failed that way once). |
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret from §1. |
| `GITHUB_APP_CLIENT_ID` | The App's client ID (`Iv…`). |
| `GITHUB_APP_CLIENT_SECRET` | The App's client secret. |
| `GITHUB_APP_SLUG` | The App's URL name, as in `github.com/apps/<slug>`. The install route builds its link from it. |
| `GITHUB_TOKEN_KEY` | Already set for the OAuth App. Installation tokens are sealed with this key too. |

Next needs nothing of its own for the App. The slug lives in Convex so that
one answer (`github/app.status.ready`) decides everywhere whether an Install
button is offered, and the install route reads the slug from that same answer.
The authorization code is exchanged inside Convex (§3), because the Convex
action that records an installation can be called directly, so it has to make
its own check.

## 3. Installing, and why it is verified

1. An admin presses **Install** in the workspace's integrations settings. That
   opens `/api/github/app/install?workspace=<id>`, which checks that they are
   an admin. It then sets an httpOnly cookie that ties `{state, workspace,
   user}` together, and redirects to `github.com/apps/<slug>/installations/new?state=…`.
2. GitHub installs the App and asks the admin to authorise it. It then sends
   the browser to `/api/github/app/setup` with `installation_id`, `code` and
   `state`.
3. The setup route checks that the cookie's state and user match. It then calls
   `github/app.install` as that user.
4. `install` checks again that the user is an admin, and exchanges `code` for a
   token that acts as that GitHub user. It then requires `installation_id` to
   be in that user's `GET /user/installations`, and the user to hold the
   installation's account: for a personal account, `GET /user` has to be that
   login; for an organisation, `GET /user/memberships/orgs/{org}` has to say
   an active admin. Only after that does it record the installation
   (`githubInstallations`), and the admin check runs a final time in the
   transaction that writes the row.

GitHub puts `installation_id` on the URL, and anyone can type one. Being able
to reach it isn't enough either: GitHub lists an organisation's installation
for any member who can read one repository it covers, and the installation's
token reads all of them. Without the last step, anyone could attach another
organisation's installation to their own workspace.

## 4. Reading code

- A repository chosen from the App's list is linked with `installationId`
  set, and read with an installation token. The token is minted with the App's
  RS256 JWT (`github/appAuth.ts`, in Node) and cached sealed on the
  installation row. When it has less than five minutes left, a new one is
  minted. If GitHub answers 401, the cache is skipped and the call is retried
  once.
- The App's list is every repository the installation reads, page after
  page (up to 3,000). One installation GitHub refuses leaves the others
  listed; the list fails only when every one does.
- Every other repository is read with the connection of the person who linked
  it, as before. While personal connections are allowed, the pickers offer
  the member's own repositories beside the App's — the App's row wins where
  both reach one — and look one up by owner/name with their connection. `github/credential.ts` is the one place that decides which
  applies, for the read tools, the summary and the indexer alike.
- If the installation is uninstalled or suspended, its repositories fail and
  the reason is shown on the row — from the webhook's mark, or, before that
  lands, from GitHub refusing to mint the installation's token.
- **`settings.allowPersonalTokens`** is absent, which means allowed, for every
  workspace, including new ones. It defaults to allowed so that nothing linked
  before an admin installs the App stops working. The integrations screen
  recommends installing the App, and then offers to turn personal
  connections off. Once they are off, a repository without an installation
  can't be linked, and one linked before is no longer read.
- Anyone who manages the project renames, re-indexes and unlinks its
  repositories, not only the person who linked them. When a member is
  removed, the repositories they linked with their own connection are
  unlinked. Repositories read through the App stay.

## 5. The organisation rule

`settings.requireGithubOrg` is set by an admin (`github/app.setOrgRule`) and
must name an organisation the App is installed on. While it is set, a member
reads the workspace's code only if they have proved in the last 14 days that
they belong to that organisation (`auth.passesGithubOrgRule`). This applies to
owners and admins too; guests are covered by their own grant. The same
proof gates listing the App's repositories (`auth.requireGithubCodeSeat`),
since their names and descriptions are the organisation's too.

To prove it, a member presses **Verify GitHub membership**. That runs
`github/orgProof.verify`, which uses the member's own OAuth connection (it has
`read:org`) to call `GET /user/memberships/orgs/<org>`. An `active` answer
records their login and the time. Nothing calls GitHub when a page loads.
When the organisation's webhook reports that a login was removed, that
member's proof is cleared. Moving the rule to a different organisation clears
everyone's proof.

## 6. Webhook

`convex/http.ts` handles `POST /github/webhook`. It checks
`X-Hub-Signature-256` against the raw body using HMAC-SHA256 and a
constant-time comparison. A missing or wrong signature gets a 401. Deliveries
are idempotent, and events the App doesn't use get a 200.

| Event | Effect |
|---|---|
| `push` | Each repository linked through that installation whose default branch was pushed gets re-indexed. The re-index is debounced to at most one per repository every 10 minutes. |
| `installation` `deleted` | The installation is marked removed. Its repositories are unlinked, and their graph is forgotten. |
| `installation` `suspend` / `unsuspend` | The installation is marked suspended, or the mark is cleared. |
| `installation_repositories` `removed` | The repositories that were removed are unlinked wherever they were read through that installation. |
| `organization` `member_removed` | The organisation proof is cleared for members who proved it with that login. |
