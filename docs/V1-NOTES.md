# TrustyMUSE Harness V1 Notes

Date: 2026-11-14. Status: V2.3 local only, multi-tenant, public repo. Version 2.3.0. No central service, no data leaves the machine, no deploy, no live paid API, no credential stored, no live prompt sent yet. A live Telegram bot is running on the owner's install, restarted on V2.2 code with the panel Start button, and the owner is allowlisted.

## What V2.3 adds: Cloud Browser Mode

- An account record gains a source field: `profile` (the existing Playwright profile account, chatgpt or claude only) or `cloud` (a model the user is already logged in to in the cloud browser, any subscription model, no local profile). The cloud browser login does not carry over to a harness profile, and the harness profile login does not carry over to the cloud browser. Old records without a source field are treated as profile accounts.
- `account-add --source cloud` records a cloud account. `browser-connect --account <id> --verified-via <browser task id> --verified-note "<what the browser task observed>"` connects it, storing verifiedAt, verifiedVia, and verifiedNote on the account and in the audit log. Without both flags, a cloud connect is refused. `browser-disconnect` works for cloud accounts exactly as for profile accounts.
- `run-browser` on a cloud account refuses from the CLI with a clear message: the job runs from Muse, through the cloud browser, never from the CLI, and no packet is created. The Telegram `/run` command refuses a cloud account the same way, and the `/do` pipeline only picks profile accounts for its driver jobs.
- New CLI: `cloud-job-log --account <id> --model <model> --task "<short task>" --result ok|failed` records one cloud browser job in the audit log. The relay calls it after every cloud job.
- The relay contract in `scripts/telegram-relay.md` gains a Cloud browser section: when a step needs a browser job, the relay checks for a connected cloud account first and runs the job itself through the cloud browser, never asking the user to copy and paste. Packet mode is now the last resort, for a model with no connected account anywhere. A waiting packet job switches to the cloud path as soon as a cloud account for that model becomes connected.
- `account-list`, `session-status`, `browser-status`, and `status` all show the source and, for a cloud account, the verification note.
- New tests in `tests/run-connection-tests.mjs`, 15 groups, temp dirs only, mock driver only, no live network, no real token. `npm test` now runs 182 groups.
- Still not done: no cloud accounts recorded yet on the real install (the parent records them after the browser verification tasks), no live browser job through the cloud path yet, the daily food plan job still waits for the cloud path, no panel change in this build, no webhook mode, no deploy from Telegram.

## What V2.2 adds: Telegram as a Muse Channel

- Plain text that is not a command is a chat message. The bot queues it in `state/telegram-inbox.jsonl`, sends one fixed acknowledgement at once ("Got it. Muse will reply here."), and a scheduled relay job run by Muse answers it later. The relay writes its reply to `state/telegram-outbox.jsonl`, and the bot delivers it on its next poll cycle. Commands keep working exactly as in V2.0 and V2.1.
- Thread file per user, `state/telegram-threads/<telegramUserId>.json`, keeps the last 20 messages. A token-shaped string is never written to the thread file, though the message is still queued so the relay can warn the user to revoke it.
- Relay runner contract in `scripts/telegram-relay.md`: what the scheduled relay job reads, how it replies, its safety rules, and its limits (at most 5 new messages per run, at most 10 minutes per message step, at most 2 revisions in a multi-model fix loop, lock file so two runs never overlap). The relay is a scheduled Muse job, not a CLI command.
- New CLI: `telegram-relay-status` (counts and last run time, never message text), `telegram-inbox [--show-text]` and `telegram-outbox [--show-text]` (full text only with the flag). Chat rate limit is 10 messages per user per 10 minutes, separate from the 20-per-minute command limit: the 11th gets one slow-down reply, further messages in the window are dropped silently.
- Safety: exactly one audit event per chat message (`telegram_chat_queued`), with the numeric Telegram user id only, never the message text. HOLD blocks relay writes. The relay never deploys, pushes, merges, publishes, or sends anything; approval cards live in the Muse app.
- New tests in `tests/run-telegram-tests.mjs`, 15 groups, temp dirs only, mock Telegram API only, never api.telegram.org, no real token. `npm test` now runs 167 groups.
- Still not done: no relay cron job yet (the contract is written, the scheduled job is created after this build), no live chat reply yet, no panel change in this build, no webhook mode, no deploy from Telegram.

