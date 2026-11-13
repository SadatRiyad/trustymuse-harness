# Setting Up the TrustyMUSE Harness on Another Muse Account

## What this document is

This is a complete setup prompt for a second Muse account (another phone,
another Muse workspace) that wants the same TrustyMUSE harness the owner
runs, with the same features and the same TrustyHarness panel dashboard.
Paste it to that Muse and let it follow it step by step. It covers the
harness install, the Telegram bot and relay, and the panel space, and it
ends with the rule that keeps the panel in step with every future update.

The core truth first: there is no central server and no public Muse
account API. One Muse account cannot see or control another Muse
account. Each account runs its own copy of the harness in its own
workspace, with its own state, its own tenant, its own bot token, and
its own panel. This document sets up a full second install, not a
shared view of the first one.

## Part 1. Install the harness

Run these commands in the second account's own workspace.

```bash
git clone https://github.com/SadatRiyad/trustymuse-harness.git
cd trustymuse-harness
npm install
npm test
```

All test suites must pass before you use it. The current version runs
184 test groups: V1 7, browser 10, live driver 9, projects 12, tenants
14, models 15, connection 30, model-connect 9, analytics 11, telegram
67. If any group fails, stop and fix it first. A failing suite on a
fresh clone is a bug in the repo, not a problem with the install.

If Chromium is missing for browser mode, install it with:

```bash
TMPDIR=~/tmp npx playwright install chromium
```

The TMPDIR prefix matters on machines where /tmp is small. The
original install failed repeatedly on a 512M /tmp until the download
was moved.

You can also run it as a CLI after linking:

```bash
npm link
trustymuse-harness status
```

## Part 2. Set up your own tenant

One tenant is one Muse account. Run the setup wizard once, with your
own id and name. Do not reuse the owner's tenant id.

```bash
node dist/index.js setup --id <your-id> --name "<Your Name>"
```

For example: `node dist/index.js setup --id jane-doe --name "Jane Doe"`.

Setup creates your tenant, writes config.yaml from config.example.yaml
when one is missing, and makes your tenant the default. It never asks
for a password or an API key.

Then, in order:

1. Connect your own chat AI models. A fresh tenant starts with ZERO
   connected models. Connect each one you want, one command each.
   All nine subscription models work in packet mode at once, with no
   API key: chatgpt, claude, gemini, grok, deepseek, perplexity,
   meta-ai, copilot, mistral.

   ```bash
   node dist/index.js model-connect --model chatgpt
   node dist/index.js model-connect --model claude
   node dist/index.js model-connect --model gemini
   ```

   Connected means enabled for packet mode only. It is not a live
   login, not a stored token, and not a live call. Say this plainly
   in the panel wherever a model shows as connected.

2. Browser mode, only if you want it. Browser mode is OFF by default
   in config.yaml, and the panel must show that honestly. The
   Playwright driver is wired only for chatgpt and claude. A profile
   account is one logged-in normal account in its own browser
   profile. You log in once by hand in your own browser. The harness
   never asks for your password.

   ```bash
   node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT"
   node dist/index.js browser-connect --account main
   node dist/index.js browser-status
   ```

   Stop it any time with `browser-disconnect --account main`.
   Disconnect never deletes the profile and never logs you out of the
   site.

   A cloud account is the other kind: a login that lives in the cloud
   browser, not in a harness profile. It works for any subscription
   model, and it is verified by naming the browser task that observed
   the login, never by typing a password:

   ```bash
   node dist/index.js account-add --provider gemini --id gemini-cloud --label "Gemini Cloud" --source cloud
   node dist/index.js browser-connect --account gemini-cloud --verified-via <browser-task-id> --verified-note "<what the browser task observed>"
   ```

   Cloud jobs never run from the CLI. They run from Muse, the
   Telegram relay, or the Muse app chat, through the cloud browser.

3. Connect your own project. The path must live inside your own
   workspace, and the id must be a slug.

   ```bash
   node dist/index.js project-add --id my-project --name "My Project" --kind web-app --path ~/workspace/my-project
   ```

   There is no project edit command. To change a project, remove it
   and re-add it.

4. Run your first job:

   ```bash
   node dist/index.js packet --model chatgpt --type research --title "First task" --task "Write a draft." --project my-project
   ```

5. Check the audit log:

   ```bash
   node dist/index.js audit
   ```

## Part 3. Telegram bot and relay

Create the bot with @BotFather in Telegram, then set the token in the
environment:

```bash
export TELEGRAM_BOT_TOKEN=<token from @BotFather>
node dist/index.js telegram-start
```

