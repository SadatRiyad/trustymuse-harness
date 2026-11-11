# TrustyMUSE Harness V1.6

Local only, multi-tenant. TrustyMUSE is the controller. ChatGPT and Claude are workers, through a safe subscription flow in V1 and through an opt in browser session mode in V1.1, now with a real Playwright driver in V1.2. Any project can connect in V1.3, and any Muse account can install and use the harness in V1.4, each tenant fully isolated. In V1.5 every major chat AI has a subscription Connect button: chatgpt, claude, gemini, grok, deepseek, perplexity, meta-ai, copilot, mistral. Packet mode works for every connected one; the browser driver stays wired only for chatgpt and claude. In V1.6 browser sessions connect and disconnect per account, with the login verified before Connect is claimed: browser-connect, browser-disconnect, browser-status. No paid model is connected yet. No credential is stored here. No live prompt has been sent yet.

## What V1.6 adds: Browser Connect and Disconnect

- Per-account browser connection state in `src/session/connection.ts`, stored on the account record in `state/tenants/<tenantId>/accounts.json`: `browserConnected`, `browserConnectedAt`, `browserLastVerified`, `browserDisconnectReason`. Old records without these fields are backfilled as disconnected. See `docs/V1-6-BROWSER-CONNECT.md`.
- New CLI commands: `browser-connect --account main` (verifies the login through the driver before marking connected, fails closed on a login page or challenge), `browser-disconnect --account main [--reason "..."]` (always allowed, even with HOLD on; pauses the account, never deletes the profile, never logs the user out), `browser-status` (one line per account). `session-status` and `account-list` show the same connection state, and `status` shows the connected count.
- `run-browser` now refuses a disconnected account and tells the user to run `browser-connect` first. Packet mode stays the fallback. A job that pauses an account (challenge or driver errors) marks it disconnected again, so the flag never claims a connection the last job just disproved.
- Connect is refused while HOLD is on. Disconnect is not. Connection state is per tenant.
- Bug found by the V1.6 end-to-end check and fixed: `account-add` passed the tenant-scoped profile root into `addAccount`, which appended the tenant id a second time, so profiles landed in `profiles/<tenant>/<tenant>/<provider>-<id>` instead of the documented `profiles/<tenant>/<provider>-<id>`. Regression test in `tests/run-connection-tests.mjs`.
- New tests in `tests/run-connection-tests.mjs`, 15 groups, temp dirs only, mock driver only. `npm test` now runs 82 groups: V1 7, browser 10, live driver 9, projects 12, tenants 14, models 15, connection 15.

## What V1.5 adds: Subscription Models (Connect button for every major chat AI)

- 9 subscription models in `src/registry.ts`, each with a real chat URL and a browser support flag: chatgpt and claude are `wired`, gemini, grok, deepseek, perplexity, meta-ai, copilot, and mistral are `packet-only`. The 3 API entries are unchanged, including gemini-api as a separate entry from the gemini subscription model. See `docs/V1-5-MODELS.md`.
- Per-tenant connect state in `src/models/connect.ts`, stored in `state/tenants/<tenantId>/models.json`. ChatGPT and Claude start connected for every tenant; every new model starts disconnected. Connecting is a local record plus an audit event: it never logs in, never stores a password or token, never places a call. API models are refused by model-connect. Disconnecting chatgpt or claude is refused while the tenant still has an active browser account for it.
- New CLI commands: `model-list`, `model-connect` (alias `connect`), `model-disconnect`. `packet --model` now accepts any connected subscription model and refuses unconnected and API models with a clear reason. `run-browser` refuses every packet-only model with "browser driver is not wired for <model> yet, use packet mode". `status` shows the connected models for the active tenant.
- Packets name the model and its chat URL, so the user always knows where to run them. Slot suggestions in `modelsForSlot` are suggestions only, never a verified capability claim.
- Honest split: packet mode works for all 9 models at once. Browser mode is wired only for chatgpt and claude. No login, selector, or live test exists for any new model yet, and none is claimed.
- New tests in `tests/run-model-tests.mjs`, 15 groups, temp dirs only. `npm test` now runs 67 groups: V1 7, browser 10, live driver 9, projects 12, tenants 14, models 15.

## What V1.4 adds: Multi-tenant support (one install, many Muse accounts)

