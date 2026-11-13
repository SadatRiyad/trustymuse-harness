# V1.9 Telegram Bot Control

Version 1.9.0. Date: 2026-11-14. Status: local only, no live bot run yet, no real token exists.

## What it is

V1.9 adds a Telegram Bot that controls the harness from Telegram. You talk
to your own bot on your phone, and the bot answers with harness status,
models, projects, browser accounts, analytics, and audit events. It can
also create a draft packet, the same packet the CLI creates. It never
sends, publishes, merges, or deploys anything, and it never runs a browser
job. Browser jobs stay on the CLI only.

The bot is a separate process you start when you want it and stop with
Ctrl+C. It uses long polling only: it asks Telegram for new messages, one
batch at a time. There is no webhook mode in V1.9, so you do not need a
public server, a domain, or an open port.

## How to create the bot

1. Open Telegram and talk to @BotFather.
2. Send `/newbot`. @BotFather asks for a display name, then a username.
   The username must end in `bot`, for example `trustyharness_bot`.
3. @BotFather replies with a token that looks like
   `123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCrxmrA`. That token is the bot's
   password. Treat it like one: never paste it into chat, never commit it
   to a file, never share a screenshot that shows it.
4. If the token ever leaks, send `/revoke` to @BotFather for that bot and
   get a new one.

## How to run the bot

Set the token in the environment only, never in a file:

```bash
export TELEGRAM_BOT_TOKEN=<token from @BotFather>
node dist/index.js telegram-start
```

The bot serves the active tenant, resolved the same way as any CLI
command: `--tenant <id>`, then `TRUSTYMUSE_TENANT`, then
`tenants.default` in config.yaml, then `default`. To serve another
tenant, run:

```bash
node dist/index.js telegram-start --tenant <id>
```

Starting the bot without a token refuses with a clear message that tells
you to create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. The
token is never logged and never printed, not even in an error message.

Stop the bot any time with Ctrl+C. The bot also stops cleanly on SIGTERM.

## How to link your Telegram account

Only allowlisted Telegram user ids get any reply. Linking is two steps:

1. Send `/start` to your bot in Telegram. The bot will not reply yet,
   because you are not allowlisted. The terminal where the bot runs
   prints your numeric Telegram user id, and the attempt is written to
   the audit log as a `telegram_unauthorized` event.
2. Allowlist yourself from the terminal:

```bash
node dist/index.js telegram-allow --user-id <id> --label "Your Name"
```

Then send `/start` to the bot again. Now it replies. The label is only a
name you choose so the audit log is readable. The bot never reads your
Telegram username.

Other allowlist commands:

```bash
node dist/index.js telegram-allowlist
node dist/index.js telegram-deny --user-id <id>
node dist/index.js telegram-link
```

`telegram-link` prints the exact steps above. The allowlist lives in
gitignored `state/telegram.json`, one record per user with a numeric id, a
label, and an added time. It is never in the repo. `telegram-deny`
removes a user at once: that user gets no reply from the bot any more,
and the removal does not delete any profile or log anyone out.

## Commands the bot answers

All commands are read-only except `/packet`, which creates a draft packet
only.

| Command | What it does |
| --- | --- |
| `/start` | Greets you, confirms you are allowlisted as your label, and lists the commands. |
| `/help` | The full command list, with what the bot can and cannot do. |
| `/status` | Harness version, tenant, HOLD, budget cap and spend, models connected, browser accounts. |
| `/models` | The 9 subscription models, provider, and connected or not connected, with the connected-means-packet-only legend. |
| `/projects` | Connected projects, kind, status, and allowed task types. |
| `/browser_status` | Browser accounts, provider, login state, and connected or disconnected. |
| `/analytics_status` | Analytics on or off, install id presence, last preview, last send never. |
| `/analytics_preview` | The exact counts-only payload Phase 1 would send. Nothing is sent. |
| `/audit` | The last 10 audit events for this tenant: time, event, result. No detail text, so no prompt content can leak. |
| `/packet --model <id> --type <type> --title "<title>" --task "<task>" [--project <id>]` | Creates a draft packet, exactly like the CLI packet command. Refused when HOLD is on, when the model is not connected, or when the project scope is wrong. |
| `/run_browser` | Refused, always. Browser jobs run from the CLI only. |

