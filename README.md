# Dabba

A private, single-user financial cockpit that runs on your own machine. It
connects to your banks through the [Enable Banking](https://enablebanking.com)
open-banking API, keeps everything in a local SQLite file, and runs your
household like a small business: a P&L, a balance sheet, a cash-flow forecast,
and a weekly CFO briefing.

Nothing leaves your computer except the calls to Enable Banking (and, if you
opt in, anonymous merchant strings to the Claude API for categorization). You
log in at your bank's own site during authorization; the app never sees your
bank credentials.

## What it does

- **Accounts & net worth** — all linked accounts, assets minus liabilities,
  daily history reconstructed from the banks' running balances.
- **Ledger** — internal transfers between your own accounts are netted out;
  every transaction gets a category from ~350 built-in rules for Danish
  merchants, your own rules, or (optionally) Claude for the long tail.
- **P&L** — monthly income, expenses by category, net and savings rate;
  budgets per category.
- **Three scopes** — *Household* (all accounts, transfers between your own
  accounts netted), *Me* (personal accounts; what you send to shared accounts
  counts as a cost, what comes back as a reimbursement) and *Shared accounts*
  (the joint accounts; both partners' transfers are the funding). Set an
  account's owner to personal/joint on its card.
- **This month** — where the month closes (income so far + expected, spent so
  far + bills due + everyday spend at the usual pace), the big spends, lumpy
  quarterly bills with a monthly reserve, and the savings-rate gap to your
  target with the levers that close it.
- **Spending overview** — where the money goes, what's trending up, what
  subscriptions cost per year, and a ranked list of where to cut.
- **Recurring** — rent, subscriptions, salary and other regular items detected
  automatically, with next expected date and yearly cost.
- **Forecast & runway** — projected liquid balance for 90 days from recurring
  items plus baseline spending; months of runway at current burn.
- **Weekly briefing** — Monday morning summary with anomalies (duplicates,
  unusually large charges, new merchants), upcoming bills, budget status and
  the top cuts. Optional Slack delivery and an AI-written narrative.
- **MCP server** — ask Claude Code questions against your real ledger.
- **Privacy mode** — one key (P) masks every amount, name and account number.

## Requirements

- Node.js 24 or newer (uses the built-in `node:sqlite` and TypeScript support)
- An Enable Banking account
- macOS for the launchd schedule (everything else is portable)

## Setup

1. Create a locally trusted certificate for `localhost` (Enable Banking only
   accepts `https://` redirect URLs for production applications). This uses
   [mkcert](https://github.com/FiloSottile/mkcert); `mkcert -install` asks for
   your password once to trust its local CA in the system keychain:

   ```bash
   brew install mkcert && mkcert -install && npm run cert
   ```

2. Register an application at <https://enablebanking.com/cp/applications>:
   - Environment: **Sandbox** to test, **Production** for your real accounts
     (see *Going live* below)
   - Keep the default "generate private key" option; a `.pem` file downloads
   - Redirect URL: `https://localhost:3000/callback`
   - Note the application id (a UUID) shown after saving

3. Put the key and id in place:

   ```bash
   mv ~/Downloads/<app-id>.pem secrets/enablebanking.pem
   cp .env.example .env   # then set EB_APP_ID
   ```

4. Install and run:

   ```bash
   npm install
   npm run dev
   ```

5. Open <https://localhost:3000>, click **Connect bank**, pick a bank and log in.

## Going live with your own accounts

Enable Banking's production environment normally requires a contract, but it
offers a **restricted mode** for linking *your own* bank accounts, explicitly
allowed for individual non-commercial use:

1. Register an application with environment **Production**. It also asks for a
   description, a data-protection email, and privacy-policy and terms-of-service
   URLs; the app serves suitable pages at `https://localhost:3000/privacy` and
   `https://localhost:3000/terms`, and these are not verified for restricted-mode
   activation.
2. On the new (Inactive) application click **Activate by linking accounts**,
   log in at your bank and approve. Repeat for every account you want — the API
   only ever returns accounts you linked.
3. Point `.env` at the production app id and key and restart.

Consents last up to 180 days for most banks; the dashboard shows the days left
and you reconnect the bank when it runs out.

## Commands

```bash
npm run dev          # web app with reload
npm run sync         # fetch from the banks and rebuild the ledger
npm run process      # rebuild the ledger only (add -- --reset to re-derive everything not set by hand)
npm run briefing     # generate the weekly briefing (posts to BRIEFING_WEBHOOK_URL if set)
npm run schedule     # install launchd jobs: sync daily 07:00, briefing Mondays 07:30 (-- remove to uninstall)
npm run mcp          # MCP server over stdio
```

## Optional integrations (`.env`)

- `ANTHROPIC_API_KEY` — Claude categorizes merchants the rules don't know and
  writes a short narrative for the briefing.
- `BRIEFING_WEBHOOK_URL` — a Slack incoming-webhook URL; Monday's briefing is
  posted there.

## Ask your ledger from Claude Code

The project ships a `.mcp.json`, so opening this directory in Claude Code
exposes tools like `pnl`, `spending_overview`, `search_transactions`,
`forecast`, `recurring`, `anomalies` and a read-only `query_sql`. Ask things
like "what did we spend on eating out in August, split by account?" and get an
answer from your real numbers.

## Layout

```
src/config.ts         environment + setup checks
src/enablebanking.ts  JWT signing and a thin typed API client
src/db.ts             SQLite schema, migrations and core queries
src/sync.ts           pull balances/transactions, then run the pipeline
src/pipeline.ts       transfers → rules → AI → recurring → snapshots
src/categories.ts     chart of accounts and built-in rules
src/categorize.ts     rule engine, manual overrides, Claude fallback
src/transfers.ts      internal-transfer pairing
src/recurring.ts      recurring-payment detection
src/analytics.ts      net worth, P&L, spending overview, forecast, anomalies
src/briefing.ts       weekly briefing (facts → markdown → optional narrative)
src/schedule.ts       launchd install/remove
src/server.ts         Fastify routes: UI, connect flow, JSON API
src/cli.ts            command line entry points
src/mcp.ts            MCP server
public/index.html     the dashboard (vanilla JS, inline SVG charts)
```

The server binds to `127.0.0.1` only. There is no login, so do not expose it to
a network.
