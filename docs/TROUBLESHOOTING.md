# TrustyMUSE Harness Troubleshooting

Version 2.0.0. Each entry has a symptom, a cause, and an exact fix. Read
the symptom that matches what you see. Do not retry a failed step in a
loop. Find the cause first.

## 1. npm test fails

Symptom: `npm test` prints a failure, or a suite stops with an error.

Cause: the most common causes are a missing build, a wrong Node version,
or a changed file. The test script builds the code first with `tsc`, so a
TypeScript error stops the run before any suite starts. `package.json`
requires Node 20 or newer.

Fix:

```bash
node --version
npm install
npm run build
npm test
```

`node --version` must print 20 or newer. If it prints 18 or older,
install Node 20 or newer first. If `npm run build` prints a TypeScript
error, read it and fix that file. Do not use the harness while the tests
fail. If the failure is in one suite only, run that suite alone to see
the detail, for example `node tests/run-connection-tests.mjs` after a
build.

## 2. Setup on an existing install does nothing, or says the tenant already exists

Symptom: `node dist/index.js setup --id jane-doe --name "Jane Doe"`
prints `Tenant jane-doe already exists` and changes nothing.

Cause: setup never overwrites an existing tenant. That is by design. The
tenant already has state, and setup will not touch it.

Fix: if you want to use that tenant, make it the default or run commands
with its flag:

```bash
node dist/index.js tenant-use --id jane-doe
node dist/index.js status --tenant jane-doe
```

If you want a fresh tenant, run setup with a new id that does not exist
yet. If you want to remove the old tenant first, see the tenant-remove
rules in `USER-GUIDE.md`. The last active tenant cannot be removed.

## 3. Unknown or paused tenant

Symptom: a command prints `Tenant check failed`, `Tenant <id> was not
found`, or `Tenant <id> is paused`, and stops before any state is read or
written.

Cause: the tenant id is wrong, the tenant is paused, or the tenant state
folder is missing or corrupt. The harness fails closed on purpose. It
never reads or writes state for a tenant it cannot trust. A registered
tenant whose state folder is missing is treated as corruption, not as a
fresh tenant.

Fix:

```bash
node dist/index.js tenant-list
```

Check the exact id, including hyphens and spelling. Check the status
column. If the tenant is paused, it cannot run commands until it is
active again. There is no resume command in V1.6, so a paused tenant
stays paused until a later version adds one, or until you remove it and
create it again with `tenant-add`. If the tenant is not in the list at
all, create it with `setup` or `tenant-add`. If the state folder is
missing or corrupt, do not create files by hand. Check whether the
tenant was moved or deleted outside the harness, and restore it from
your own backup if you have one.

## 4. Model not connected

Symptom: `packet` prints `Packet was not created`, and the message says
to connect the model first. Or `model-list` shows the model as `not
connected`.

Cause: the model is not connected for the active tenant. Since V1.7,
every model starts disconnected for a fresh tenant, including ChatGPT
and Claude. Nothing is connected until you run `model-connect` for it.
An API model, such as `openai-api`, is never connected through `model-connect`.

Fix: check which tenant is active, then connect the model for that
tenant:

```bash
node dist/index.js status
node dist/index.js model-connect --model gemini
node dist/index.js model-list
```

If the command says HOLD is on, HOLD blocks model connects. Turn HOLD
off in `config.yaml` first, or leave the model disconnected. If the model
is an API model, it cannot be connected this way. API models need a key
and a budget cap above 0, and the adapters are stubs in V1.6, so no live
API call happens.

## 5. run-browser refused on a disconnected account

Symptom: `run-browser` prints `Browser job was not started` and names
`browser-connect`.

Cause: the account has never been verified as connected, or it was marked
disconnected again after a challenge or driver errors. `run-browser`
never reaches the driver for a disconnected account. Packet mode stays
the fallback.

Fix: verify the login first, then run the job again:

```bash
node dist/index.js browser-status
node dist/index.js browser-connect --account main
node dist/index.js run-browser --model chatgpt --account main --type seo --title "Task" --task "Write a draft."
```

If `browser-connect` fails too, see the next entry. If the account was
paused after a challenge, check the account by hand in your own browser
first, then run `browser-connect` again. If the panel shows the account
as pending verification, that is the same state as disconnected. Only a
CLI `browser-connect` can flip it to connected.