Unknown commands get a short reply naming `/help`. Plain text that is
not a command gets the same. Replies are capped at 4000 characters.

Example:

```
/packet --model chatgpt --type seo --title "ClientHuntAi post" --task "Write a draft about finding clients without a website."
```

The bot replies with the packet file path, for example
`packets/sadat-riyad/chatgpt-seo-clienthuntai-post-<timestamp>.md`. You
then copy that packet into ChatGPT yourself, exactly as with a CLI
packet. The bot does not send it anywhere.

## What the bot cannot do

- It cannot run a browser job. `/run_browser` is refused with a message
  that browser jobs run from the CLI only. There is no browser job path
  from Telegram in V1.9.
- It cannot send, publish, post, merge, or deploy anything. Packet
  creation is the only write, and a packet is a draft file on disk.
- It cannot change the budget cap, the HOLD state, the tenant, or the
  allowlist. Those stay on the CLI.
- It cannot read prompt text, result text, project names, account
  labels, emails, or credentials. `/audit` prints event names and
  results only, never detail text. `/analytics_preview` prints counts
  only.
- It cannot answer a user who is not allowlisted. A non-allowlisted
  user gets no reply at all, not even an error message.

## Safety rules

- **Token only from the environment.** The token comes only from
  `TELEGRAM_BOT_TOKEN`. It is never read from a config file, never
  logged, never printed, and never stored. The module holds no hardcoded
  token; a test scans the source for a token-shaped literal.
- **Allowlist first.** Only allowlisted numeric user ids get any reply.
  A non-allowlisted id gets no reply at all, and the attempt is audit
  logged once per minute per user, so one stranger cannot flood the log.
- **HOLD blocks all Telegram writes.** HOLD blocks `/packet` with a
  message that HOLD is on. Read-only commands still work under HOLD.
- **Budget cap 0 still blocks paid API calls.** The bot never places an
  API call, and the cap is unchanged by Telegram.
- **Rate limit.** Each user may send at most 20 commands per minute.
  The 21st gets a polite slow-down reply and is audit logged as
  `telegram_rate_limited`. The limit is per user, in memory, and resets
  each minute.
- **Audit log.** Every Telegram command writes exactly one audit event
  per tenant, with the numeric Telegram user id only, plus the
  owner-given label when one exists. No username is ever logged.
  Unauthorized attempts are logged as `telegram_unauthorized`.
- **One tenant per bot run.** The bot serves one tenant. To serve
  another tenant, start another bot process with `--tenant <id>` and a
  different bot token.

## Files

- `src/telegram/bot.ts`: the bot client (long polling with getUpdates
  and sendMessage over Node built-in fetch), the allowlist, the command
  handlers, the rate limit, and the audit logging. No new dependency.
- `tests/run-telegram-tests.mjs`: 17 groups, temp dirs only, mock
  Telegram API only, never api.telegram.org, no real token.
- `state/telegram.json`: the allowlist, gitignored, never in the repo.

## Tests

`npm test` now runs 119 groups: V1 7, browser 10, live driver 9,
projects 12, tenants 14, models 15, connection 15, model-connect 9,
analytics 11, telegram 17. The telegram suite covers: allowlist add,
list, and remove; bad ids and labels rejected; unauthorized user gets no
reply and is audit logged; unauthorized repeat throttled to once a
minute; /start and /help through pollOnce; /status contains version and
HOLD; /models lists connected state; /packet creates a packet file and
exactly one audit event; HOLD blocks /packet; token missing refuses
start and the module holds no hardcoded token; rate limit on the 21st
command; one audit event per command; /run_browser refused;
analytics_preview prints the counts-only payload with no secret text;
/audit returns the last 10 events with no detail text; real CLI
telegram-allow, telegram-allowlist, telegram-link, and telegram-start
refusal in a scratch copy.

## What is still NOT done

- No live bot run yet, because no real token exists. The bot has only
  been run against a mock Telegram API in tests.
- No webhook mode. Long polling only.
- No browser jobs from Telegram. `/run_browser` is refused by design.
- No Phase 2 analytics service. `/analytics_preview` is still a dry-run
  preview, and `analytics-enable` is still refused.
- No dashboard connection yet. The TrustyHarness space panel does not
  start or stop the bot; the bot runs from the terminal.
