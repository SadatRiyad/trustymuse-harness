# TrustyMUSE Harness Architecture

Version 2.0.0. This document is for developers who want to understand how
the harness is built, or how to change it. It maps the design to the code,
and it states the limits honestly.

## The idea in one paragraph

TrustyMUSE is the controller. Chat AI apps are the workers. A user gives
the harness a task. The harness routes the task, checks the policy, builds
a packet or runs a browser job, and logs everything. Nothing is published,
sent, merged, or deployed by the harness itself. The harness is a local
command line program in Node with TypeScript. There is no server, no
central service, and no public Muse account API.

## The 9 design components, mapped to code

The design has 9 components. This is where each one lives in V1.6.

### 1. Gateway and Router

Files: `src/index.ts`, `src/router.ts`.

`src/index.ts` is the CLI entry point. It reads the command, resolves
the tenant, and runs one command handler. `src/router.ts` maps each task
type to a slot, a primary model, a fallback model, and a tier. Task types
are `seo`, `blog`, `code_review`, `research`, `content`, and `social`.

| Task type | Slot | Primary | Fallback | Tier |
|---|---|---|---|---|
| seo | drafting | chatgpt | claude | 1 |
| blog | drafting | claude | chatgpt | 1 |
| code_review | coding | claude | chatgpt | 2 |
| research | research | claude | chatgpt | 1 |
| content | drafting | chatgpt | claude | 1 |
| social | drafting | chatgpt | claude | 2 |

An unknown task type falls back to the `content` route. The router also
offers `modelsForSlot`, a list of suggested subscription models per slot.
Suggestions are suggestions only. They never override the router, the
tier, or the policy gate.

### 2. Context Engine

Files: `src/packet.ts`, `src/projects/context.ts`.

The Context Engine builds the text a worker sees. `buildPacketContent`
in `src/packet.ts` builds a packet from the model, the task type, the
title, the task text, and extra context. `buildProjectContext` in
`src/projects/context.ts` builds the project block for a scoped job:
project name, id, kind, stack, live URL, repo, root path, allowed task
types, boundaries, and a top-level file listing of at most 20 entries. It
never reads file contents, and it always excludes `.env`, `*.pem`,
`*.key`, `node_modules`, `.git`, credentials, secrets, `profiles`, and
`state`.

### 3. Policy and HOLD Gate

File: `src/policy.ts`.

`checkPolicy` answers one question: is this action allowed at this tier
with this HOLD state? The tiers are:

- Tier 0, read only, automatic.
- Tier 1, draft only, no external action.
- Tier 2, needs explicit user approval for that exact item before any
  action.
- Tier 3, blocked in V1, never automatic.

`BLOCKED_ACTIONS` is `publish`, `send`, `merge`, `deploy`. Those are
never automatic, even at Tier 2. HOLD is a kill switch in `config.yaml`
as `policy.hold`. When HOLD is on, or when policy cannot be read, the
harness fails closed and stops. HOLD blocks setup, tenant writes, tenant
migration, model connects and disconnects, project writes,
project-scoped jobs, browser connects, and browser jobs. The one
exception is `browser-disconnect`, which is never blocked, because
stopping use must never be blocked. Read-only commands are never blocked.

### 4. Model Registry

Files: `src/registry.ts`, `src/models/connect.ts`.

The registry lists every model with provider, connection type
(`subscription` or `api`), cost mode, status, browser support (`wired`
or `packet-only`), and chat URL. The 9 subscription models are chatgpt,
claude, gemini, grok, deepseek, perplexity, meta-ai, copilot, and
mistral. The 3 API models are openai-api, anthropic-api, and gemini-api.
`gemini` and `gemini-api` are two separate entries.

Per-tenant connect state lives in `state/tenants/<tenantId>/models.json`.
Every model starts disconnected for a fresh tenant. Nothing is
connected until the user runs `model-connect` for it. `connectModel` and `disconnectModel` change that
state and write an audit event. Connecting never logs in, never stores a
credential, and never places a call. `assertPacketAllowed` is the packet
gate: it refuses unknown, API, and unconnected models before any file is
written. `assertBrowserAllowed` is the browser gate: it refuses every
packet-only model.

### 5. Adapter Layer

Files: `src/adapters/api.ts`, `src/adapters/openai.ts`,
`src/adapters/anthropic.ts`, `src/adapters/gemini.ts`.

`api.ts` defines the common adapter interface and the guard. The three
provider adapters are stubs in V1.6. They make no live call. With the
default budget cap of 0, `check-api` reports `blocked: true` for every
provider. A live API phase would replace the stubs, keep the same
interface, and keep the budget guard in front of every call. Setting a
cap alone does not make a live call, because the adapters are stubs.

### 6. Credential Vault