## What V2.1 adds: The Bot Starts From the Dashboard

- `telegram-start` is supervisor-managed: it starts the bot in the background through `scripts/telegram-bot-supervisor.sh`, and the panel Start button runs the same supervisor. The supervisor adopts a bot that is already running into `state/telegram-bot.pid` instead of starting a duplicate. New CLI: `telegram-stop` (stops the bot through the supervisor), `telegram-status` (running or stopped, pid, token source, allowlist count, heartbeat last poll time, never the token value), and `telegram-run` (the foreground runner the supervisor starts, not for hand use).
- Heartbeat: the bot writes `state/telegram-heartbeat.json` on every poll (lastPollAt, running, pid, tenantId, tokenSource, allowlistCount, lastError), so the panel can show RUNNING or STOPPED honestly. Both new files are gitignored.
- Poll loop fix for the live HTTP 409: the poll timeout is 25 seconds with a 30-second abort margin (was 30 seconds with a 10-second margin), `pollOnce` never starts a second `getUpdates` while one is in flight, and a 409 backs off for 15 seconds instead of 5. A zombie process counts as dead in the supervisor and in `isProcessAlive`, so a stop never waits on a bot that is already dead.
- New tests in `tests/run-telegram-tests.mjs`, 15 groups, temp dirs only, mock Telegram API only, never api.telegram.org, no real token. `npm test` now runs 152 groups.
- Still not done: the running bot predates V2.1 and needs a restart to pick up the heartbeat and the poll fix, no webhook mode, no deploy from Telegram. (Done since: the panel Start button restarts the bot, and the live bot now runs V2.1 code.)

## What V2.0 adds: Telegram Full Control

- Token fallback in `src/telegram/bot.ts`: the bot reads the token from `TELEGRAM_BOT_TOKEN` first, then from the file token in gitignored `state/telegram.json`, under the key `botToken`, so the TrustyHarness panel can later write it there from a box. The environment token wins when both are set. The token is never logged, never printed, and never included in an audit event. New CLI: `telegram-token-status` (prints only set or not set, and the source, env or file) and `telegram-token-clear` (removes the file token, keeps the allowlist). `telegram-link` now names the panel box as the second token path. The dashboard token box itself is a panel change that comes after this CLI work.
- Full write commands for allowlisted ids only, all audit logged per tenant, HOLD blocks every one: `/project_add <id> <name> <kind> <path>` (path must be inside the workspace), `/project_remove <id>`, `/project_pause <id>`, `/project_list`, `/model_connect <id>`, `/model_disconnect <id>` (same active-account refusal as the CLI), `/task` (alias of `/packet`), `/account_list`, `/tenant_status`, `/hold on` (immediate) and `/hold off` (asks for YES in the next message first, any other message cancels it).
- `/run --account <id> --task "<task>" [--model <id>] [--type <type>] [--title "<title>"] [--project <id>]`: one browser job through the shared queue on a connected account only. Every `run-browser` gate applies in the same order. The reply is the worker's own words, truncated to 4000 characters, and the result file is written to `browser-results/<tenant>/`. `/run_browser` stays refused and now names `/run`.
- `/do <instruction>`: a small intent parser, no LLM call. Three patterns: `plan with chatgpt then audit with claude: <task>` (two-step pipeline, runs both steps on connected browser accounts when both exist, otherwise creates both packets), `project <id>: <task>` (project-scoped packet), `<task> with <model>` (model pick, only when the trailing word is a known subscription model). Anything else is a plain task. `/do` never deploys: with deploy, live, or publish words it reports the audit verdict from a text-marker check and says the deploy itself needs the user's approval in the Muse app.
- Safety: one shared queue for the whole bot process, so one job at a time per account and pacing hold across `/run` and `/do`. Exactly one audit event per Telegram command; browser job lifecycle events are not written to the audit log from Telegram. No prompt text is ever put in an audit event.
- New tests in `tests/run-telegram-tests.mjs`, 18 groups, temp dirs only, mock Telegram API only, never api.telegram.org, no real token. `npm test` now runs 137 groups.
- Still not done: no dashboard token box yet, no live bot run yet (no real token exists), no deploy from Telegram, no webhook mode, no Phase 2 analytics service.