- One tenant is one Muse account. Each tenant has its own state, budget, accounts, projects, profiles, packets, and audit log under `state/tenants/<tenantId>/` and `profiles/<tenantId>/`. Only the code is shared. See `docs/V1-4-MULTI-TENANT.md` and `INSTALL.md`.
- New user setup: `node dist/index.js setup --id <id> --name "<Name>"` creates a tenant, writes config.yaml when missing, and prints five next steps. It never asks for a password or a key.
- Tenant is resolved from `--tenant`, then `TRUSTYMUSE_TENANT`, then `tenants.default` in config.yaml, then `default`. Unknown, paused, or corrupt tenants fail closed before any state is read or written.
- Existing single-user state migrates with `node dist/index.js tenant-migrate` into the `sadat-riyad` tenant, byte-identical copies verified first, originals archived under `state/migrated-backup-YYYY-MM-DD/`, never deleted. Running it twice changes nothing.
- Honest limit: there is no public Muse account API and no central server in V1.4. Each Muse account runs its own copy of the harness. V1.4 does NOT let one user see or control another user's Muse account, and it does NOT create a hosted team server.
- New tests in `tests/run-tenant-tests.mjs`, 14 groups, temp dirs only. `npm test` now runs 52 groups: V1 7, browser 10, live driver 9, projects 12, tenants 14.

## What V1.3 adds: Project Connectors (any running or new project can connect)