## 6. Login page or challenge during browser-connect

Symptom: `browser-connect` prints `Browser was not connected`, and the
reason names a login page, not logged in, or a challenge.

Cause: the profile has no login yet, the login expired, or the site is
showing a challenge. Connect fails closed on purpose. Connected must be
a verified fact, never a claim. The harness never types a password and
never auto solves a challenge.

Fix:

1. Open your own browser with that profile folder, for example
   `profiles/<tenantId>/chatgpt-main`.
2. Go to the provider site and log in by hand with your own account.
   Solve any challenge yourself, by hand.
3. Close the browser.
4. Run `browser-connect` again:

```bash
node dist/index.js browser-connect --account main
```

If the challenge keeps coming back, leave the account disconnected and
use packet mode for that work. Do not retry connect in a loop. A login in
the cloud browser does not help here. Each harness profile needs its own
manual login. See `FAQ.md`.

## 7. Packet refused for a paused or archived project

Symptom: `packet` or `run-browser` with `--project <id>` prints `was
not created` or `was not started`, and the message names the project
scope.

Cause: the project is paused or archived, the task type is not in the
project's allowed list, or HOLD is on. A scoped job must stay inside
the project boundaries, and a project write or scoped job is blocked
while HOLD is on.

Fix: check the project state first:

```bash
node dist/index.js project-show --id my-project
node dist/index.js project-status
```

If the project is paused, there is no resume command in V1.6. Remove it
and re-add it with the same values:

```bash
node dist/index.js project-remove --id my-project
node dist/index.js project-add --id my-project --name "My Project" --kind web-app --path ~/workspace/my-project
```

If the task type is not allowed, either use an allowed type, or remove
and re-add the project with the type added to `--tasks`. If HOLD is on,
turn HOLD off in `config.yaml` first, or run the job without `--project`.

## 8. run-browser refused for a packet-only model

Symptom: `run-browser --model gemini` prints `Browser job was not
started` and says the browser driver is not wired for that model yet.

Cause: the browser driver is wired only for ChatGPT and Claude. Gemini,
Grok, DeepSeek, Perplexity, Meta AI, Copilot, and Mistral are
packet-only. No login or selector is verified for them.

Fix: use packet mode for that model:

```bash
node dist/index.js packet --model gemini --type seo --title "Task" --task "Write a draft."
```

Do not try to force a browser job for a packet-only model. Wiring a new
driver needs the V1.2 path: live login check, live selector verification,
and one small first live test. See `V1-5-MODELS.md`.

## 9. Browser mode is off

Symptom: `run-browser` prints `Browser mode is OFF` and tells you to set
`browser.enabled` to `true`.

Cause: browser mode is off by default, and it stays off until you turn
it on yourself. `browser-connect` works while browser mode is off, but
it prints a note that `run-browser` will still refuse jobs.

Fix: read `V1-1-BROWSER-MODE.md` in full first. Then copy
`config.example.yaml` to `config.yaml` if you have not done so already,
and set `browser.enabled` to `true`. Then check:

```bash
node dist/index.js session-status
```

## 10. Chromium install fails on a small /tmp

Symptom: `npx playwright install chromium` dies near 90 percent, again
and again, and `/tmp` fills up.

Cause: the download is about 198 MB, and it uses the system temp folder
while it downloads. On a machine where `/tmp` is a small tmpfs, for
example 512 MB, the download fills it and dies.

Fix: point the temp folder at your home folder first, then install:

```bash
mkdir -p ~/tmp
TMPDIR=~/tmp npx playwright install chromium
```

## 11. Profile path layout is wrong, or a profile is in the wrong place

Symptom: a profile folder looks wrong, for example
`profiles/<tenantId>/<tenantId>/chatgpt-main`, or a command cannot find
a profile.

Cause: an old bug, fixed in V1.6, passed the tenant-scoped profile root
into the account code, which appended the tenant id a second time. Any
account created before the fix can have the doubled path.

Fix: the correct layout is:

```text
profiles/<tenantId>/<provider>-<id>/
```

For example `profiles/jane-doe/chatgpt-main`. Check the real path with:

```bash
node dist/index.js account-list
```