## What V1.9 adds: Telegram Bot Control

- New module `src/telegram/bot.ts`: a Telegram Bot API client using long polling (getUpdates with offset and timeout, sendMessage) over Node built-in fetch, no new dependency. The token comes only from the `TELEGRAM_BOT_TOKEN` environment variable, never from a config file, never logged, never printed. Starting without a token refuses with a message telling the user to create a bot with @BotFather. See `docs/V1-9-TELEGRAM-BOT.md`.
- Authorization: an allowlist of numeric Telegram user ids in gitignored `state/telegram.json`, never in the repo. Only allowlisted ids get any reply. A non-allowlisted id gets no reply at all, and the attempt is audit logged once per minute per user.
- CLI: `telegram-allow --user-id <id> --label "<Name>"`, `telegram-deny --user-id <id>`, `telegram-allowlist`, `telegram-link` (prints the exact linking steps), `telegram-start [--tenant <id>]` (runs the bot loop for one tenant, long polling only, stop with Ctrl+C).
- Bot commands, all read-only except packet creation: `/start`, `/help`, `/status` (version, tenant, HOLD, budget cap and spend, models connected, browser accounts), `/models`, `/projects`, `/browser_status`, `/analytics_status`, `/analytics_preview` (counts-only payload), `/audit` (last 10 events, no detail text). `/packet --model <id> --type <type> --title "<title>" --task "<task>" [--project <id>]` creates a draft packet only, refused when HOLD is on. `/run_browser` is refused, browser jobs run from the CLI only.
- Safety: HOLD blocks all Telegram writes including packet creation. Budget cap 0 still blocks paid API calls. Per-user rate limit 20 commands per minute, then a polite slow-down reply. Every Telegram command writes exactly one audit event per tenant with the numeric Telegram user id only, plus the owner-given label when one exists.
- New tests in `tests/run-telegram-tests.mjs`, 17 groups, temp dirs only, mock Telegram API only, never api.telegram.org, no real token. `npm test` now runs 119 groups.
- Bug found by the version bump and fixed: the analytics test hardcoded the harness version as "1.8.0" in `tests/run-analytics-tests.mjs`. It now reads the version from package.json, so future bumps do not break it.
- Still not done: no live bot run yet (no real token exists), no webhook mode, no browser jobs from Telegram, no Phase 2 analytics service, no dashboard connection for the bot.

## What V1.8 adds: Analytics Phase 1, Local Collector, Dry-Run Preview Only

- New module `src/analytics/collector.ts`: builds one JSON payload per install from local counts only, covering the last 24 hours. Payload version 1, install id is one random UUID stored in gitignored `state/analytics.json`, never identity. The collector never reads an audit event's detail field, and never reads a project name, an account label, a tenant name, an email, or a credential. It holds no remote-call code at all. See `docs/V1-8-ANALYTICS-PHASE-1.md`.
- CLI: `analytics-preview` (prints the exact payload, sends nothing), `analytics-status` (shows off, install id, collector readiness, last preview, last send never), `analytics-enable` (refused until Phase 2 builds the central service), `analytics-disable` (no-op that confirms nothing is being sent).
- New tests in `tests/run-analytics-tests.mjs`, 11 groups, temp dirs only, no live network. `npm test` now runs 102 groups.