There is no vault file, and that is deliberate. The design rule in V1.6
is that no credential is stored at all. There is no password field, no
token field, and no API key field in code, in config, in packets, in
state, or in logs. `.env.example` has empty values only. A key, when a
live API phase exists, comes from the environment only, for example
`OPENAI_API_KEY`, and is never written to a file.

The account registry in `src/session/accounts.ts` and the tenant and
project registries reject any record containing a secret-like field
(`password`, `token`, `secret`, `apiKey`, `sessionToken`, `cookie`) on
every load and every save. Browser profiles under `profiles/` hold the
user's own logged in browser session, created by the user's own manual
login. That folder is gitignored and must never be shared, copied to a
public place, or committed.

### 7. Evaluator

File: `src/packet.ts`, function `validatePacketResult`.

The Evaluator checks a pasted back packet result for empty or very short
output and reports valid or invalid with a reason. It is a first check,
not a proof of quality. A valid result still needs the user to check it
against the brief before any draft is approved. The CLI command is
`validate-result --file <path>`. Browser jobs use the same check on the
collected response text.

### 8. Cost and Audit Log

Files: `src/budget.ts`, `src/audit.ts`.

`BudgetTracker` in `src/budget.ts` tracks spend per tenant per calendar
month in `state/tenants/<tenantId>/usage.json`. The cap defaults to 0
USD. With 0, every paid API call is blocked. The tracker warns at 80
percent of the cap and stops hard at the cap. A tenant cap wins over the
harness-wide cap in `config.yaml` when it is set. A browser job does not
spend API budget. A packet costs nothing, because the user runs it in
their own chat app under their own subscription.

`src/audit.ts` is the append only log. Every event is one JSON line in
`state/tenants/<tenantId>/audit.jsonl`. An event has `at` (ISO time),
`runId`, `event` (name), `model` (where it applies), `taskType` (where it
applies), `detail`, and `result` (`ok`, `blocked`, `valid`, or
`invalid`). Every event carries the tenant id. The log is per tenant, so
tenant A never sees tenant B's events. The `audit` command prints the
count and the last 10 events. Nothing in the harness rewrites or deletes
audit events.

### 9. Scheduler

File: `src/session/queue.ts`, class `BrowserQueue`.

The Scheduler runs browser jobs. Its rules are: one job at a time per
account, a pacing delay between jobs (default 8000 ms), a daily limit per
account (default 20), retry once, then pause. If challenge text appears,
the account is paused at once, and CAPTCHA is never auto solved. A paused
account is never retried automatically. The queue only lives in memory
while a browser job runs. There is no persisted queue. Packet jobs have
no queue, because the user runs them by hand.

## The packet flow

1. The user runs `packet --model <id> --type <type> --title ... --task
   ...`, with `--project <id>` when the job is scoped.
2. The CLI resolves the tenant. An unknown, paused, or corrupt tenant
   fails closed before any state is read or written.
3. `assertPacketAllowed` checks the model. Unknown, API, and unconnected
   models are refused, and a `packet_blocked_model` audit event is
   written.
4. When a project is given, `scopeJobToProject` checks the project is
   active, the task type is allowed, and HOLD is off. A failure writes a
   `packet_blocked_project_scope` event.
5. `routeTask` maps the task type to a slot, a primary model, a fallback
   model, and a tier.
6. `generatePacket` writes the packet file under
   `packets/<tenantId>/` and returns the file path.
7. A `packet_generated` audit event is written.
8. The user copies the packet into their own chat app, runs it, and
   pastes the result back. `validate-result` checks the result, and a
   `packet_result_validated` event is written.

## The browser flow

1. The user adds an account with `account-add`. The profile folder is
   `profiles/<tenantId>/<provider>-<id>/`.
2. The user logs in once, by hand, in their own browser, in that profile.
   The harness never asks for a password.
3. The user runs `browser-connect --account <id>`. The driver opens the
   profile and checks the login. If the profile is on a login page or a
   challenge is showing, connect fails closed and the account stays
   disconnected. A `browser_connected` or `browser_connect_blocked`
   event is written.
4. The user runs `run-browser --model <id> --account <id> --type <type>
   --title ... --task ...`. The gates run in order: packet-only model,
   missing account, browser mode off, HOLD on, project scope, unknown
   account, provider mismatch, disconnected account. Each refusal writes
   a blocked audit event.
5. `BrowserQueue` runs the job: one at a time, pacing delay, daily
   limit, retry once, then pause. The driver sends the prompt, waits for
   the response, and returns the text.
6. The result is checked with `validatePacketResult`, saved under
   `browser-results/<tenantId>/`, and a `browser_job_done` event is
   written.
