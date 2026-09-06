# Bank™

**Read-only access to your own bank accounts, for Claude.**

Bank™ is not a bank. It is a small open-source server you host yourself
(package name `openbanking-mcp`). It connects to your banks
through [Enable Banking](https://enablebanking.com), which wraps 2,700+
European banks in one PSD2 API, and exposes them to Claude as an MCP
connector. Read-only, no payments, no third party holding your data.

> "Has the invoice from Acme been paid?" · "What did we spend on groceries in
> August?" · "Which subscriptions am I paying for, and what do they cost per
> year?" · "Tell me when my balance drops below 5,000."

## How it works

```
Claude ──OAuth──▶ your Bank™ server ──JWT──▶ Enable Banking ──PSD2──▶ your bank
```

- **Claude** talks to your server as a custom connector. You sign in once with
  a password; tokens handle the rest.
- **Your server** holds the Enable Banking application key, the bank consents
  and your account ids. It never stores balances or transactions and sends no
  telemetry.
- **Enable Banking** is the licensed provider. You log in at your bank's own
  site to approve access; nobody sees your bank credentials.

## Setup

You need: an Enable Banking account (free), a place to run a container with a
public https URL, and 15 minutes.

### 1. Register an Enable Banking application

At <https://enablebanking.com/cp/applications> create an application:

- Environment: **Production** (your real accounts) or **Sandbox** (test data).
- Keep "generate private key" selected. A `.pem` file downloads; keep it safe.
- Redirect URL: `https://YOUR-HOST/callback`.
- Production asks for a description, a data-protection email and privacy and
  terms URLs. Use `https://YOUR-HOST/privacy` and `https://YOUR-HOST/terms`;
  the server serves both.

Note the application id (a UUID) shown after saving.

### 2. Deploy

Any container host works. Set these environment variables:

| Variable | Value |
|---|---|
| `EB_APP_ID` | the application id |
| `EB_PRIVATE_KEY` | the `.pem` contents, base64: `base64 -i app.pem \| tr -d '\n'` |
| `BASE_URL` | `https://YOUR-HOST` |
| `ADMIN_PASSWORD_HASH` | output of `npm run hash-password` (or set `ADMIN_PASSWORD`) |
| `DEFAULT_COUNTRY` | your country code, e.g. `DK` |
| `APP_NAME` | optional, the name shown on the sign-in and status pages (default `Bank™`) |

and mount a volume at `/data`. Optional: `NOTIFY_WEBHOOK_URL` for watch
notifications (a Slack incoming webhook works). Full list in
[.env.example](.env.example).

With Docker Compose on your own box:

```bash
cp .env.example .env    # fill it in
docker compose up -d
```

Put a TLS terminator in front (Caddy needs two lines:
`YOUR-HOST { reverse_proxy localhost:8080 }`). On Railway: create a project from this GitHub repo (the Dockerfile and
[railway.json](railway.json) are picked up automatically), add a volume
mounted at `/data`, set the variables above, and generate a public domain.
Fly.io works the same way with a volume and `fly secrets set`.

Open `https://YOUR-HOST/`. It shows what is still missing, or the connector URL
when everything is in place. `npm run check` does the same from a terminal and
also confirms the redirect URL is registered.

### 3. Add the connector in Claude

In claude.ai (or the desktop app): **Settings → Connectors → Add custom
connector**. Name it, paste `https://YOUR-HOST/mcp`, save, then click
**Connect**. Your server shows a password page; enter the admin password. That
is the only login you will do.

In Claude Code:

```bash
claude mcp add --transport http openbanking https://YOUR-HOST/mcp
```

then run `/mcp` inside Claude Code to sign in.

### 4. Connect your bank

In Claude, say **"connect my bank"** (or use the `connect-bank` prompt). Claude
looks up your bank, gives you a link, you log in at the bank and approve, and
the accounts appear. Consents last up to 180 days; Claude tells you when one
is about to expire and the same conversation renews it.

Give accounts labels ("Everyday", "Joint expenses", "Mortgage") when Claude
suggests them. Every tool accepts labels instead of ids.

## Going live with your own accounts

Enable Banking's production environment normally requires a contract, but it
has a **restricted mode** for accessing *your own* accounts, explicitly allowed
for individual non-commercial use. After registering a Production application:

1. On the (Inactive) application click **Activate by linking accounts**.
2. Log in at your bank and approve. Repeat for each bank you want.
3. The application becomes active and the API only ever returns accounts you
   linked this way.

Read the *Restriction of Use* section of Enable Banking's
[Terms of Service](https://enablebanking.com/terms-of-service/) before you
rely on it: restricted mode is for your own accounts, not for offering a
service to others. This project does not change those terms.

## What you get

**Tools** (all read-only):

| Tool | What it does |
|---|---|
| `list_banks`, `start_consent`, `consent_status`, `disconnect_bank` | connect and manage banks |
| `list_accounts`, `set_account_label` | accounts with booked balances; your own names for them |
| `get_balances` | booked and available balance for one account |
| `get_transactions` | signed amounts, one counterparty, one description; paginated |
| `create_watch`, `list_watches`, `delete_watch`, `check_watches` | background rules with webhook notifications |

**Prompts**: `connect-bank`, `monthly-summary`, `subscription-audit`,
`unusual-transactions`.

**Watches** run on the server. Rules: balance below or above an amount, a
single debit over an amount, an incoming or outgoing payment matching a name,
and "tell me if this payment has not arrived by this date". Accounts are
checked at most four times a day, the PSD2 limit for unattended access.
Notifications go to `NOTIFY_WEBHOOK_URL` as a Slack message or a JSON POST.

Enable Banking's own webhooks cover payment initiation only, so account data
is polled. There is no way around that under PSD2.

## Claude Code plugin

The repository is also a Claude Code plugin marketplace. The `openbanking` plugin
bundles the connector entry and a skill that encodes how to work with the
data: an account map, categorisation rules, the monthly review format and when
to create watches.

Point it at your server, then install:

```bash
export OPENBANK_URL=https://YOUR-HOST/mcp   # put this in your shell profile
```

```
/plugin marketplace add noskillish/openbankingmcp
/plugin install openbanking@openbanking
```

Then `/mcp`, select `bank`, Authenticate, and enter your password. No
organisation admin is involved; plugins are per user.

The skill lives at [plugin/skills/openbanking/SKILL.md](plugin/skills/openbanking/SKILL.md).
Copy it into your own skills to fill in the account map and your merchant
rules. The server stays generic; your rules stay yours.

## Running it on your own machine

The server can also run locally over stdio, with no OAuth, for Claude Code in
this directory. The repository ships a `.mcp.json` for that:

```bash
npm install
cp .env.example .env    # EB_APP_ID, EB_PRIVATE_KEY_PATH, ADMIN_PASSWORD
npm run dev             # http server, for the bank redirect
```

Production applications require an https redirect URL even locally. Create a
certificate with [mkcert](https://github.com/FiloSottile/mkcert), set
`TLS_CERT_PATH`, `TLS_KEY_PATH` and `BASE_URL=https://localhost:8080`, and
register `https://localhost:8080/callback` as a redirect URL.

## Security notes

- The server is a complete OAuth 2.1 authorization server with one user.
  Discovery, dynamic client registration and PKCE come from the MCP SDK;
  tokens are stored hashed; five wrong passwords lock an address out for
  fifteen minutes.
- State is one JSON file in `DATA_DIR`: consents, account ids, watches and
  OAuth tokens. Back it up if you care about not re-consenting; delete it to
  forget everything.
- Anyone with the admin password can read your accounts. Use a long one.
- There are no payment tools and none will be added. Payments need a
  licensed PISP and a very different security model.

## Commands

```bash
npm start              # http server (reads env from the environment)
npm run dev            # same, with reload and .env
npm run check          # verify config and the Enable Banking application
npm run hash-password  # produce ADMIN_PASSWORD_HASH
npm run watch -- --force   # run all watches once, print what fired
npm test               # unit tests (node:test)
npm run typecheck
```

Requires Node 24 or newer (runs TypeScript directly, no build step).

## Layout

```
src/server.ts         Express: /mcp behind OAuth, OAuth endpoints, /callback, status page
src/auth.ts           single-user OAuth provider, password login page
src/mcp.ts            McpServer factory (tools + prompts + instructions)
src/tools.ts          the MCP tools
src/prompts.ts        the MCP prompts
src/watcher.ts        background rule checks and notifications
src/enablebanking.ts  JWT signing and a thin typed API client
src/store.ts          the JSON state file
src/data.ts           shaping balances and transactions for an assistant
src/stdio.ts          local stdio entry point
src/cli.ts            check, hash-password, watch
plugin/               Claude Code plugin with the openbanking skill
```

## License

MIT