## What V1.7 adds: Connected Means Packet Only

- Removed the auto-seed in `src/models/connect.ts`: a fresh tenant starts with zero connected models, and a model connects only through an explicit `model-connect` command. Before V1.7 a fresh tenant was seeded with chatgpt and claude on first read, which made them look connected without anyone connecting them. Tenants whose `models.json` already exists keep exactly what they have. See `docs/V1-7-CONNECTED-MEANS.md`.
- `status` and `model-list` print a one-line legend: connected means enabled for packet mode only, it is not a live login, not a stored token, and not a live call. For chatgpt and claude it points at `browser-status` for the live browser verification.
- New tests in `tests/run-model-connect-tests.mjs`, 9 groups, temp dirs only, including a real CLI scratch-copy test for the legend line. `npm test` now runs 91 groups.

## What V1.6 adds: Browser Connect and Disconnect

- Per-account browser connection state in `src/session/connection.ts`, stored on the account record: `browserConnected`, `browserConnectedAt`, `browserLastVerified`, `browserDisconnectReason`. Old records are backfilled as disconnected until verified. See `docs/V1-6-BROWSER-CONNECT.md`.
- CLI: `browser-connect --account main` (driver verifies the login via openProfile before marking connected; fails closed on a login page or challenge; refused with HOLD on), `browser-disconnect --account main [--reason "..."]` (always allowed, even with HOLD on; pauses the account, never deletes the profile, never logs the user out), `browser-status` (one line per account). `session-status`, `account-list`, and `status` show the connection state too.
- `run-browser` refuses a disconnected account with a message naming `browser-connect`, and packet mode stays the fallback. A job that pauses an account marks it disconnected again. Connection state is per tenant.
- Bug found by the V1.6 end-to-end check and fixed: `account-add` passed the tenant-scoped profile root into `addAccount`, which appended the tenant id a second time, so profiles landed in `profiles/<tenant>/<tenant>/<provider>-<id>`. Regression test added.
- New tests in `tests/run-connection-tests.mjs`, 15 groups, temp dirs only, mock driver only. `npm test` now runs 82 groups: V1 7, browser 10, live driver 9, projects 12, tenants 14, models 15, connection 15.

## What V1.5 adds: Subscription Models

- 9 subscription models in the registry, each with a chat URL and a browser support flag: chatgpt and claude `wired`, gemini, grok, deepseek, perplexity, meta-ai, copilot, mistral `packet-only`. API entries unchanged, gemini-api separate from the gemini subscription entry. See `docs/V1-5-MODELS.md`.
- Per-tenant connect state in `src/models/connect.ts`, stored in `state/tenants/<tenantId>/models.json`. ChatGPT and Claude start connected for every tenant; the 7 new models start disconnected. (Changed in V1.7: no model starts connected; a model connects only through an explicit model-connect. See `docs/V1-7-CONNECTED-MEANS.md`.) Connecting is a local record plus an audit event, never a login, never a password or token, never a call. API models are refused by model-connect. Disconnecting chatgpt or claude is refused while the tenant has an active browser account for it.
- CLI: `model-list`, `model-connect` (alias `connect`), `model-disconnect`. `packet --model` accepts any connected subscription model and refuses unconnected and API models. `run-browser` refuses every packet-only model. `status` shows connected models for the active tenant. Packets name the model and its chat URL. Slot suggestions in `modelsForSlot` are suggestions only.
- Honest split: packet mode works for all 9 models at once. Browser mode is wired only for chatgpt and claude. No login, selector, or live test exists for any new model, and none is claimed. Wiring a new driver needs the V1.2 path: live login check, live selector verification, first live test.
- Seeded: sadat-riyad tenant has chatgpt and claude connected and the 7 new models disconnected, in `state/tenants/sadat-riyad/models.json`. (Changed in V1.7: sadat-riyad now has all 9 connected by explicit activation; fresh tenants start with zero. See `docs/V1-7-CONNECTED-MEANS.md`.)
- New tests in `tests/run-model-tests.mjs`, 15 groups, temp dirs only. `npm test` now runs 67 groups: V1 7, browser 10, live driver 9, projects 12, tenants 14, models 15.