7. If the job pauses the account, the account is marked disconnected
   again, with a reason. It needs a fresh `browser-connect` after the
   user checks it by hand.

The driver is `PlaywrightBrowserDriver` in `src/session/browser.ts`,
Playwright 1.65.0, Chromium with a persistent context at the account
profile folder. It checks login by profile menu or account button, finds
the prompt box by role and accessible name only, tries the Send message
button first then Enter, and logs which path was used. `MockBrowserDriver`
is the test double, selected with `TRUSTYMUSE_BROWSER_MOCK=1`. No id,
name, or data-testid is hardcoded, because none was verified live. See
`V1-2-LIVE-DRIVER.md` for the verified selectors and for what is still
unverified: the Send button after typing, the model picker menu contents,
the response stop control label, and assistant message extraction.

## Tenant isolation layout

One install, many tenants. Only the code is shared.

Shared:

- `src/`, `dist/`, `config.yaml`, the model registry, the router.
- `state/tenants.json` holds only tenant ids, display names, labels,
  status, caps, and timestamps. No tenant data ever lives there.

Per tenant, never shared:

```text
state/tenants/<tenantId>/audit.jsonl
state/tenants/<tenantId>/usage.json
state/tenants/<tenantId>/accounts.json
state/tenants/<tenantId>/projects.json
state/tenants/<tenantId>/models.json
profiles/<tenantId>/<provider>-<id>/
packets/<tenantId>/
browser-results/<tenantId>/
```

All state access goes through the tenant-scoped context in
`src/tenants/context.ts`. There is no cross-tenant read anywhere in the
CLI. Tenant ids are validated before any path is built, so an id can
never escape `state/tenants/` through `..`, `/`, or an absolute path. A
registered tenant whose state folder is missing is treated as
corruption, not as a fresh tenant, and is refused.

Tenant resolution order: `--tenant` flag, then `TRUSTYMUSE_TENANT`,
then `tenants.default` in `config.yaml`, then `default`. On a fresh
install with no registry at all, the built-in `default` tenant is
created once, so first-run commands keep working.

## Project layout

Projects are per tenant in `state/tenants/<tenantId>/projects.json`.
A project record has an id slug, a name, a kind, a status
(`active`, `paused`, `archived`), a root path that must exist inside
`~/workspace`, an optional live URL, an optional repo label, an optional
stack, allowed task types, and allowed actions (`read` and `draft` only).
Discovery in `src/projects/discover.ts` scans one level deep under
`~/workspace` and `~/workspace/github-repos`, read only, and never
auto-connects. The `repo` field is a label for context and audit only,
not a GitHub connection. See `V1-3-PROJECTS.md`.

## Config layout

`config.example.yaml` is the template. Copy it to `config.yaml` to
change settings. The sections are:

- `harness`: name, version, mode (`subscription`).
- `budget`: `monthly_cap_usd` (default 0), `currency` (USD),
  `warn_at_percent` (default 80).
- `api`: `enabled` (default false).
- `subscription`: `enabled` (default true), `models` (the 9 subscription
  models).
- `policy`: `hold` (default false), `require_approval_for` (publish,
  send, merge, deploy).
- `browser`: `enabled` (default false), `headless` (default true),
  `profile_root` (`./profiles`), `max_accounts` (default 3),
  `pacing_ms` (default 8000), `daily_limit_per_account` (default 20).
- `projects`: `max_projects` (default 20, range 1 to 100).
- `tenants`: `default` (default tenant id), `max_tenants` (default 10,
  range 1 to 50).

## Why Node with TypeScript, not Rust

V1 uses Node with TypeScript for these reasons:

- The existing stack is Node. TrustyTouch and ClientHuntAi already run
  on Node, so the same skills, tools, and review habits apply.
- Iteration is faster at this stage. Adapters, packets, budget rules,
  and policy checks change often, and TypeScript lets those changes land
  and be tested quickly.
- The adapter ecosystem is wider in Node. OpenAI, Anthropic, and Google
  client libraries are first class in Node.
- RAM saving from Rust is tiny at this scale. V1 is a local CLI with
  small files and small logs, not a high traffic server.
- The main risks are not memory bugs. They are credential leak, prompt
  injection, an accidental paid call, and an unapproved publish or
  deploy. Node with strict TypeScript, a budget guard, a policy gate,
  and an audit log addresses those risks directly.
- The adapter interface is language agnostic. A Rust sidecar can be
  added later for a measured hot path without rewriting the router,
  budget, policy, or audit code.

## Tests

`npm test` builds the code, then runs ten suites, 137 test groups in
total: V1 7, browser 10, live driver 9, projects 12, tenants 14, models
15, connection 15, model-connect 9, analytics 11, telegram 35. All suites use temp folders only, the mock driver, or
fake pages. No suite makes a live network call. The suites are:

- `tests/run-tests.mjs`: budget block, packets, audit, policy, router.
- `tests/run-browser-tests.mjs`: accounts, queue, pacing, daily limit,
  challenge pause, retry.
- `tests/run-live-driver-tests.mjs`: selector constants, send fallback,
  login URL detection, fail closed when Playwright is missing, fail
  closed when the profile is not logged in, response waiting, fake pages
  only.
- `tests/run-project-tests.mjs`: project validation, discovery, context
  safety, scoping.
- `tests/run-tenant-tests.mjs`: tenant validation, resolution, isolation,
  migration.
- `tests/run-model-tests.mjs`: the 9 subscription models, connect and
  disconnect, per-tenant isolation, packet and browser gates, no
  credential fields.
- `tests/run-model-connect-tests.mjs`: fresh tenant starts with zero
  connected models, explicit connect and disconnect, pre-existing files
  preserved, unknown and API connects refused, the legend line in the
  real CLI status and model-list output.
- `tests/run-connection-tests.mjs`: browser connect and disconnect, the
  run-browser gate, per-tenant isolation, HOLD rules, old-record
  backfill, no login detail fields.
- `tests/run-analytics-tests.mjs`: local collector counts from a
  synthetic audit log, denylist fields never in the payload, install id
  generated once, budget bands, empty install gives zero counts, no
  remote-call code in the analytics module, real CLI preview, status,
  enable refusal, and disable, tenant isolation, validator refuses an
  extra field and an over-size payload.
- `tests/run-telegram-tests.mjs`: allowlist add, list, and remove, bad
  ids and labels refused, unauthorized user gets no reply and is audit
  logged, unauthorized repeat throttled, /start and /help through
  pollOnce, /status contains version and HOLD, /models lists connected
  state, /packet creates a packet file and exactly one audit event, HOLD
  blocks /packet, token missing refuses start and the module holds no
  hardcoded token, rate limit on the 21st command, one audit event per
  command, /run_browser refused, analytics_preview prints the
  counts-only payload with no secret text, /audit returns the last 10
  events with no detail text, real CLI telegram-allow, telegram-allowlist,
  telegram-link, and telegram-start refusal in a scratch copy.

## Honest limits

Read this before you build on the harness, because these limits shape
every design choice.

- No live prompt has been sent through the Playwright driver yet. The
  first live job is still untested. Connect only verifies the login. It
  sends nothing.
- The browser driver is wired only for chatgpt and claude. The other
  seven subscription models are packet-only, and `run-browser` refuses
  them.
- No live paid API call has ever been made. The API adapters are stubs,
  and the budget cap is 0 per tenant by default.
- There is no public Muse account API and no central server. Each Muse
  account runs its own copy of the harness. One account cannot see or
  control another Muse account, and there is no hosted team server, no
  shared dashboard, no shared queue, and no cross-account job routing.
  A hosted version would need real authenticated accounts, transport and
  per-tenant encryption, a server-side policy and HOLD gate, server-side
  quotas, an audit log tenants cannot rewrite, and a data-residency and
  deletion story. See `V1-4-MULTI-TENANT.md`.
- Analytics Phase 1 builds a local payload only. `analytics-preview`
  prints it and sends nothing, because there is no sending code and no
  central service yet. `analytics-enable` is refused until Phase 2.
  See `V1-8-ANALYTICS-PHASE-1.md`.
- Telegram full control (V2.0) is a long-polling client in
  `src/telegram/bot.ts`, using Node built-in fetch only. The token comes
  from `TELEGRAM_BOT_TOKEN` first, then from the file token in
  `state/telegram.json`. Only allowlisted numeric user ids get a reply.
  The bot runs the write commands the harness offers, runs one browser
  job at a time on a connected account with `/run`, and parses
  plain-language `/do` instructions into packets or a plan-then-audit
  pipeline. It never deploys. HOLD blocks all Telegram writes. No live
  bot run has happened yet, because no real token exists. See
  `V2-0-TELEGRAM-FULL-CONTROL.md`.
- The Send button after typing, the model picker menu contents, the
  response stop control label, and assistant message extraction are not
  verified live. The driver falls back to Enter and to waiting for a
  stable assistant message, and it logs which path was used.
- There is no project edit command. To change a project, remove it and
  re-add it. There is no per-project budget and no per-model budget.
- Discovery is one level deep only. A project nested two levels down is
  not found by discovery, but it can still be connected with
  `project-add` using its full path, as long as it is inside
  `~/workspace`.
- The TrustyHarness panel reads the same state the CLI writes, but the
  panel cannot run the Playwright driver. Panel Connect records pending
  verification, and only a CLI `browser-connect` can flip an account to
  connected.