If an old account has the doubled path, remove the account and add it
again with `account-add`, then log in once by hand in the new profile
and run `browser-connect`. Do not move profile folders by hand. A moved
profile can lose the login, and the harness will fail closed on the next
connect.

## 12. Project root outside ~/workspace

Symptom: `project-add` prints `Project was not connected`, and the
message says the root path is outside the workspace.

Cause: project folders must live inside `~/workspace`. Paths with `..`
escapes, `/tmp`, `/etc`, and the home folder itself are rejected. The
folder must also exist on disk before you connect it.

Fix: create the folder inside `~/workspace` first, then connect it with
its full path:

```bash
mkdir -p ~/workspace/my-project
node dist/index.js project-add --id my-project --name "My Project" --kind web-app --path ~/workspace/my-project
```

## 13. Account provider does not match the model

Symptom: `run-browser` prints that the account is a `chatgpt` account
but the model is `claude`, or the other way round.

Cause: one account is one provider. An account added with `--provider
chatgpt` can only run `chatgpt` jobs.

Fix: use the matching model for that account, or add a second account
for the other provider:

```bash
node dist/index.js account-add --provider claude --id claude-main --label "Main Claude"
node dist/index.js run-browser --model claude --account claude-main --type seo --title "Task" --task "Write a draft."
```

Never share one profile between two accounts.

## 14. The audit log shows a blocked event

Symptom: `audit` shows an event with result `blocked`, such as
`packet_blocked_model`, `browser_blocked_not_connected`, or
`api_call_blocked`.

Cause: a blocked event is not an error in the harness. It is the guard
working. The command was refused for a stated reason, and the refusal
was logged so it can be checked later.

Fix: read the `detail` and the printed message for that event, then fix
the cause named there: connect the model, connect the browser account,
turn browser mode on, lift HOLD, or raise the budget cap. If the blocked
event is `api_call_blocked` with cap 0, that is the correct result. Do
not try to bypass it.

## 15. The repo clone gives a 404

Symptom: `git clone https://github.com/SadatRiyad/trustymuse-harness.git`
prints 404 or asks for a username.

Cause: the address is wrong, or the network blocks GitHub. The repo is
public, so no login is needed for a correct address.

Fix: copy the URL exactly, with no extra characters:

```bash
git clone https://github.com/SadatRiyad/trustymuse-harness.git
```

Then open `https://github.com/SadatRiyad/trustymuse-harness` in a
browser. If the page loads, the repo is public and the clone address is
right. If the page also gives a 404, check the spelling of the owner and
the repo name, and check your network.

## 16. The Telegram bot does not start, or does not reply

Symptom: `telegram-start` prints "Telegram bot was not started. No
Telegram bot token found." Or the bot never replies in Telegram.

Cause: the token is missing, or your Telegram user id is not
allowlisted. The bot answers only allowlisted users, and a
non-allowlisted user gets no reply at all, by design.

Fix: create the bot with @BotFather, then set the token in the
environment, or save it from the TrustyHarness panel box, which writes
the file token in `state/telegram.json`:

```bash
export TELEGRAM_BOT_TOKEN=<token from @BotFather>
node dist/index.js telegram-start
```

Check what is set with `telegram-token-status`. It prints only set or
not set, and the source, env or file, never the value. If the status
says not set, no token is in either place. If it says set from file
but the bot still refuses, the file token may be corrupt: check
`state/telegram.json` by hand, or remove it with
`telegram-token-clear` and set the environment token instead. The
environment token wins when both are set.

Then send `/start` to the bot, read your numeric Telegram user id from
the terminal where the bot runs, and allowlist yourself:

```bash
node dist/index.js telegram-allow --user-id <id> --label "Your Name"
```

Send `/start` again. If the bot still does not reply, check
`telegram-allowlist` to confirm your id is listed, and check the audit
log for a `telegram_unauthorized` event with your id. If
`telegram-start` prints "Tenant check failed", run `setup` first: a
fresh install has no tenant registry yet. See
`V2-0-TELEGRAM-FULL-CONTROL.md`.

## 17. /run refuses a browser job, or /do never runs the pipeline

Symptom: `/run` replies "Browser job was not started." Or `/do plan
with chatgpt then audit with claude: ...` creates packets instead of
running the pipeline.