## What V1.4 adds: Multi-tenant support

- One tenant is one Muse account. One install, many tenants, each fully isolated: state, budget, accounts, projects, profiles, packets, browser results, and audit log under `state/tenants/<tenantId>/` and `profiles/<tenantId>/`. Only the code is shared. See `docs/V1-4-MULTI-TENANT.md` and `INSTALL.md`.
- Registry in `src/tenants/tenants.ts`, resolution and tenant-scoped context in `src/tenants/context.ts`. Tenant ids are 3 to 40 chars, lowercase slug, single hyphens only; reserved ids (default, system, admin, root, all, shared) are rejected by tenant-add. Tenant records reject secrets on every load and save. Resolution order: `--tenant` flag, then `TRUSTYMUSE_TENANT`, then `tenants.default` in config.yaml, then `default`. Unknown, paused, and corrupt tenants fail closed before any state is read or written.
- Migration in `tenant-migrate` moves the V1.3 flat state into the `sadat-riyad` tenant, copies verified byte-identical first, originals archived under `state/migrated-backup-YYYY-MM-DD/`, never deleted, idempotent. Two edge cases fixed by the tests: the profile copy destination sits inside the source `profiles/` directory, so the copy skips the destination folder, and the archive step moves old profile folders one by one instead of renaming the whole `profiles/` directory.
- New commands: `tenant-add`, `tenant-list`, `tenant-status`, `tenant-use`, `tenant-pause`, `tenant-remove`, `tenant-migrate`, `setup`. Every state command accepts `--tenant <id>`. `setup` is interactive-free and never asks for a password or a key. `bin` entry added for `trustymuse-harness` (dist/index.js with a shebang) so it runs as a CLI after `npm link`.
- Portability: no hardcoded personal path or name remains in `src/`, except `MIGRATION_TENANT_NAME`, the migration target for the original install only. A fresh install never uses it.
- Honest limit: no public Muse account API and no central server in V1.4. Each Muse account runs its own copy of the harness. V1.4 does NOT let one user see or control another user's Muse account, and it does NOT create a hosted team server.
- New tests in `tests/run-tenant-tests.mjs`, 14 groups, temp dirs only. `npm test` now runs 52 groups: V1 7, browser 10, live driver 9, projects 12, tenants 14.

## What V1.3 adds: Project Connectors

