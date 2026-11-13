# V2.1: The Telegram Bot Starts From the Dashboard

Version 2.1.0. Tests: 152 of 152 pass (telegram 50). This version fixes
the exact failure the owner hit on the first live bot run: the token
was saved in the TrustyHarness panel, but `/start` got no reply,
because the panel only saved the token and never started the bot, and
the allowlist was empty. V2.1 makes the bot startable from the
dashboard, with one supervisor behind both the panel Start button and
the CLI, and fixes the poll loop bug the live bot log showed.

## What went wrong on the first live run

1. The token was saved correctly in `state/telegram.json` under
   `botToken`. The panel did its job.
2. No bot process was running. The panel never starts the bot, and
   nobody had run `telegram-start` in the terminal. A token alone does
   not start a bot: something has to run the long-poll loop.
3. The allowlist was empty. Even with the bot running, a
   non-allowlisted user gets no reply at all, by design. The owner had
   not allowlisted their own Telegram user id yet.

The live bot log also showed the second bug V2.1 fixes: repeated
`poll failed, retrying in 5 seconds. TimeoutError: The operation was
aborted due to timeout`, followed once by `Telegram API call failed
for getUpdates: HTTP 409`. See the poll loop section below.

## What V2.1 changes

- `telegram-start` is supervisor-managed. It starts the bot in the
  background through `scripts/telegram-bot-supervisor.sh`, and the
  panel Start button runs the same supervisor. There is exactly one
  way to start the bot.
- The supervisor adopts a bot that is already running instead of
  starting a duplicate. It writes the running pid into
  `state/telegram-bot.pid`.
- The bot writes a heartbeat, `state/telegram-heartbeat.json`, on
  every poll, so the panel can show RUNNING or STOPPED honestly.
- `telegram-stop` stops the bot through the supervisor, and
  `telegram-status` reports running or stopped, the pid, the token
  source, the allowlist count, and the heartbeat last poll time. The
  token value is never printed anywhere.
- The poll loop never overlaps `getUpdates`, and a 409 backs off for
  15 seconds instead of 5.

## The supervisor contract (for the panel change)

The panel change comes after this CLI work. It must use exactly this
contract, no other way to start or stop the bot.

### Commands

- Start: `node dist/index.js telegram-start [--tenant <id>]`
- Stop: `node dist/index.js telegram-stop`
- Status: `node dist/index.js telegram-status`
- Direct script: `bash scripts/telegram-bot-supervisor.sh <start|stop|status|restart> [rootDir] [tenantId]`

The script is the single implementation. The CLI commands delegate to
it, except `telegram-status`, which reads the pid file and the
heartbeat directly and is the status text the script itself delegates
to. `telegram-run` is the foreground runner the supervisor starts in
the background; it is not for hand use. `telegram-start` is the
supported way to start the bot.

### Files

- `state/telegram-bot.pid`: pid of the supervised bot. Written by the
  supervisor on start and on adopt. Removed by the supervisor on stop.
- `state/telegram-heartbeat.json`: written by the bot on every poll
  and once at start and once at stop. Fields: `lastPollAt` (ISO time
  or null), `running` (true while the bot loop runs), `pid`, `tenantId`,
  `tokenSource` (`env`, `file`, or `none`), `allowlistCount`,
  `lastError` (string or null). Never holds the token.
- `logs/telegram-bot.log`: bot stdout and stderr, appended by the
  supervisor. The bot prints the numeric id of an unknown user here
  once per minute, so the owner can allowlist it.
- `state/telegram.json`: the token under `botToken` and the allowlist
  under `users`. Unchanged by the supervisor, except that the panel
  token box writes the token there.

All four files are gitignored (`state/` is ignored as a whole, and
`logs/` is ignored). The pid file and the heartbeat file are never
committed.

### Start behaviour

1. If the pid file holds a live telegram bot process, start reports
   `already running (pid X). Adopted into state/telegram-bot.pid.` and
   exits 0. No second bot is started.
2. Otherwise, if a bot process is found by exact argv
   (`node <path>/dist/index.js telegram-start|telegram-run`) with its
   working directory equal to the harness root, start writes that pid
   into the pid file, reports the same adopt message, and exits 0.
   The working directory filter keeps one install from adopting
   another install's bot. The script's own process and its ancestors
   are excluded from the search, so the shell or the CLI that invoked
   the supervisor is never mistaken for the bot. The argv check must be
   exact, not a substring match: a parent shell that launched the bot
   holds the same words in its own command line, and the first adopt
   run on the live install proved it by adopting the shell pid 23749
   instead of the bot pid 23752. Only a process whose argv is node,
   then dist/index.js, then telegram-start or telegram-run counts.
3. Otherwise, start checks the token with `telegram-token-status`. No
   token means start refuses with `No Telegram bot token found` and
   exits non-zero. No token is ever printed.
4. Otherwise, start launches `node dist/index.js telegram-run` in the
   background with output appended to `logs/telegram-bot.log`, writes
   the pid into the pid file, waits 2 seconds, and reports `started
   (pid X)`. If the process died in those 2 seconds, start removes
   the pid file and reports the failure.