Cause: a gate refused the job. The gates, in order, are HOLD on,
browser mode off, the model has no wired driver, the account was not
found or is a different provider, or the account is not connected.
For the pipeline, either model without a connected browser account
falls back to packets.

Fix: read the exact reason in the bot reply. Turn HOLD off with
`/hold off` and then YES. Turn browser mode on in `config.yaml` after
reading `V1-1-BROWSER-MODE.md`. Verify the login with
`browser-connect --account <id>` on the command line, then check
`/browser_status`. For the pipeline, both models need a connected
account: one for the plan model, one for the audit model. See
`V2-0-TELEGRAM-FULL-CONTROL.md`.

## 18. The token is saved, but the bot does not reply to /start

Symptom: the token is saved in the TrustyHarness panel box, but the
bot gives no reply to `/start` in Telegram.

Cause: saving the token does not start the bot. Before V2.1 the panel
only saved the token, and nothing started the bot process, so there
was no long-poll loop to receive the message. A second cause is the
allowlist: a non-allowlisted user gets no reply at all, by design.

Fix: start the bot with `node dist/index.js telegram-start`, which is
supervisor-managed in V2.1 and adopts a bot that is already running
instead of starting a duplicate. Check it with
`node dist/index.js telegram-status`: it prints RUNNING or STOPPED, the
pid, the token source, the allowlist count, and the heartbeat last poll
time. Then send `/start` again, read your numeric Telegram user id
from the bot log (`logs/telegram-bot.log`), and allowlist it with
`telegram-allow --user-id <id> --label "<Name>"`. If the log shows
repeated `poll conflict (HTTP 409)`, the bot is on code older than
V2.1: restart it with `telegram-stop` and `telegram-start` to pick up
the poll fix. See `V2-1-BOT-START-FROM-PANEL.md`.

## 19. The bot says "Got it" to plain text, but Muse never replies

Symptom: a plain message gets the fixed acknowledgement "Got it. Muse
will reply here." at once, but no Muse reply arrives in Telegram.

Cause: the acknowledgement only means the message reached the inbox.
The Muse reply comes from the scheduled relay job, which runs every 1
minute and writes the reply to the outbox for the bot to deliver. The
relay cron job is created after the V2.2 build. Until then, chat
messages queue and wait: that is expected, not a bug.

Fix: check the queue with `node dist/index.js telegram-relay-status`.
If it says "Last relay run: never", the relay job does not exist yet.
If the inbox pending count grows, the bot is queueing fine and the
relay is what is missing. Once the relay runs, replies take about 2
to 4 minutes. If the relay has run and the outbox pending count stays
above zero, the bot is not delivering: check `telegram-status` for
RUNNING and the heartbeat last poll time. See
`V2-2-TELEGRAM-MUSE-CHANNEL.md` and `scripts/telegram-relay.md`.

## 20. `run-browser` refuses a cloud account, or the relay asked me to copy and paste

Symptom: `run-browser --model gemini --account gem` prints "This is
a cloud browser account. A cloud browser job never runs from the
CLI." Or the relay sent you a packet to run by hand even though you
are already logged in to that model in your browser.

Cause: a cloud account and a profile account are two different
logins. The cloud browser login does not carry over to a harness
profile, and the harness profile login does not carry over to the
cloud browser. `run-browser` only ever drives profile accounts. A
cloud job runs from Muse, through the cloud browser, never from the
CLI. If the relay asked you to copy and paste, it found no connected
account for that model: either the cloud account was never recorded,
or it was never verified.

Fix: check the accounts with `node dist/index.js account-list` and
`node dist/index.js browser-status`. The line says the source and,
for a cloud account, the verification note. If the account is missing,
add it with
`node dist/index.js account-add --provider <model> --id <id> --label "<Label>" --source cloud`.
If it is disconnected, verify it with
`node dist/index.js browser-connect --account <id> --verified-via <browser task id> --verified-note "<what the browser task observed>"`.
Once a cloud account for that model is connected, the relay runs the
job itself through the cloud browser and tells you the paste is no
longer needed. A waiting packet job switches to the cloud path as
soon as the account connects. See `V2-3-CLOUD-BROWSER.md`.
