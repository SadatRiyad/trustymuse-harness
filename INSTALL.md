# Install TrustyMUSE Harness

New here? Start with `docs/GETTING-STARTED.md` for a complete beginner
walkthrough, then `docs/USER-GUIDE.md` for every command,
`docs/FAQ.md` for common questions, and `docs/TROUBLESHOOTING.md` when
something fails. The full index is in `docs/README.md`.

TrustyMUSE Harness V1.8. Local only, multi-tenant. One install serves
many Muse accounts, each tenant fully isolated. There is no central
server and no public Muse account API in V1.4. Each Muse account runs
its own copy of the harness in its own Muse workspace.

## Who this is for

Any Muse user who wants TrustyMUSE to route work to their own chat AI
normal accounts, keep every job under a budget cap and a policy gate,
and connect their own projects to it. Nine subscription models connect
with a Connect button and no API key: chatgpt, claude, gemini, grok,
deepseek, perplexity, meta-ai, copilot, mistral. Packet mode works for
every connected one. The browser driver is wired only for chatgpt and
claude; the rest are packet-only for now. See `docs/V1-5-MODELS.md`.

## Install

```bash
git clone https://github.com/SadatRiyad/trustymuse-harness.git
cd trustymuse-harness
npm install
npm test
```

All test suites must pass before you use it. V1.8 runs 102 test groups:
V1 7, browser 10, live driver 9, projects 12, tenants 14, models 15, connection 15, model-connect 9, analytics 11.

If Chromium is missing for browser mode, install it with:

```bash
TMPDIR=~/tmp npx playwright install chromium
```

(The TMPDIR prefix matters on machines where /tmp is small. The V1.2
install failed repeatedly on a 512M /tmp until the download was moved.)

You can also run it as a CLI after linking:

```bash
npm link
trustymuse-harness status
```

## Set up your own tenant (5 steps)

One tenant is one Muse account. Run the setup wizard once:

```bash
node dist/index.js setup --id <your-id> --name "<Your Name>"
```

For example: `node dist/index.js setup --id jane-doe --name "Jane Doe"`.

Setup creates your tenant, writes config.yaml from config.example.yaml
when one is missing, and makes your tenant the default. It never asks
for a password or an API key. Then:

1. Connect your own chat AI models (no API key, packet mode works at once):
   `node dist/index.js model-connect --model gemini`
   `node dist/index.js model-connect --model grok`
   All nine models start disconnected for a fresh tenant. Connect each
   one you want with model-connect.
2. For browser mode only (chatgpt and claude only, the rest are
   packet-only), add a browser account, log in once by hand in that
   profile, in your own browser, then verify it with browser-connect.
   The harness never asks for your password:
   `node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT"`
   `node dist/index.js browser-connect --account main`
   Check it with `node dist/index.js browser-status`, and stop it any
   time with `node dist/index.js browser-disconnect --account main`.
   Disconnect never deletes the profile and never logs you out of the
   site, so you can reconnect later with browser-connect.
3. Connect your own project:
   `node dist/index.js project-add --id my-project --name "My Project" --kind web-app --path ~/workspace/my-project`
4. Run your first job:
   `node dist/index.js packet --model chatgpt --type seo --title "First task" --task "Write a draft." --project my-project`
5. Check the audit log:
   `node dist/index.js audit`

## What is per tenant, and what is shared

Shared: only the code. One install, one `dist/`, one `config.yaml`,
one model registry, one router.

Per tenant, never shared: state, budget, accounts, projects, browser
profiles, packets, browser results, and the audit log.

```
state/tenants/<tenantId>/audit.jsonl
state/tenants/<tenantId>/usage.json
state/tenants/<tenantId>/accounts.json
state/tenants/<tenantId>/projects.json
state/tenants/<tenantId>/models.json
profiles/<tenantId>/chatgpt-main/
packets/<tenantId>/
browser-results/<tenantId>/
```

A job scoped to tenant A cannot see tenant B's projects, accounts, or
audit events. The tenant id is part of every audit event. Budget is per
tenant: each tenant has its own monthly cap (default 0) and its own
usage. The registry at `state/tenants.json` holds only tenant ids,
display names, labels, and status, no tenant data.

## Switching tenants

```bash
node dist/index.js tenant-use --id jane-doe   # make it the default
node dist/index.js status --tenant jane-doe   # one command, another tenant
TRUSTYMUSE_TENANT=jane-doe node dist/index.js status
```

Resolution order: `--tenant` flag, then `TRUSTYMUSE_TENANT`, then
`tenants.default` in config.yaml, then `default`. An unknown, paused,
or corrupt tenant fails closed before any state is read or written.

## Migrating an older single-user install

If you already ran V1.3 or earlier, your state lives flat under
`state/` (projects.json, audit.jsonl, usage.json, accounts.json) and
`profiles/`. Migrate it once:

```bash
node dist/index.js tenant-migrate
```

It copies everything into the `sadat-riyad` tenant, verifies every
copy byte-identical, and only then archives the originals under
`state/migrated-backup-YYYY-MM-DD/`. The originals are never deleted.
Running it twice changes nothing the second time.

Note: `sadat-riyad` is the migration target for the original install
only. A fresh install never uses it; `setup` creates your own tenant
instead.

## Safety rules, unchanged since V1

- No credential in code, config, packets, or logs. Keys only from
  environment variables.
- Monthly budget cap defaults to 0. With 0, every paid API call is
  blocked. The API adapters are stubs in V1.4.
- No auto publish, send, merge, or deploy. HOLD blocks all writes.
- CAPTCHA is never auto solved. A challenge pauses the account.
- Browser mode is off by default. Read `docs/V1-1-BROWSER-MODE.md`
  before turning it on.

## Honest limits

- V1.4 does NOT let one user see or control another user's Muse
  account. Each Muse account runs its own copy of the harness.
- V1.4 does NOT create a hosted team server. There is no shared
  dashboard, no shared queue, and no cross-account job routing.
- V1.6 browser Connect and Disconnect are in the CLI, and the
  TrustyHarness panel has Connect and Disconnect buttons too. The panel
  cannot run the Playwright driver, so panel Connect records pending
  verification and only a CLI `browser-connect` can flip an account to
  connected, after the driver verifies the login. See
  `docs/V1-6-BROWSER-CONNECT.md` and `docs/USER-GUIDE.md`.
- No live prompt has been sent through the Playwright driver yet.
  The first live driver job is still untested.
- See `docs/V1-4-MULTI-TENANT.md` for what a future hosted team
  server would need and why it is not in V1.4.