- Any running project or new project inside `~/workspace` can connect to the harness, and every packet or browser job can be scoped to one project with `--project <id>`. See `docs/V1-3-PROJECTS.md`.
- Registry in `src/projects/projects.ts`, state in `state/projects.json`, following the `accounts.ts` pattern. Validation rejects duplicate ids, missing roots, roots outside `~/workspace` (including `..` escapes, `/tmp`, `/etc`, home root), secrets in any field, unknown kinds, unknown task types, and any allowed action beyond read and draft. Max 20 projects by default.
- Discovery in `src/projects/discover.ts` is read only: one level deep under `~/workspace` and `~/workspace/github-repos`, kind and stack from what is actually present, never auto-connects.
- Context in `src/projects/context.ts` is safe by construction: project facts, boundaries, and a top-level file listing only, at most 20 entries, never file contents, never `.env`, `*.pem`, `*.key`, `node_modules`, `.git`, credentials, or secrets.
- Seeded and verified: trustytouch (web-app, Node.js, libsql/Turso, live https://trustytouch.com), clienthunt-production (web-app, Node.js Express, static HTML, Chrome extension, live https://clienthuntai.com), clienthuntai-api (api, Node.js Express, MongoDB, Stripe, repo SadatRiyad/clienthuntai-api), trusty-github-engineering (repo-only, Python, repo SadatRiyad/trusty-github-engineering). No live URL or repo was guessed. Duplicate clienthunt-new-* and clienthunt-reset-* folders were not seeded.
- New tests in `tests/run-project-tests.mjs`, 12 groups, temp dirs only. `npm test` now runs 38 groups: V1 7, browser 10, live driver 9, projects 12.

## What V1.2 adds: Real Playwright driver

- Playwright 1.65.0 is a dependency, Chromium binary is Chrome for Testing 158.0.8127.18 in the Playwright cache, and a real headless launch was verified. Version is recorded in package.json. Install note: npx playwright install chromium failed here because /tmp is a 512M tmpfs, so the binaries were installed manually with curl and resume. Use TMPDIR=~/tmp for a future reinstall.
- PlaywrightBrowserDriver in src/session/browser.ts launches Chromium with a persistent context at the account profileDir, checks login by profile menu or account button, fails closed on a login page, finds the prompt box by role and accessible name, tries Send message first then Enter, waits for a stable assistant message, and never auto solves CAPTCHA.
- New tests in tests/run-live-driver-tests.mjs check selector constants, send fallback, login URL detection, fail closed when Playwright is missing, fail closed when the profile is not logged in, and waitForResponse with fake pages only. No live network call in tests.
- See docs/V1-2-LIVE-DRIVER.md for what is wired, what is still unverified, and how to run the first live job.

## What V1.1 adds: Browser Session Mode

- User correction, 2026-11-10: manual copy and paste is not enough. The harness must also support logged in normal accounts, including multiple accounts, the way people use a harness without API. V1.1 answers that with an opt in browser session mode. Packet mode stays as the fallback.
- One account is one logged in normal ChatGPT or Claude account, in its own browser profile under `profiles/`. The user logs in once, by hand, in their own browser. The harness never asks for a password and never sees it. The account registry has no password field and no token field, and a secret scan rejects any such field on load and on save.
- Queue rules: one job at a time per account, pacing delay 8000 ms by default, daily limit 20 jobs per account by default, at most 3 accounts. Retry once, then pause. Challenge text pauses the account at once, and CAPTCHA is never auto solved.
- Browser mode is off by default. The user must set `browser.enabled` to `true` in `config.yaml` after reading `docs/V1-1-BROWSER-MODE.md`.
- The real browser driver is wired in V1.2, based on Playwright 1.65.0, with only selectors verified live on 2026-11-10. See docs/V1-2-LIVE-DRIVER.md and LIVE_SELECTORS in src/session/browser.ts. Send button after typing and model picker menu contents are still unverified, and the driver tries Send message first, falls back to Enter, and logs which path was used. Tests use the mock driver plus fake page tests for the real driver. No live prompt has been sent yet.
- New CLI commands: `account-add`, `account-list`, `session-status`, `run-browser`. Use `TRUSTYMUSE_BROWSER_MOCK=1` with `run-browser` to test the queue with the mock driver.

## Decisions used for V1, exactly as the user set them

- No paid model yet. Use free quota first where it truly exists.
- V1 models: ChatGPT and Claude, normal account, subscription mode by default.
- Both systems exist: API key system, ready but off, and subscription only system, on by default.
- Monthly budget cap default is 0. With 0, all paid API calls are blocked. Later the user can set any cap in config, then API calls are allowed only up to that cap, with an 80 percent warning and a hard stop in code.
- Backend for V1: Node with TypeScript, not Rust for V1. The reason is in README.md, under Backend choice for V1.

## What V1 does

- Creates a subscription packet for ChatGPT or Claude, with task, context, safety rules, expected output format, and verification guidance.
- Validates a pasted back result for empty or very short output.
- Routes tasks by type: SEO and blog to drafting, code review to coding, research to research, content and social to drafting.
- Tracks a monthly budget in USD, warns at 80 percent, and blocks spend above the cap.
- Logs every status check, packet, API block, and validation to state/audit.jsonl, append only.
- Enforces policy: Tier 0 read only, Tier 1 draft only, Tier 2 needs explicit per item approval, Tier 3 blocked. Publish, send, merge, and deploy are never automatic.

## What V1 does not do

- It does not connect a normal ChatGPT or Claude account by API. There is no official API for a normal chat account. In V1.1, a normal account is used through its own browser profile, not through an API, and that path carries its own risk. See docs/V1-1-BROWSER-MODE.md.
- It does not make a live call to OpenAI, Anthropic, or Gemini. All three adapters are stubs in V1. They return blocked.
- Live login is verified: ChatGPT logged in with Google, business mail, Free. Claude logged in with Google after the user solved the hCaptcha by hand, at claude.ai/new, BB Free, Free plan. Logged in prompt boxes and controls are verified. No live prompt has been sent through the driver yet, and no live browser response has been collected.
- It does not claim a free API quota for OpenAI or Anthropic. Gemini free tier is listed as unverified, and must be checked at runtime before any claim is made.
- It does not publish, post, send mail, merge, or deploy. The user does the posting and the approval.
- It does not store a key, a password, or a card. The .env.example file has empty values only.

## How the user runs the first test

1. Open a terminal in ~/workspace/trustymuse-harness.
2. Run `npm install`, then `npm test`. All test groups must pass.
3. Run `npm start` to see status, budget 0, and the enabled models.
4. Run a ChatGPT packet:
   `node dist/index.js packet --model chatgpt --type seo --title "ClientHuntAi no website data post" --task "Write a draft about finding clients without a website."`
5. Open the file in packets/, copy it into the ChatGPT app, run it, paste the result back to TrustyMUSE.
6. Run a Claude packet:
   `node dist/index.js packet --model claude --type code_review --title "Review budget guard" --task "Review src/budget.ts for bypass paths."`
7. Open the file in packets/, copy it into the Claude app, run it, paste the result back.
8. Run `node dist/index.js audit` to see the logged events.
9. Run `node dist/index.js check-api --provider openai` to confirm the API path is blocked at budget 0.

## How to raise the budget later

1. Copy config.example.yaml to config.yaml.
2. Set budget.monthly_cap_usd to the chosen amount.
3. Keep api.enabled false until a live API phase is built and approved. Setting a cap alone does not make a live call in V1, because the adapters are stubs.
4. When a live phase is approved, put the key in the environment only, never in code or config, and re run the budget tests before any real call.

## Rust vs Node, V1 decision

Node with TypeScript was chosen for V1, not Rust. The existing TrustyTouch and ClientHuntAi stack is Node, iteration is faster, and the adapter ecosystem is wider. RAM saving from Rust is tiny at this scale, because V1 is a local CLI with small files and small logs, not a high traffic server. The main risks are credential leak and prompt injection, not memory bugs, and those are handled by the budget guard, the policy gate, and the audit log. The adapter interface is language agnostic, so a Rust sidecar can be added later for a measured hot path without a rewrite.

## What is NOT connected yet

- No live ChatGPT prompt sent yet. Subscription packet plus a V1.2 real Playwright driver, wired with live verified selectors, first live job not yet run.
- No live Claude prompt sent yet. Subscription packet plus a V1.2 real Playwright driver, wired with live verified selectors, first live job not yet run.
- No live OpenAI API connection. Adapter is a stub, disabled, blocked by budget 0.
- No live Anthropic API connection. Adapter is a stub, disabled, blocked by budget 0.
- No live Gemini API connection. Adapter is a stub, disabled, free tier unverified.
- No GitHub connection, no deploy, no auto posting, no auto mail.
- No paid spend. Cap is 0 until the user changes it.