Or save the token from the panel token box, which writes the file
token into `state/telegram.json` under the key `botToken`. The
environment token wins when both are set. Check it any time with
`telegram-token-status`, which prints only set or not set, never the
value. Remove the file token with `telegram-token-clear`.

`telegram-start` is supervisor-managed through
`scripts/telegram-bot-supervisor.sh`. It adopts a bot that is already
running instead of starting a duplicate. The bot writes a heartbeat
to `state/telegram-heartbeat.json` on every poll, so the panel can
show RUNNING or STOPPED honestly. Stop the bot any time with
`telegram-stop`, and check it with `telegram-status`, which prints
running or stopped, the pid, the token source, the allowlist count,
and the heartbeat last poll time, never the token value.

Send `/start` to the bot, read your numeric Telegram user id from the
terminal where the bot runs, and allowlist yourself:

```bash
node dist/index.js telegram-allow --user-id <id> --label "Your Name"
```

Send `/start` again and the bot replies. From Telegram you can check
status, models, projects, browser, analytics, and audit, create tasks
and packets, add, remove, and pause projects, connect and disconnect
models, turn HOLD on and off, run one browser job at a time on a
connected account with `/run`, and give plain-language instructions
with `/do`. You can also just talk: plain text that is not a command
is queued for a relay job run by Muse.

The relay has two paths. The fast path is a live hook that wakes the
relay the moment a message lands, so a simple reply takes about 10
to 30 seconds. The slow path is a scheduled relay job every 5
minutes, a safety net only. The hook scripts are canonical files in
the repo under `hooks/`. Copy them into place and register the hooks:

```bash
cp hooks/telegram-inbox-watch.sh ~/hooks/scripts/telegram-inbox-watch.sh
cp hooks/telegram-bot-watchdog.sh ~/hooks/scripts/telegram-bot-watchdog.sh
chmod +x ~/hooks/scripts/telegram-inbox-watch.sh ~/hooks/scripts/telegram-bot-watchdog.sh
```

Register the hook `telegram-live-relay` with poll interval 10
seconds, and the hook `telegram-bot-watchdog` with poll interval 30
seconds. Both deliver to the chat where the harness lives. Test each
with a dry run first, then enable it. The dry run must stay silent
when there is nothing to do.

The watchdog restarts the bot only when it crashed or went
unresponsive. It never restarts a bot the user stopped on purpose:
`telegram-stop` writes `state/telegram-bot.stopped` before killing
the bot, and the watchdog stays silent while that marker exists. A
successful start clears the marker.

Create the scheduled relay job with the body in
`scripts/telegram-relay.md` as its instruction, every 5 minutes,
owner the harness goal. It reads the contract file first on every
run, takes at most 5 new inbox lines, writes replies to the outbox,
updates the thread file, marks inbox lines done only after their
reply is written, writes the relay status file, and removes the lock.
It stays silent in chat for routine runs.

## Part 4. Build the TrustyHarness panel

Build a fullstack web artifact named TrustyHarness, slug
`trustyharness`, placed in the sidebar. It is the dashboard for this
install only. It reads this install's own harness state files, never
another install's files.

### What the panel is and is not

The panel manages and records harness state. It does not itself drive
local browser profiles, it does not place API calls, and it does not
run the Playwright driver. Every value it shows comes from a live
state file, read through a privileged handler. If a value cannot be
read, the panel says so plainly. It never invents a value, never shows
a stale value as current, and never claims a connection that does not
exist.

### Tabs

Build these six tabs, in this order:

1. Console. The overview. Harness version, HOLD state, modes
   (browser enabled or not, API enabled or not), monthly budget cap,
   tenant count and active tenants, projects connected and active,
   subscription models connected out of 9, browser accounts connected
   (count cloud accounts too, not only profile accounts). A Telegram
   section with the token box, the bot Start and Stop buttons, and the
   relay status. A cloud browser accounts section listing each cloud
   account with its provider, label, verification note, verified time,
   and browser task id.
2. Tasks. The dispatched tasks, newest first, with packets, results,
   and lifecycle status. Below them, a Harness activity section
   reading the tenant audit log live: cloud browser jobs, Telegram
   relay jobs, packet jobs including blocked ones, and every other
   audit line that carries a task type, newest first. Bookkeeping
   events like status checks are excluded.
3. Workers. The model registry and the browser accounts. Subscription
   models first, then API adapters. Each browser account shows its
   provider, label, source (cloud or profile), status, connected
   flag, pending verification flag with its CLI command, disconnect
   reason, and connected time.
4. Analysis. The analytics status: analytics OFF or ON, install id,
   collector ready, last preview, last send. The analytics preview
   prints the exact payload and states that nothing was sent.
   Analytics enable is refused until the central service exists.
