# TrustyMUSE Harness User Guide

Version 2.5.5. This is the full command reference. Every command runs as
`node dist/index.js <command>`. Run `npm run build` or `npm test` first so
`dist/` exists. Run `node dist/index.js help` at any time to see the same
list in the terminal.

Most commands accept `--tenant <id>` to run as another tenant on the same
install. The tenant is resolved in this order: `--tenant` flag, then the
`TRUSTYMUSE_TENANT` environment variable, then `tenants.default` in
`config.yaml`, then `default`. An unknown, paused, or corrupt tenant fails
closed before any state is read or written.

## Contents

- [Status and help](#status-and-help)
- [Setup and tenants](#setup-and-tenants)
- [Models](#models)
- [Browser accounts and connections](#browser-accounts-and-connections)
- [Packets and browser jobs](#packets-and-browser-jobs)
- [Projects](#projects)
- [Audit and checks](#audit-and-checks)
- [Analytics (Phase 1, preview only)](#analytics-phase-1-preview-only)
- [Telegram Bot control](#telegram-bot-control)
- [Packet mode vs browser mode](#packet-mode-vs-browser-mode)
- [Budget](#budget)
- [HOLD and policy](#hold-and-policy)
- [What each command refuses, and why](#what-each-command-refuses-and-why)

## Status and help

### help

```bash
node dist/index.js help
```

Prints every command with its flags. Use `--help` or `-h` as well. No
state is read or written.

### status

```bash
node dist/index.js status [--tenant <id>]
```

Prints the harness status for the active tenant: tenant name, mode,
browser on or off, pacing, daily limit, max accounts, browser connection
count, project count, budget cap and use, HOLD on or off, the model list
with connected state, and the task routes. It also writes a
`status_checked` audit event.

Example:

```bash
node dist/index.js status --tenant jane-doe
```

## Setup and tenants

One tenant is one Muse account. Each tenant has its own state, budget,
accounts, projects, browser profiles, packets, browser results, and audit
log under `state/tenants/<tenantId>/` and `profiles/<tenantId>/`. Only the
code is shared. A job scoped to tenant A cannot see tenant B's data. See
`V1-4-MULTI-TENANT.md` and `ARCHITECTURE.md`.

### setup

```bash
node dist/index.js setup --id <id> --name "<Name>" [--label "<label>"]
```

Creates a tenant, writes `config.yaml` from `config.example.yaml` when
one is missing, makes the tenant the default, and prints five next steps.
It never asks for a password or a key. The id is a lowercase slug, 3 to
40 characters, single hyphens only. Reserved ids are rejected: `default`,
`system`, `admin`, `root`, `all`, `shared`.

Example:

```bash
node dist/index.js setup --id jane-doe --name "Jane Doe"
```

If the tenant already exists, setup says so and changes nothing. Setup is
blocked while HOLD is on.

### tenant-add

```bash
node dist/index.js tenant-add --id <id> --name "<Name>" [--label "<label>"] [--cap 0]
```

Creates a tenant without making it the default. The `--cap` flag sets the
tenant monthly budget cap in USD. It defaults to 0, which blocks all paid
API calls for that tenant. Blocked while HOLD is on.

Example:

```bash
node dist/index.js tenant-add --id jane-doe --name "Jane Doe" --label "jane@example.com" --cap 0
```

### tenant-list

```bash
node dist/index.js tenant-list
```

Lists every tenant on this install: id, display name, label, status, cap,
created time, and last used time. It also prints the tenant count, the max
tenants, and the default tenant.

### tenant-status

```bash
node dist/index.js tenant-status [--tenant <id>]
```

Prints one tenant in detail: display name, id, label, status, state
folder, profiles folder, budget cap and use, project count, account count,
and audit event count.

### tenant-use

```bash
node dist/index.js tenant-use --id <id>
```

Makes a tenant the default in `config.yaml`. Only an active tenant can
become the default. A paused tenant is refused.

Example:

```bash
node dist/index.js tenant-use --id jane-doe
```

### tenant-pause

```bash
node dist/index.js tenant-pause --id <id>
```

Pauses a tenant. A paused tenant cannot run any tenant-scoped command
until it is active again. Blocked while HOLD is on.

### tenant-remove

```bash
node dist/index.js tenant-remove --id <id>
```

Removes a tenant and its state folder. Other tenants are not touched.
The last active tenant cannot be removed, and a tenant with a corrupt
state file cannot be removed. Blocked while HOLD is on.

### tenant-migrate

```bash
node dist/index.js tenant-migrate
```

Moves a V1.3 or earlier single-user install into a tenant. It copies the
flat state under `state/` and `profiles/` into the `sadat-riyad` tenant,
verifies every copy byte-identical first, then archives the originals
under `state/migrated-backup-YYYY-MM-DD/`. The originals are never
deleted. Running it twice changes nothing the second time. After
migration the default tenant is `sadat-riyad`. This command is only for
the original install. A fresh install never needs it, and never uses the
`sadat-riyad` tenant. Blocked while HOLD is on.

## Models

The registry holds 9 subscription models and 3 API models. The
subscription models are chatgpt, claude, gemini, grok, deepseek,
perplexity, meta-ai, copilot, and mistral. The API models are openai-api,
anthropic-api, and gemini-api. See `V1-5-MODELS.md`.

### model-list

```bash
node dist/index.js model-list [--tenant <id>]
```

Lists every model in the registry with provider, connection type, cost
mode, status, browser support (`wired` or `packet-only`), connected or
not for the active tenant, and chat URL where one exists. API models show
as `api, never connected here`.

### model-connect

```bash
node dist/index.js model-connect --model <id> [--tenant <id>]
```

Connects one subscription model for the active tenant. `connect` is an
alias for the same command:

```bash
node dist/index.js connect --model gemini
```

Every model starts disconnected for a fresh tenant. Nothing is
connected until you run `model-connect` for it. Connecting only records the model as connected for
one tenant and writes a `model_connected` audit event. It does not log
in, it does not store a credential, and it places no call. Packet mode
works for the model at once. Browser mode is a separate step, and only
chatgpt and claude are wired for it.

Model-connect refuses API models, unknown models, and any connect while
HOLD is on. If the model was already connected, it says so and changes
nothing.

Example:

```bash
node dist/index.js model-connect --model gemini
node dist/index.js model-connect --model grok
```

### model-disconnect

```bash
node dist/index.js model-disconnect --model <id> [--tenant <id>]
```

Disconnects one subscription model for the active tenant. Packets for a
disconnected model are refused until it is connected again. Disconnecting
chatgpt or claude is refused while the tenant still has an active browser
account for that model. Remove or pause the account first, then
disconnect. Blocked while HOLD is on.

Example:

```bash
node dist/index.js model-disconnect --model grok
```

## Browser accounts and connections

A browser account is one logged in normal ChatGPT or Claude account, in
its own browser profile under `profiles/<tenantId>/<provider>-<id>/`. You
log in once, by hand, in your own browser. The harness never asks for
your password and never sees it. There is no password field and no token
field anywhere. At most 3 accounts per install by default. See
`V1-1-BROWSER-MODE.md`, `V1-2-LIVE-DRIVER.md`, and
`V1-6-BROWSER-CONNECT.md`.

### account-add

```bash
node dist/index.js account-add --provider <model> --id <id> --label "<Label>" [--source cloud] [--tenant <id>]
```

Adds a browser account. The source defaults to `profile`: the provider
must be `chatgpt` or `claude`, and the profile folder is
`profiles/<tenantId>/<provider>-<id>/`, for example
`profiles/jane-doe/chatgpt-main`.

With `--source cloud`, the account is a model you are already logged in
to in the cloud browser, not in a harness profile. Any subscription
model is allowed, including gemini, and the account has no local
profile folder. A cloud account is verified by a browser task, never
by the driver; see `browser-connect` below.

Example:

```bash
node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT"
```

```bash
node dist/index.js account-add --provider gemini --id gem --label "Gemini Cloud" --source cloud
```

The account starts disconnected. Log in by hand in that profile, then
verify it with `browser-connect`. The provider, id, and label are
checked for secret-like fields on every load and save, and rejected if
any are found.

### account-list

```bash
node dist/index.js account-list [--tenant <id>]
```

Lists every browser account for the active tenant: id, provider, label,
connected or disconnected with the last verified time, status, enabled,
profile folder, jobs run today, and last used time.

### session-status

```bash
node dist/index.js session-status [--tenant <id>]
```

Prints the browser session status for the active tenant: browser mode on
or off, headless, profile root, pacing, daily limit, max accounts, HOLD
on or off, and one connection line per account.

### browser-connect

```bash
node dist/index.js browser-connect --account <id> [--tenant <id>]
node dist/index.js browser-connect --account <id> --verified-via <browser task id> --verified-note "<observation>" [--tenant <id>]
```

Verifies the login for one browser account, and only then marks it
connected. For a profile account, the driver opens the account
profile, loads the provider page, and checks that the prompt box and
the logged in profile marker are there. If the driver reports not
logged in, a login page, or a challenge, the account stays disconnected
and the exact reason is recorded. Connected is a verified fact, never
a claim.

For a cloud account, the driver is never used. The login is verified
by a browser task that checked it in the cloud browser, and both
evidence flags are required: `--verified-via` is the browser task id
that did the check, and `--verified-note` is the plain-words
observation of what it saw, for example "chatgpt.com shows the prompt
box and the business mail account, Free plan". The evidence is stored
on the account and in the audit log. Without both flags, a cloud
connect is refused. The flags are refused for a profile account.

Browser-connect never types a password, never stores a login detail, and
never auto solves a challenge. It is refused while HOLD is on. It works
even when `browser.enabled` is false, but it prints a note: `run-browser`
will still refuse jobs until browser mode is turned on in `config.yaml`.

Example:

```bash
node dist/index.js browser-connect --account main
```

```bash
node dist/index.js browser-connect --account gem --verified-via browser-task:abc123 --verified-note "gemini.google.com shows the prompt box and the business mail account"
```

For tests only, `TRUSTYMUSE_BROWSER_MOCK=1` selects the mock driver
instead of the real Playwright driver:

```bash
TRUSTYMUSE_BROWSER_MOCK=1 node dist/index.js browser-connect --account main
```

### browser-disconnect

```bash
node dist/index.js browser-disconnect --account <id> [--reason "..."] [--tenant <id>]
```

Stops the harness from using one browser session. It flips the connected
flag to false, records a reason, and pauses the account, so the queue
refuses later jobs for it. It does NOT delete the browser profile, and it
does NOT log the user out of the site. The login stays in the profile, so
a later `browser-connect` can verify it and reconnect without another
manual login.

Disconnect is always allowed, even with HOLD on, because stopping use
must never be blocked.

Example:

```bash
node dist/index.js browser-disconnect --account main --reason "Taking a break."
```

### browser-status

```bash
node dist/index.js browser-status [--tenant <id>]
```

Prints one line per browser account: provider, label, connected or
disconnected, last verified time, status, and jobs run today. If no
browser accounts exist yet, it prints the `account-add` and
`browser-connect` steps instead.

### The panel Connect button

The TrustyHarness panel has Connect and Disconnect buttons too, but the
panel cannot run the Playwright driver itself. Panel Connect records the
account as pending verification, never as connected, and shows the CLI
command to run. Only a `browser-connect` run in the terminal can flip the
account to connected, after the driver verifies the login. Panel
Disconnect works the same as the CLI command. Until the CLI verification
runs, a pending account is treated exactly like a disconnected one:
`run-browser` refuses it.

## Packets and browser jobs

Task types are `seo`, `blog`, `code_review`, `research`, `content`, and
`social`. The router maps each type to a slot and a tier. Drafting tasks
are Tier 1, except `social` which is Tier 2. `code_review` is Tier 2.
Tier 0 is read only, Tier 1 is draft only, Tier 2 needs explicit per-item
user approval, and Tier 3 is blocked. See `ARCHITECTURE.md`.

### packet

```bash
node dist/index.js packet --model <id> --type <type> --title "<Title>" --task "<Task text>" [--context "..."] [--project <id>] [--tenant <id>]
```

Creates a packet file under `packets/<tenantId>/` for any connected
subscription model. The packet holds the task, the context, the safety
rules, the expected output format, and the verification guidance. It also
names the model and its chat URL, so you always know where to run it.

Defaults: `--model chatgpt`, `--type seo`, `--title "Untitled task"`,
`--task "Write a clear draft for this task."`. `--context` adds extra
context text. `--project` scopes the packet to one project and adds the
project context block.

Connect the models first, or the packet command refuses them:

```bash
node dist/index.js model-connect --model chatgpt
node dist/index.js model-connect --model gemini
node dist/index.js model-connect --model claude
```

Examples:

```bash
node dist/index.js packet --model chatgpt --type seo --title "First task" --task "Write a draft about finding clients without a website."
node dist/index.js packet --model gemini --type research --title "Market notes" --task "Summarise what small agencies pay for lead tools."
node dist/index.js packet --model claude --type code_review --title "Review budget guard" --task "Review src/budget.ts for bypass paths." --project my-project
```

After the packet is created, open it, copy it into your own chat app at
the chat URL printed by the command, run it there, and paste the result
back. The packet command refuses unknown models, API models, and
unconnected models, and it writes a `packet_blocked_model` audit event
when it refuses. It also refuses a packet scoped to a paused or archived
project, or to a task type the project does not allow, with a
`packet_blocked_project_scope` event.

### run-browser

```bash
node dist/index.js run-browser --model <id> --account <id> --type <type> --title "<Title>" --task "<Task text>" [--project <id>] [--tenant <id>]
```

Runs one browser job for a wired model, ChatGPT or Claude only. The
driver opens the account profile, sends the prompt, waits for the
response, saves the result under `browser-results/<tenantId>/`, and logs
every step. The queue runs one job at a time per account, waits the
pacing delay between jobs, enforces the daily limit per account, retries
once, then pauses the account.

Defaults: `--model chatgpt`, `--type seo`, `--title "Untitled task"`,
`--task "Write a clear draft for this task."`. `--project` scopes the job
to one project.

Example:

```bash
node dist/index.js run-browser --model chatgpt --account main --type seo --title "First live test" --task "Write one short paragraph about finding clients without a website."
```

Run-browser refuses, in this order, with a clear message and a blocked
audit event:

- A cloud account, with `browser_blocked_cloud`. A cloud browser job
  never runs from the CLI: it runs from Muse, through the cloud
  browser, and the relay or the Muse app chat runs it and audit-logs
  it with `cloud-job-log`. No packet is created.
- A packet-only model, such as gemini with no connected account, with
  `browser_blocked_packet_only`. Use packet mode for that model.
- A missing `--account`.
- Browser mode off, with `browser_blocked_disabled`. Set
  `browser.enabled` to `true` in `config.yaml` first.
- HOLD on. All browser jobs are blocked until HOLD is lifted.
- A paused or archived project, or a disallowed task type, with
  `browser_blocked_project_scope`.
- An unknown account, or an account whose provider does not match the
  model.
- A disconnected account, with `browser_blocked_not_connected`. Run
  `browser-connect --account <id>` first. For a cloud account, the
  connect needs `--verified-via` and `--verified-note`.

If a job pauses the account, because of a challenge or driver errors,
the account is marked disconnected again, and it needs a fresh
`browser-connect` after you check it by hand. For tests only,
`TRUSTYMUSE_BROWSER_MOCK=1` selects the mock driver.

No live prompt has been sent through the Playwright driver yet. The
first live job is still untested, so keep it small, keep it to one
account, and keep packet mode ready as the fallback.

### cloud-job-log

```bash
node dist/index.js cloud-job-log --account <id> --model <model> --task "<short task>" --result ok|failed [--type <type>] [--detail "..."] [--tenant <id>]
```

Records one cloud browser job in the audit log. The job itself runs
from Muse through the cloud browser, never from the CLI: this command
only records that it ran, with the account, the model, a short task
description, and the result. The relay calls it after every cloud job.
It refuses an unknown account, a profile account, a disconnected
account, a provider mismatch, and a bad result value, and it refuses
while HOLD is on. The account use count goes up by one, the same as a
profile browser job.

### check-api

```bash
node dist/index.js check-api --provider <openai|anthropic|gemini> [--tenant <id>]
```

Checks the API path for one provider without making a live call. The
adapters are stubs in V1.6, so with the default budget cap of 0 the
command reports `blocked: true` and a reason. That is the correct result.
It writes an `api_call_blocked` audit event.

Example:

```bash
node dist/index.js check-api --provider openai
```

### validate-result

```bash
node dist/index.js validate-result --file <path/to/result.txt> [--tenant <id>]
```

Checks a pasted back packet result for empty or very short output, prints
whether it is valid and why, prints the policy check for the draft, and
writes a `packet_result_validated` audit event. The file must exist.

Example:

```bash
node dist/index.js validate-result --file result.txt
```

## Projects

A project is a scope for jobs, not a deployment target. Connecting a
project never deploys it, never publishes from it, and never stores a
credential. Project folders must live inside `~/workspace`. Kinds are
`web-app`, `api`, `extension`, `static-site`, `docs`, and `repo-only`.
Allowed actions are `read` and `draft` only. See `V1-3-PROJECTS.md`.

### project-discover

```bash
node dist/index.js project-discover
```

Scans one level deep under `~/workspace` and `~/workspace/github-repos`,
read only, and prints candidates with kind, stack, root path, signals,
and the exact `project-add` command to connect each one. It never
auto-connects and never writes anything. It skips hidden folders,
`node_modules`, `.git`, `state`, `profiles`, and the harness folder
itself.

### project-add

```bash
node dist/index.js project-add --id <id> --name "<Name>" --kind <kind> --path <path> [--live-url <url>] [--repo <owner/repo>] [--stack "<stack>"] [--tasks <type,type>] [--notes "..."] [--tenant <id>]
```

Connects a project. `--id`, `--name`, `--kind`, and `--path` are required.
`--tasks` is a comma separated list of allowed task types. If you leave
it off, all six task types are allowed. `--live-url` and `--repo` are
labels for context and audit only. The repo label is not a GitHub
connection.

Example:

```bash
node dist/index.js project-add --id my-project --name "My Project" --kind web-app --path ~/workspace/my-project --stack "Node.js" --tasks seo,blog,content
```

Project-add refuses duplicate ids, missing root paths, roots outside
`~/workspace` (including `..` escapes, `/tmp`, `/etc`, and the home
folder itself), secrets in any field, unknown kinds, unknown task types,
any allowed action beyond read and draft, any project count above
`max_projects` (default 20), and any write while HOLD is on.

### project-list

```bash
node dist/index.js project-list [--tenant <id>]
```

Lists every connected project for the active tenant with id, name, kind,
status, allowed task types, root path, and live URL where one is recorded.

### project-show

```bash
node dist/index.js project-show --id <id> [--tenant <id>]
```

Prints one project in full: kind, status, root, live URL, repo, stack,
allowed task types, allowed actions, notes, connected time, last used
time, and the context block a scoped job sends with it.

### project-remove

```bash
node dist/index.js project-remove --id <id> [--tenant <id>]
```

Removes a project. The project folder itself is not touched. Blocked
while HOLD is on.

### project-pause

```bash
node dist/index.js project-pause --id <id> [--tenant <id>]
```

Pauses a project. Paused projects cannot run jobs until they are active
again. There is no resume command in V1.6. To use a paused project again,
remove it and re-add it with the same values. Blocked while HOLD is on.

### project-status

```bash
node dist/index.js project-status [--tenant <id>]
```

Prints a project summary for the active tenant: connected count against
the max, counts by status (active, paused, archived), HOLD state, and one
line per project.

### There is no project edit command

To change a project's live URL, repo, stack, or allowed task types,
remove it and re-add it with the corrected values. The project folder
itself is never touched by remove.

## Audit and checks

### audit

```bash
node dist/index.js audit [--tenant <id>]
```

Prints the audit event count for the active tenant and the last 10
events, each with time, event name, model, and result. The full log is
`state/tenants/<tenantId>/audit.jsonl`, append only, one JSON event per
line. Every event carries the tenant id. The audit log is per tenant, so
tenant A never sees tenant B's events.

Example audit event names: `status_checked`, `packet_generated`,
`packet_blocked_model`, `packet_blocked_project_scope`,
`api_call_blocked`, `packet_result_validated`, `account_added`,
`browser_connected`, `browser_connect_blocked`, `browser_disconnected`,
`browser_status_checked`, `browser_job_done`,
`browser_blocked_packet_only`, `browser_blocked_disabled`,
`browser_blocked_project_scope`, `browser_blocked_not_connected`,
`project_added`, `project_removed`, `project_paused`, `model_connected`,
`model_disconnect_blocked`, `tenant_migrated`, `analytics_preview`,
`analytics_status_checked`, `analytics_enable_refused`,
`analytics_disabled`.

## Analytics (Phase 1, preview only)

Analytics Phase 1 is a local collector with a dry-run preview only.
There is no sending code and no central service yet. See
`V1-8-ANALYTICS-PHASE-1.md`.

### analytics-preview

```bash
node dist/index.js analytics-preview [--tenant <id>]
```

Builds the exact JSON payload that would be sent, from local counts
only, and prints it. It sends nothing. The payload holds counts only
and never holds prompt text, results, project names, account labels,
emails, or credentials. Running it stores a random install id in
gitignored `state/analytics.json` (never identity) and stamps the last
preview time. The command is audit logged to the resolved tenant only.

### analytics-status

```bash
node dist/index.js analytics-status [--tenant <id>]
```

Shows analytics off, the install id (or that it is not generated yet),
payload version 1, collector readiness, last preview time, and last
send never. Phase 1 sends nothing.

### analytics-enable

```bash
node dist/index.js analytics-enable [--tenant <id>]
```

Refused. The central service is not built yet (Phase 2), so nothing
can be enabled and nothing is sent. The refusal is audit logged.

### analytics-disable

```bash
node dist/index.js analytics-disable [--tenant <id>]
```

A no-op that confirms analytics is off and nothing is being sent. It
changes nothing. The stored install id is kept, so Phase 2 can reuse
it. The confirmation is audit logged.

## Telegram full control

Control the whole harness from Telegram with a bot you own. The bot uses long
polling only, no webhook, no public server. See
`V2-2-TELEGRAM-MUSE-CHANNEL.md` for chat mode, the inbox and outbox
queues, and the relay contract, `V2-1-BOT-START-FROM-PANEL.md` for the
supervisor contract, the heartbeat, and the poll loop fix, and
`V2-0-TELEGRAM-FULL-CONTROL.md` for the full command list, `/do`, and
the deploy gate.

### Chat mode

Plain text that is not a command is a chat message. Just talk: the bot
queues the message in the inbox and replies at once with "Got it. Muse
will reply here." Since V2.4 a live hook wakes the relay the moment a
message lands, so a simple reply takes about 10 to 30 seconds, and
the bot delivers the reply. Commands still
run at once, with no wait. Only allowlisted users can chat. The chat
rate limit is 10 messages per user per 10 minutes, separate from the
20-per-minute command limit. Check the relay with
`telegram-relay-status`, `telegram-inbox`, and `telegram-outbox`. The
relay cron runs every 5 minutes as a safety net, and the live hook
wakes the relay the moment a message lands. See
`SETUP-ANOTHER-MUSE.md`, Part 3, for the exact hook prompts and the
exact relay job body.

### telegram-start

```bash
export TELEGRAM_BOT_TOKEN=<token from @BotFather>
node dist/index.js telegram-start [--tenant <id>]
```

Starts the bot in the background through the supervisor
(`scripts/telegram-bot-supervisor.sh`), and adopts a bot that is
already running instead of starting a duplicate. The token comes from
`TELEGRAM_BOT_TOKEN` first, then from the file token in gitignored
`state/telegram.json`. Starting without a token in either place refuses
with a message telling you to create a bot with @BotFather. Stop the bot
with `telegram-stop`. Only allowlisted Telegram user ids get a reply.

### telegram-stop

```bash
node dist/index.js telegram-stop
```

Stops the bot through the supervisor. It kills only a telegram bot
process, prefers the pid in `state/telegram-bot.pid`, and removes the
pid file. A zombie counts as dead, so the stop never waits on a bot
that is already dead.

Since V2.5 the stop also writes `state/telegram-bot.stopped` before
killing anything, so the auto-restart watchdog knows the stop was
deliberate and never starts the bot again. A successful `telegram-start`
clears the marker. See `V2-5-BOT-AUTO-RESTART.md`.

### telegram-status

```bash
node dist/index.js telegram-status
```

Prints RUNNING or STOPPED, the pid, the token source, the allowlist
count, and the heartbeat last poll time. The token value is never
printed. The heartbeat is written by the bot to
`state/telegram-heartbeat.json` on every poll.

### telegram-relay-status

```bash
node dist/index.js telegram-relay-status
```

Prints the chat mode relay state: inbox pending count, outbox pending
count, and the last relay run time if the relay has run. Prints only
counts and times, never any message text.

### telegram-inbox and telegram-outbox

```bash
node dist/index.js telegram-inbox [--show-text]
node dist/index.js telegram-outbox [--show-text]
```

List pending inbox messages and pending outbox replies with id, user
id, and time. The full text is shown only with `--show-text`, so a
routine status check never prints the user's words into a terminal log.

### telegram-token-status

```bash
node dist/index.js telegram-token-status
```

Prints only whether a token is set, and the source, env or file. The
token value is never printed.

### telegram-token-clear

```bash
node dist/index.js telegram-token-clear
```

Removes the file token from `state/telegram.json` and keeps the
allowlist. The environment token, when set, is untouched.

### telegram-allow

```bash
node dist/index.js telegram-allow --user-id <id> --label "<Name>"
```

Adds a numeric Telegram user id to the allowlist in gitignored
`state/telegram.json`. The label is a name you choose so the audit log
is readable. The bot never reads a Telegram username. Send `/start` to
the bot first, then read the user id from the terminal where the bot
runs. The file token, when set, is kept: allowlisting never wipes it.

### telegram-deny

```bash
node dist/index.js telegram-deny --user-id <id>
```

Removes a user id from the allowlist at once. That user gets no reply
from the bot any more.

### telegram-allowlist

```bash
node dist/index.js telegram-allowlist
```

Lists every allowlisted user id with its label and added time. Empty
means no Telegram user gets a reply yet.

### telegram-link

```bash
node dist/index.js telegram-link
```

Prints the exact steps to create the bot, set the token, start it, and
allowlist yourself. No tenant is needed for this command.

### Bot commands

Once allowlisted, send these to the bot in Telegram. Read-only commands
are `/start`, `/help`, `/status`, `/models`, `/projects`, `/project_list`,
`/browser_status`, `/account_list`, `/tenant_status`,
`/analytics_status`, `/analytics_preview`, and `/audit`. Write commands
are `/packet` and `/task` (draft packet only), `/project_add`,
`/project_remove`, `/project_pause`, `/model_connect`,
`/model_disconnect`, `/hold on` and `/hold off`, `/run` (one browser job
on a connected account), and `/do` (plain words into a packet or a
plan-then-audit pipeline). HOLD blocks every write. `/hold off` asks for
a YES in the next message first. Nothing here ever deploys.

- `/start`, `/help`: greeting and the full command list.
- `/status`: harness version, tenant, HOLD, budget cap and spend,
  models connected, browser accounts.
- `/models`: the 9 subscription models and their connected state, with
  the connected-means-packet-only legend.
- `/projects`, `/project_list`: connected projects, kind, status, allowed task types.
- `/project_add <id> <name> <kind> <path>`: connects a project. The path must be inside the workspace.
- `/project_remove <id>`: disconnects a project.
- `/project_pause <id>`: pauses a project.
- `/model_connect <id>`, `/model_disconnect <id>`: connect and disconnect a subscription model. Disconnecting chatgpt or claude is refused while an active browser account for it exists.
- `/account_list`: browser accounts and their state.
- `/tenant_status`: tenant, budget, projects, accounts, audit count.
- `/browser_status`: browser accounts and their connected state.
- `/analytics_status`: analytics off, install id, last preview, last
  send never.
- `/analytics_preview`: the exact counts-only payload, nothing sent.
- `/audit`: the last 10 audit events, time, event, result. No detail
  text, so no prompt content can leak.
- `/packet --model <id> --type <type> --title "<title>" --task "<task>" [--project <id>]`: creates a draft packet, exactly like the CLI
  packet command. Refused when HOLD is on, when the model is not
  connected, or when the project scope is wrong.
- `/task`: the same as `/packet`, for a task and its packet.
- `/run --account <id> --task "<task>" [--model <id>] [--type <type>] [--title "<title>"] [--project <id>]`: runs one browser job on a connected account. Refused when HOLD is on, when browser mode is off, when the account is disconnected, or when the daily limit is reached. The reply is the worker's own words, truncated to 4000 characters.
- `/do <instruction>`: plain words into harness work. `plan with chatgpt then audit with claude: <task>` runs a plan-then-audit pipeline, `project <id>: <task>` makes a project-scoped packet, `<task> with <model>` picks the model. Never deploys: with deploy, live, or publish words it reports the audit verdict and says the deploy needs your approval in the Muse app.
- `/hold on`: turns HOLD on at once. `/hold off`: asks for a YES in the next message first.
- `/run_browser`: refused, always. Use `/run` for a connected account, or run-browser on the command line.

Safety: HOLD blocks all Telegram writes, including packets, tasks, projects, models, browser jobs, and the pipeline.
Budget cap 0 still blocks paid API calls. Each user may send at most 20
commands per minute, then a polite slow-down reply. Every Telegram
command writes exactly one audit event per tenant with the numeric
Telegram user id only. A non-allowlisted user gets no reply at all, and
the attempt is audit logged once per minute per user.

## Packet mode vs browser mode

| | Packet mode | Browser mode |
|---|---|---|
| Models | All 9 connected subscription models | ChatGPT and Claude only |
| How it runs | You copy the packet into your own chat app and run it | The driver opens your logged in profile and sends the prompt |
| Login needed | No, you already have your own chat account | Yes, once by hand, per profile |
| API key needed | No | No |
| Default state | On | Off, set `browser.enabled` to `true` to turn it on |
| Risk | None, you run the prompt yourself | Automated use can trigger a rate limit, a challenge, or a suspension |
| If it fails | Nothing is sent, the packet file stays on disk | The account is paused, packet mode is the fallback |

Use packet mode first. Use browser mode only for ChatGPT and Claude,
only after reading `V1-1-BROWSER-MODE.md`, and only after a manual login
in the profile. Do not run browser mode and packet mode for the same
account at the same time, and never run two accounts in parallel on the
same provider.

## Budget

The monthly budget cap is per tenant and defaults to 0 USD. With 0,
every paid API call is blocked. The harness warns at 80 percent of the
cap and stops hard at the cap. Usage is tracked per calendar month in
`state/tenants/<tenantId>/usage.json`.

To raise the cap later:

1. Copy `config.example.yaml` to `config.yaml` if you have not done so
   already.
2. Set `budget.monthly_cap_usd` to the amount you choose, or set a
   per-tenant cap with `tenant-add --cap <amount>`. A tenant cap wins
   over the harness-wide cap when it is set.
3. Keep `api.enabled` false until a live API phase is built and approved.
   Setting a cap alone does not make a live call in V1.6, because the
   adapters are stubs.
4. Put any key in the environment only, for example `OPENAI_API_KEY`.
   Never put a key in code or in config.

A browser job does not spend API budget. A packet costs nothing, because
you run it in your own chat app under your own subscription.

## HOLD and policy

HOLD is the kill switch. It lives in `config.yaml` as `policy.hold`. When
HOLD is on, or when policy cannot be read, the harness fails closed and
stops. HOLD blocks setup, tenant writes, tenant migration, model
connects and disconnects, project writes, project-scoped jobs, browser
connects, browser jobs, and packet creation from Telegram.

Two things are never blocked by HOLD: `browser-disconnect`, because
stopping use must never be blocked, and read-only commands such as
`status`, `audit`, `model-list`, `project-list`, and `browser-status`.

Policy tiers:

- Tier 0, read only, automatic.
- Tier 1, draft only, no external action. `seo`, `blog`, `research`, and
  `content` are Tier 1.
- Tier 2, needs explicit user approval for that exact item before any
  action. `code_review` and `social` are Tier 2.
- Tier 3, blocked, never automatic.

Publish, send, merge, and deploy are never automatic, even at Tier 2.
A draft still needs per-item user approval before any of those happen,
outside the harness.

## What each command refuses, and why

- `packet` refuses an unknown, API, or unconnected model, because only
  connected subscription models may run packets. Connect the model first
  with `model-connect`.
- `packet` and `run-browser` refuse a paused or archived project, or a
  task type the project does not allow, because a scoped job must stay
  inside the project boundaries.
- `run-browser` refuses a packet-only model, because no login or selector
  is verified for it. Use packet mode for that model.
- `run-browser` refuses a disconnected account, because the login has
  not been verified. Run `browser-connect` first.
- `run-browser` refuses when browser mode is off, because browser mode
  is opt in. Set `browser.enabled` to `true` in `config.yaml`.
- `run-browser` refuses when the account provider does not match the
  model, because one account is one provider.
- `browser-connect` refuses on a login page or a challenge, because
  connected must be a verified fact. Log in by hand and try again.
- `model-disconnect` refuses chatgpt or claude while the tenant has an
  active browser account for that model, because the account would be
  left pointing at a model the harness no longer routes to.
- `tenant-use` refuses a paused tenant, because only active tenants can
  be the default.
- `tenant-remove` refuses the last active tenant, because an install
  with no active tenant cannot run tenant-scoped commands.
- Every tenant-scoped command refuses an unknown, paused, or corrupt
  tenant, because state must never be read or written for a tenant that
  cannot be trusted.
- Every write command refuses while HOLD is on, except
  `browser-disconnect`, because stopping use must never be blocked.

Every refusal is printed with a clear reason and written to the audit
log with result `blocked`.