- Any folder inside `~/workspace` can connect as a project, and every packet or browser job can be scoped to one project with `--project <id>`. See `docs/V1-3-PROJECTS.md`.
- `src/projects/projects.ts` keeps the registry in `state/projects.json`. Validation rejects duplicate ids, missing roots, roots outside `~/workspace`, secrets in any field, unknown kinds and task types, and any allowed action beyond read and draft. At most 20 projects by default (`projects.max_projects` in config, range 1 to 100).
- `src/projects/discover.ts` finds candidates one level deep under `~/workspace` and `~/workspace/github-repos`, read only, never auto-connects. `src/projects/context.ts` builds a safe context block for scoped jobs: project facts and boundaries plus a top-level file listing only, never file contents, never secrets.
- New CLI commands: `project-add`, `project-list`, `project-show`, `project-remove`, `project-pause`, `project-discover`, `project-status`. HOLD blocks all project writes and all scoped jobs. A paused project or a disallowed task type fails closed.
- Seeded and verified: trustytouch (web-app, live https://trustytouch.com), clienthunt-production (web-app, live https://clienthuntai.com), clienthuntai-api (api, repo SadatRiyad/clienthuntai-api), trusty-github-engineering (repo-only, repo SadatRiyad/trusty-github-engineering).
- New tests in `tests/run-project-tests.mjs`, 12 groups, temp dirs only, no live network. `npm test` now runs 38 groups in total: V1 7, browser 10, live driver 9, projects 12.

## What V1.2 adds: Real Playwright driver (wired, still no live prompt sent)

- Playwright 1.65.0, Chromium installed with `npx playwright install chromium`. `PlaywrightBrowserDriver` launches Chromium with a persistent context at the account profileDir, checks login by profile menu or account button, fails closed on a login page, finds the prompt box by role and accessible name only, tries Send message first then Enter, and logs which path was used. See `docs/V1-2-LIVE-DRIVER.md`.
- Only selectors verified live on 2026-11-10 are used. Send button after typing and model picker menu contents are still unverified. No id or data-testid is hardcoded.
- New tests in `tests/run-live-driver-tests.mjs` use fake pages only, no live network call.
- `run-browser` now uses the real driver by default. Mock driver is still available with `TRUSTYMUSE_BROWSER_MOCK=1`.

## What V1.1 adds: Browser Session Mode (opt in, off by default)

V1 packet mode is safe, but it needs manual copy and paste for every result. That is not automation. V1.1 adds a browser session mode so a logged in normal account can work through the harness without manual copy and paste, as the primary flow. Packet mode stays as the fallback.

- One account is one logged in normal ChatGPT or Claude account, in its own browser profile under `profiles/`. You log in once, by hand, in your own browser. The harness never asks for your password and never sees it. There is no password field and no token field anywhere.
- At most 3 accounts in V1.1. One separate profile per account, never shared. Never run two accounts in parallel on the same provider. The queue runs one job at a time per account, waits the pacing delay between jobs (default 8000 ms), and enforces a daily limit per account (default 20).
- If a CAPTCHA or challenge appears, the account is paused at once and never auto solved. If the driver fails twice, the account is paused too. You check a paused account by hand.
- Browser mode is off by default. Set `browser.enabled` to `true` in `config.yaml` only after reading `docs/V1-1-BROWSER-MODE.md`. That file has the full risk disclosure: automated use of a chat account can trigger a rate limit, a challenge, or a suspension.
- The real browser driver is wired in V1.2 with only live verified selectors. Live login is verified for both sites. No live prompt has been sent yet. A first live job needs your explicit go ahead, one small job first.

## What V1 does

- Subscription mode is on by default. The harness creates a prompt packet file. You run it in your own ChatGPT or Claude app, then paste the result back. The harness validates the result and logs it.
- API mode exists as an interface, but it is off by default. OpenAI, Anthropic, and Gemini adapters are stubs in V1. They make no live call.
- Monthly budget cap defaults to 0. With 0, every paid API call is blocked. You can later set any cap in `config.yaml`. The code warns at 80 percent and stops hard at the cap.
- Policy gate is fail closed. Publish, send, merge, and deploy are never automatic. HOLD blocks all writes.
- Every packet, check, block, and result is written to an append only audit log in `state/audit.jsonl`.

## What V1.1 does not do yet

- It does not connect to a normal ChatGPT or Claude chat account through an API. A normal chat account has no official API.
- It has not sent a live prompt yet. Live login and logged in selectors are verified, but send after typing, model menu contents, and response extraction are still best effort. Do not claim a live browser job until the first live job has run and its result has been checked.
- It does not make any live paid API call.
- It does not invent free API quotas for OpenAI or Anthropic. Gemini free tier must be verified at runtime, not assumed.
- It does not publish, send, merge, or deploy anything on its own.
- It does not auto solve a CAPTCHA. A challenge pauses the account at once.

## Quick start

```bash
cd ~/workspace/trustymuse-harness
npm install
npm test
npm run setup -- --id <your-id> --name "<Your Name>"
npm start
```

`npm start` shows status, models, routes, and budget for your tenant.
New Muse accounts start from `INSTALL.md`. Any command accepts
`--tenant <id>` to run as another tenant on the same install.

## First test, subscription mode

```bash
npm run build
node dist/index.js packet --model chatgpt --type seo --title "ClientHuntAi no website data post" --task "Write a draft about finding clients without a website."
```

1. Open the packet file in `packets/`.
2. Copy it into your own ChatGPT app and run it.
3. Paste the result back to TrustyMUSE.
4. TrustyMUSE checks it against the brief before any draft is approved.

Try the Claude path too:

```bash
node dist/index.js packet --model claude --type code_review --title "Review budget guard" --task "Review src/budget.ts for bypass paths."
```

## Browser mode: first test with the mock driver

```bash
npm test
node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT"
node dist/index.js account-list
node dist/index.js browser-status
TRUSTYMUSE_BROWSER_MOCK=1 node dist/index.js browser-connect --account main
TRUSTYMUSE_BROWSER_MOCK=1 node dist/index.js run-browser --model chatgpt --account main --type seo --title "ClientHuntAi no website data post" --task "Write a draft about finding clients without a website."
node dist/index.js audit
```

`run-browser` refuses a disconnected account, so `browser-connect` comes first. Without the mock flag, `run-browser` now uses the real Playwright driver. It still fails closed when the profile is not logged in, when Playwright is missing, or when a challenge is detected. That is the fail closed result in V1.2.

## Log in once per profile (live step, needs your go ahead)

1. Read `docs/V1-1-BROWSER-MODE.md` in full.
2. Set `browser.enabled` to `true` in `config.yaml`.
3. Add an account with `account-add`, for example `--provider chatgpt --id main`.
4. Open your own browser with that profile folder, for example `profiles/<tenantId>/chatgpt-main`, go to the provider site, and log in by hand with your own account. Close the browser when you are done.
5. Verify it with `browser-connect --account main`. The driver checks the login in the profile before it marks the account connected. Stop it any time with `browser-disconnect --account main`; disconnect never deletes the profile and never logs you out. See `docs/V1-6-BROWSER-CONNECT.md`.
6. Do the same for each extra account, in its own profile folder. Never share a profile between accounts.
7. Tell TrustyMUSE you have logged in, and whether the live selector check may start. No live browser job runs before that.

## Raise the budget later

1. Copy `config.example.yaml` to `config.yaml`.
2. Set `budget.monthly_cap_usd` to the amount you choose, for example 5 or 10.
3. Set `api.enabled` to `true` only when you are ready for API use.
4. Put the key in the environment only, for example `OPENAI_API_KEY`. Never put a key in code or in config.
5. Run `node dist/index.js status` and `node dist/index.js check-api --provider openai` to confirm the guard still blocks until a live phase is built.

With a cap of 0, the check command must still report blocked. That is the correct result in V1.

## Backend choice for V1: Node with TypeScript, not Rust

V1 uses Node with TypeScript for these reasons:

- The existing stack is Node. TrustyTouch and ClientHuntAi already run on Node, so the same skills, tools, and review habits apply. No new toolchain is needed to fix or extend V1.
- Iteration is faster in V1. Adapters, packets, budget rules, and policy checks change often at this stage. TypeScript lets those changes land and be tested quickly.
- The adapter ecosystem is wider in Node. OpenAI, Anthropic, and Google client libraries are first class in Node, and the same interface can be kept if a provider changes.
- RAM saving from Rust is tiny at this scale. V1 handles one task at a time, local files, and small JSON logs. It does not run a high traffic server. The RAM difference would not change the user experience.
- The main risks in V1 are not memory bugs. They are credential leak, prompt injection, an accidental paid call, and an unapproved publish or deploy. Node with strict TypeScript, a budget guard, a policy gate, and an audit log addresses those risks directly.
- The adapter interface is language agnostic. A Rust sidecar can be added later for a hot path, such as high volume packet processing, without rewriting the router, budget, policy, or audit code. That decision can be revisited when real load or a measured bottleneck exists, not before.

## Layout

- `src/index.ts`: CLI entry, status, packet, check-api, audit, account-add, account-list, browser-connect, browser-disconnect, browser-status, session-status, run-browser, project commands, tenant commands, setup, tenant-migrate, model-list, model-connect, model-disconnect.
- `src/router.ts`: task type to model slot, plus `modelsForSlot` suggestions (suggestions only).
- `src/registry.ts`: model registry with mode, free or paid, status, chat URL, and browser support (wired or packet-only). 9 subscription models, 3 API models.
- `src/models/connect.ts`: per-tenant connected subscription models in `state/tenants/<tenantId>/models.json`, packet and browser gates. Connecting never logs in and never stores a credential.
- `src/budget.ts`: monthly cap, 80 percent warning, hard stop, usage log.
- `src/audit.ts`: append only JSONL log.
- `src/policy.ts`: HOLD fail closed, Tier 0 to Tier 3, no auto publish, send, merge, or deploy.
- `src/packet.ts`: subscription packet generation and result validation.
- `src/adapters/api.ts`: common adapter interface and guard.
- `src/adapters/openai.ts`, `src/adapters/anthropic.ts`, `src/adapters/gemini.ts`: stubs, blocked by default.
- `src/config.ts`: config loader with safe defaults, including browser mode (off by default), projects (max 20), and tenants (default tenant, max 10). `saveConfig` writes config.yaml for tenant-use, setup, and migration.
- `src/session/accounts.ts`: browser account registry, no password field, no token field. Holds the V1.6 connection fields, backfilled as disconnected on old records.
- `src/session/connection.ts`: browser Connect and Disconnect. Connect verifies the login through the driver before marking connected; disconnect pauses the account, never deletes the profile, never logs the user out. `run-browser` gate lives here too.
- `src/session/browser.ts`: Playwright driver interface, real Playwright driver wired in V1.2 with LIVE_SELECTORS, mock driver for tests.
- `src/session/queue.ts`: one job at a time per account, pacing, daily limit, retry once then pause, challenge pause.
- `examples/`: one sample SEO packet and one sample code review packet.
- `tests/run-tests.mjs`: tests for budget block, packets, audit, policy, and router.
- `tests/run-browser-tests.mjs`: tests for accounts, queue, pacing, daily limit, challenge pause, and retry.
- `tests/run-model-tests.mjs`: tests for the 9 subscription models, connect and disconnect, per-tenant isolation, packet and browser gates, and no credential fields.
- `tests/run-connection-tests.mjs`: tests for browser connect and disconnect, the run-browser gate, per-tenant isolation, HOLD rules, old-record backfill, and no login detail fields.
- `src/tenants/tenants.ts`: tenant registry, validation, migration, setup. `src/tenants/context.ts`: tenant resolution and the tenant-scoped context every state access goes through.
- `docs/V1-NOTES.md`: what V1 and V1.1 do, what they do not do, and how to run the first test.
- `docs/V1-4-MULTI-TENANT.md`: the tenant model, setup for a new Muse account, isolation guarantees, migration notes, and limits.
- `docs/V1-5-MODELS.md`: the full model table, what Connect does and does not do, packet steps for a new model, the browser split, and what wiring a new driver would need.
- `docs/V1-6-BROWSER-CONNECT.md`: what browser Connect verifies, what Disconnect does and does not do, the exact commands, and why the cloud browser login is not a harness profile login.
- `INSTALL.md`: how any Muse user installs the harness and sets up their own tenant.
- `docs/V1-1-BROWSER-MODE.md`: browser mode risk disclosure, multi account rules, and how to enable it.

## Safety rules

- No credential in code, config, packets, or logs. Keys only from environment variables.
- No auto publish, send, merge, or deploy.
- If HOLD is on, or policy cannot be read, fail closed and stop.
- If you are unsure, keep the action as a draft and ask the user.