5. Audit. The audit log, newest first, append-only, mirroring the
   tenant audit log. Every event carries its tenant id.
6. Telegram Bot. Bot status from the heartbeat file plus a live
   process check: RUNNING or STOPPED, pid, last poll time, tenant,
   token source, allowlist count, last error. Relay status: last run,
   processed count, failed count, inbox and outbox pending counts.
   Full chat history from the thread file, recent inbox and outbox
   lines with status badges, and one combined errors list, shown
   honestly even when empty. Refresh every 15 seconds.

### Actions the panel must publish

These are the actions the panel publishes. Each one does exactly what
its description says, and nothing more.

- getsettings. Returns the harness settings: name, HOLD state,
  modes, budget cap, and browser-session limits.
- updatesettings. Updates harness settings and logs the change.
  It must never flip browserEnabled, apiEnabled, HOLD, or the budget
  cap on its own. After every panel edit, re-check getsettings: space
  edits have flipped the panel browser setting to ENABLED against the
  harness config before. If it flipped, fix it at once with
  updatesettings.
- listmodels. Lists every model in the registry, subscription
  workers first, then API adapters.
- setmodelconnection. Connects or disconnects a subscription model
  for the active tenant. It only flips registry state and logs it.
  It never logs in, never stores a password or token, and never
  places a call. Disconnecting chatgpt or claude is refused while
  the tenant has an active browser account for it.
- setmodelstatus. Enables or disables one registry model and logs
  the change.
- addmodel. Adds a new model entry to the registry. A paid API model
  starts disabled.
- checkapiguard. Runs the budget and API guard check for one API
  model and reports whether a paid call would be allowed or blocked,
  without placing any call.
- recordspend. Records an API spend entry against the monthly
  budget and logs it.
- listprojects. Lists connected projects: id, kind, path, live URL,
  repo label, stack, and the task types each project allows.
- addproject. Connects a project. The folder must live inside the
  workspace, the id must be unique, and the max project count is
  enforced. There is no edit command: to change a project, remove it
  and re-add it.
- removeproject. Disconnects a project and logs it. Tasks already
  dispatched keep their recorded project id.
- listtenants. Lists the tenants on this install. Each tenant owns
  isolated state, budget, accounts, projects, profiles, and audit
  log.
- listaccounts. Lists browser-session accounts with today's usage
  and connection state: connected flag, pending verification flag
  with its CLI command, disconnect reason, connected time.
- getbrowseraccountsstate. Returns the browser accounts from the
  tenant accounts file, each with id, provider, label, source
  (cloud or profile), and status.
- addaccount. Adds a browser-session account. Enforces the max
  account count.
- removeaccount. Removes a browser-session account and logs it.
- setaccountstatus. Pauses or resumes a browser-session account,
  with an optional reason, and logs it.
- browserconnect. Starts a browser connection for one account. The
  panel cannot run the Playwright driver check, so this NEVER marks
  the account connected. It records the account as pending
  verification, keeps browserConnected false, and returns the exact
  CLI command that does the real driver verification.
- browserconfirmcliverified. Records a CLI-verified browser
  connection for one account. This is the ONLY action that may set
  browserConnected. Call it only after the CLI browser-connect
  command has actually run on the machine and verified the login
  through the driver.
- browserdisconnect. Disconnects one browser account. Always
  allowed, even while HOLD is on. Marks the account disconnected
  with a reason, clears any pending verification, and pauses it.
  Never deletes the browser profile and never logs the user out.
- startbrowserrun. Records a browser-session run of a packet-ready
  task on a chosen account, enforcing browser mode, account status,
  the daily limit, and HOLD. A disconnected or pending-verification
  account is refused.
- listroutes. Returns the routing table: task type to slot, primary
  and fallback model, approval tier, and verification rule.
- listtasks. Lists dispatched tasks, newest first, with packets,
  results, and lifecycle status.
- createtask. Creates a task, routes it through the router, generates
  its prompt packet, and blocks it if HOLD is on or the target is a
  paid API model stopped by the budget guard. With a project id the
  job is project-scoped.
- deletetask. Deletes a task from the queue and logs the removal.
- submitresult. Records a worker result for a task and moves it to
  review.
- verifytask. Approves a reviewed task or sends it back to the queue
  for a re-run, and logs the verdict.
- retryblockedtask. Re-checks a blocked task against the current
  HOLD, mode, and budget state, and unblocks it with a fresh packet
  when the guard now passes.
- listaudit. Lists audit log events, newest first.
- listharnesstasks. Lists the real jobs the harness itself has run,
  read live from the tenant audit log, newest first.