### Stop behaviour

Stop kills only a telegram bot process. It prefers the pid in the pid
file, and falls back to a running bot found by exact argv, but only
when that process is a telegram bot (`node` then `dist/index.js`
then `telegram-start` or `telegram-run`). It sends SIGTERM, waits up to 10
seconds, then SIGKILL, then removes the pid file. A process that is a
zombie counts as dead: a zombie still answers `kill -0`, but its
parent has not reaped it yet, and waiting on it would hang the stop
for the full 10 seconds and then report failure for a bot that is
already dead. The supervisor checks the process state, and the CLI
`isProcessAlive` does the same through `/proc`.

### Status behaviour

`telegram-status` prints:

- `Telegram bot: RUNNING` or `STOPPED`
- `Pid: <pid>` or `none`, with `(not supervised yet, run
  telegram-start to adopt it into the pid file)` when a bot runs
  without a pid file
- `Token: set (source: env|file)` or `not set`
- `Allowlisted users: <count>`
- `Last poll: <ISO time>` or `never`
- `Last poll error: <message>` when the last poll failed
- A note when the heartbeat says running but no bot process is alive
  (stale heartbeat), and a note when a bot runs with no heartbeat file
  yet (it started before V2.1 or has not polled yet)

Running is decided by a live process, never by the heartbeat alone: a
crashed bot leaves a stale running heartbeat behind.

### What the panel must do

- The token box saves the token, then runs the supervisor start. When
  start reports running or started, the panel shows RUNNING. When
  start fails, the panel reports the failure plainly and shows the
  terminal command `node dist/index.js telegram-start`. It never
  claims the bot is running when the supervisor failed.
- The Start button runs supervisor start. The Stop button runs
  supervisor stop. The status line reads the heartbeat file: RUNNING
  when the heartbeat is fresh and a bot process is alive, STOPPED
  otherwise. A heartbeat older than 120 seconds counts as stale,
  because a healthy bot polls every 25 seconds.
- The panel never starts the bot any other way, never stores the
  token in its own database (only the last 4 characters and the
  timestamp, as in V2.0), and never prints the token.

## The poll loop fix (HTTP 409)

The live log showed repeated client TimeoutErrors, then one HTTP 409.
The root cause: the client abort timeout was 10 seconds past the
server long-poll hold, and a slow network made the client abort while
Telegram still held the request. The retry then started a new
`getUpdates` while the old one was still open on Telegram's side, and
Telegram answered the overlap with HTTP 409 (conflict: terminated by
another `getUpdates` request).

Three changes, all in `src/telegram/bot.ts`:

1. The poll timeout is 25 seconds, and the client abort is 30 seconds
   past that (55 seconds total). An abort now only fires on a genuine
   network stall, never on a normal long-poll hold.
2. The poll loop is guarded: `pollOnce` returns at once when a
   `getUpdates` is already in flight, so a second request can never
   start while the first is open. The guard is in the bot, not in the
   caller, so no caller can overlap by accident.
3. A 409 is treated as a conflict, not a plain failure: the bot logs
   `poll conflict (HTTP 409)` and backs off for 15 seconds, not 5.
   Other poll failures still retry after 5 seconds.

Proved by tests, mock API only, never `api.telegram.org`: a mock
`getUpdates` that takes longer than the retry interval never triggers
a second concurrent call, through `pollOnce` and through `run()`; a
409 response records a 15-second backoff and a plain failure records
a 5-second backoff; the bot passes a 25-second timeout to
`getUpdates`.

## The currently running bot

The bot that was started by hand before V2.1 (pid 23752 at the time
of the build) runs the V2.0 code. The supervisor adopts it when
`telegram-start` next runs: it writes the pid into
`state/telegram-bot.pid` and treats it as running. That bot has no
heartbeat file and no poll fix until it is restarted with
`telegram-stop` and `telegram-start`. Restarting it is a normal stop
and start, not a fix for a broken bot: the old bot still polls and
still answers allowlisted users, it just cannot prove it is alive
through the heartbeat, and it can still hit the 409 overlap.

## Commands

- `node dist/index.js telegram-start [--tenant <id>]`: start the bot
  through the supervisor, or adopt a running one. Refuses with no
  token.
- `node dist/index.js telegram-stop`: stop the bot through the
  supervisor.
- `node dist/index.js telegram-status`: running or stopped, pid, token
  source, allowlist count, last poll time. Never the token value.
- `node dist/index.js telegram-run`: foreground runner, supervisor
  only. Do not run it by hand.
- `node dist/index.js telegram-token-status`: set or not set, and the
  source, never the value.
- `node dist/index.js telegram-token-clear`: removes the file token,
  keeps the allowlist.

## What is still NOT done

- No panel Start button yet. The supervisor and the CLI contract are
  built; the panel change that calls them comes next.
- No live bot run on V2.1 code yet. The running bot predates V2.1 and
  needs a restart to pick up the heartbeat and the poll fix.
- No webhook mode. Long polling only.
- No deploy from Telegram. The deploy gate is unchanged from V2.0.