- gettelegramstatus. Returns the Telegram status: whether a token is
  set and its source (env, file, panel record, or none) with the
  masked last-4 only, never the full token, whether the panel can
  write the harness state file, and the live bot status from the
  heartbeat file plus a live process check.
- gettelegrambotpanel. Returns everything the telegram_bot tab shows,
  read live from the Telegram state files: bot status, relay status,
  chat history, inbox and outbox, errors.
- savetelegramtoken. Saves or rotates the BotFather token from the
  panel token box into `state/telegram.json` under botToken, through
  a privileged file handler, preserving the allowlist. Then
  auto-starts the bot through the supervisor when no bot is running.
  The token is never shown back in full, masked last-4 only, never
  stored in the panel database, never in the audit log. If the state
  file cannot be written, the panel says so plainly and shows the
  export TELEGRAM_BOT_TOKEN fallback command.
- revoketelegramtoken. Revokes the token: removes the file token
  from `state/telegram.json`, keeping the allowlist, and clears the
  panel's masked record. The token value is never logged. An
  environment token, if one is set, is not touched.
- starttelegrambot. Starts the bot from the panel through the
  supervisor. The supervisor adopts a bot that is already running
  instead of starting a duplicate.
- stoptelegrambot. Stops the bot from the panel through
  telegram-stop. Stopping an already-stopped bot is a no-op.
- importv17 through importv23, plus one import action per later
  version that changes the panel. Each import action is idempotent:
  it bumps the recorded harness version, writes one audit event on
  the first run only, and never touches HOLD, the budget cap,
  api_enabled, or browser_enabled, and never connects an account or
  stores a token.
- seedfromharness. One-time import of the local harness state when
  the panel tables are empty. Never overwrites existing panel data.

### The state files the panel reads

These are the files, relative to the harness root. The panel reads
them live through privileged handlers, never from a stale copy.

- `config.yaml`: browser.enabled, api.enabled, monthly cap, HOLD,
  tenants.default, browser limits.
- `state/tenants.json`: tenant registry, ids, display names, labels,
  status.
- `state/tenants/<tenantId>/audit.jsonl`: the audit log, one event
  per line, every event carrying its tenant id.
- `state/tenants/<tenantId>/usage.json`: usage per calendar month.
- `state/tenants/<tenantId>/accounts.json`: browser accounts, each
  with id, provider, label, source (profile or cloud), status,
  browserConnected, browserConnectedAt, browserLastVerified,
  browserDisconnectReason, and for cloud accounts verifiedAt,
  verifiedVia, verifiedNote.
- `state/tenants/<tenantId>/projects.json`: connected projects.
- `state/tenants/<tenantId>/models.json`: connected subscription
  model ids for the tenant.
- `state/telegram.json`: the Telegram state, keys `users` (the
  allowlist) and `botToken`. Never print or log the token value.
- `state/telegram-heartbeat.json`: lastPollAt, running, pid,
  tenantId, tokenSource, allowlistCount, lastError.
- `state/telegram-bot.pid`: the bot process id.
- `state/telegram-bot.stopped`: present only when the bot was
  stopped on purpose. The watchdog never restarts while it exists.
- `state/telegram-bot-watchdog.json`: watchdog restart attempts.
- `state/telegram-bot-watchdog-disabled`: present only when the
  watchdog gave up after repeated failed restarts.
- `state/telegram-inbox.jsonl`: queued Telegram messages, fields
  messageId, telegramUserId, text, receivedAt, status
  (new, processing, done, failed), attempts.
- `state/telegram-outbox.jsonl`: replies waiting to be sent, fields
  replyId, inReplyTo, telegramUserId, text, createdAt, status
  (pending, sent, failed), attempts, sentAt.
- `state/telegram-threads/<telegramUserId>.json`: the last 20
  messages per user plus a summary. Token-shaped strings are never
  written to a thread file.
- `state/telegram-relay-status.json`: last relay run, processed
  count, failed count, inbox and outbox pending counts.
- `state/telegram-relay.lock` and `state/telegram-relay.lock.d`:
  the relay lock. Present only while a relay run is working.
- `state/analytics.json`: present only after the first analytics
  preview. Holds the install id and the last preview and send times.
- `packets/<tenantId>/`: generated packets.
- `browser-results/<tenantId>/`: browser job results.

### Styling rules

- The panel must work on a phone. Long values must wrap inside
  their cards: set overflow-wrap anywhere on the body, and give
  grid children min-width 0. Label and value rows are a vertical
  stack on a phone and a row only from the small breakpoint up.
  Code blocks keep their own internal scroll.
- Use commas, periods, colons, or short hyphens in panel copy. Never
  use long dash characters anywhere in the panel or the docs.

## Part 5. The update rule

This is the rule that fixes the original problem. New harness
features arrive with every update, and the panel must gain them at
the same time, or the other install cannot use them.

After every `git pull`, do all of this before saying the update is
done:

1. Run `npm test`. All groups must pass. If a group fails, fix it
   first.
2. Read the top section of `docs/V1-NOTES.md`. It lists what the new
   version changes. If the version adds a panel section, a panel
   action, a state file, or a hook, build it into the panel now.
3. Add one import action for the new version, following the pattern
   of importv17 through importv23: idempotent, bumps the recorded
   harness version, writes one audit event on the first run only,
   never touches HOLD, the budget cap, api_enabled, or
   browser_enabled, never connects an account, never stores a token.
   Run it and confirm the panel version now matches the repo
   version in package.json.
4. Verify with the panel actions: getSettings shows the new version,
   browserEnabled and apiEnabled match config.yaml, the cap matches,
   HOLD matches, and every new section shows live data, not a
   placeholder.
5. If a new hook script arrived under `hooks/`, copy it to
   `~/hooks/scripts/`, dry run its hook, and confirm the hook is
   enabled.
6. If a new scheduled job arrived, create it with the body the docs
   name, and confirm its next run time.

Never let the panel version lag the repo version. A panel that shows
an old version while the repo is new is an unfinished update.

## Part 6. Safety rules, unchanged

- No credential in code, config, packets, or logs. Keys only from
  environment variables, or from the Secure Vault flow for website
  logins. Never print, log, or show a token, password, or key, not
  even in part, except the masked last-4 of the Telegram token in
  the panel.
- Monthly budget cap defaults to 0. With 0, every paid API call is
  blocked. The API adapters are stubs.
- No auto publish, send, merge, or deploy. HOLD blocks all writes.
  The deploy gate is still undecided: until the owner picks one of
  the three options in writing (one-tap approval in the Muse app
  for each deploy, a standing pre-authorization per project with
  written limits, or no auto-deploy ever), the bot refuses every
  deploy. That is correct behaviour, not a bug.
- CAPTCHA is never auto solved. A challenge pauses the account.
- Automated use of a chat account can trigger a rate limit,
  challenge, or suspension. Pace the jobs, respect the daily limit,
  and stop on a challenge.
- The relay never logs in, types a password, enters a one-time code,
  or solves a CAPTCHA. Approval cards live in the Muse app, never in
  Telegram.
- Food, health, and diet routines from a chat model are drafts, not
  medical fact, even when a second model agrees. The final reply
  must tell the user to check with a doctor or a qualified
  nutritionist before following a new diet.

## Part 7. Verification checklist

Before you report the setup as done, verify each of these and report
the result for each one. Do not report a step as done from the fact
that a command ran. Report it from what you observed.

1. `npm test` passes, all groups, with the count printed.
2. `node dist/index.js status` shows your tenant, cap 0, HOLD OFF,
   your connected models, your projects.
3. The panel shows the repo version from package.json, and
   getSettings agrees with config.yaml on browserEnabled,
   apiEnabled, cap, and HOLD.
4. All six tabs exist and each one shows live data from the state
   files, with no placeholder and no empty section that should have
   data.
5. The Telegram token box saves a token, shows only the masked
   last-4, and the bot starts and answers `/start` after you are
   allowlisted.
6. A plain Telegram message gets the instant "Got it" reply, and a
   Muse reply arrives through the relay within about a minute.
7. `telegram-status` shows RUNNING with a fresh heartbeat, and the
   panel telegram_bot tab agrees.
8. Kill the bot once with a signal (not a supervisor stop) and
   confirm the watchdog restarts it within about two minutes.
9. The relay cron is set to every 5 minutes and the live hook is
   enabled and polling.

## Honest limits

- One install cannot see or control another install. There is no
  shared dashboard, no shared queue, and no cross-account job
  routing. A hosted team server is a separate, undecided project.
- The first live job through the Playwright driver has still never
  been run on any install. It needs a hand login in the local
  harness profile first, browser.enabled true, then one small job,
  ChatGPT before Claude.
- Analytics Phase 2 (the central service, enable, and dashboard)
  is not built. The panel shows only this install's local analytics.
- No per-model or per-project budget, and no project edit command.
- No WhatsApp control, no voice control, and no mobile dashboard
  app beyond the panel itself.
- The panel does not yet show hook status. Add it when you build
  the panel: read the hook logs if your panel can reach them, and
  if it cannot, say so plainly instead of faking the status.
