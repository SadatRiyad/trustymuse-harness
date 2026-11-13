# V2.5 Bot Auto-Restart

Date: 2026-11-14. Status: built and verified live, local only. Version 2.5.0.

## The problem

On 2026-11-14 about 02:40 +06 the Telegram bot died when a poll failed
with `TypeError: fetch failed`, and there was no auto-restart, so it
stayed down until a manual restart about 02:46 +06. A transient network
failure killed the process, and nothing watched it. The user asked for
auto-restart on 2026-11-14 about 03:47 +06.

## The design: a hook-based watchdog

Same pattern as the live relay hook (V2.4). A Bash polling script
watches the bot pid file and heartbeat file and wakes a worker agent
ONLY when the bot is dead or unresponsive. The script never kills
anything and never starts anything itself. The worker restarts the bot
only through the supervisor, which never starts a second bot while one
is running.

- Hook: `telegram-bot-watchdog`, poll every 30 seconds.
- Script: `~/hooks/scripts/telegram-bot-watchdog.sh` (outside the repo,
  under the hooks dir, like the live relay script).
- Worker prompt: self-contained, points at the supervisor, verifies the
  restart, stays silent for routine restarts, reports only when it gives
  up. Delivery: this side chat.

## What the script checks, in order

1. `state/telegram-bot.stopped` exists: the user stopped the bot on
   purpose. Stay silent, never restart it.
2. `state/telegram-bot-watchdog-disabled` exists: the worker gave up
   after repeated failed restarts. Stay silent until the user starts
   the bot again by hand, which clears the marker.
3. No pid file: the bot was never started, or it was stopped on purpose
   (stop removes the pid file). Stay silent.
4. Pid file holds a pid that is not alive (kill -0 fails, or the
   process state is Z for zombie): wake, reason `bot crashed`.
5. Pid is alive but the heartbeat is stale: `state/telegram-heartbeat.json`
   `lastPollAt` is older than 90 seconds, or the file is missing and the
   pid file is older than 120 seconds (a bot that just started has not
   polled yet). Wake, reason `bot unresponsive`.
6. Pid alive and heartbeat fresh: stay silent, reason `bot healthy`.

The script never reads or logs a token. The wake payload holds only the
reason, the last pid, and the heartbeat age in seconds. A dry run never
writes the watermark. One failure wakes at most once per 5 minutes, so
a dead bot does not wake a worker on every poll while the worker is
restarting it.

## The intentional-stop signal

`telegram-stop` writes `state/telegram-bot.stopped` before killing
anything, and removes the pid file on stop. A successful
`telegram-start` (including adopting an already-running bot) clears
both the stopped marker and the watchdog-disabled marker. A failed
start does not clear them, so a start that fails keeps the stopped
signal. The marker is a plain text file under `state/`, never a
credential. This closes the short window where the pid is already dead
and the pid file is not removed yet.

## What the worker does

1. Checks first whether the bot is already back (`telegram-status`
   RUNNING, heartbeat fresh within 60 seconds, pid file holds a live
   process). If healthy, it does nothing and finishes silently.
2. Restarts only through the supervisor:
   `bash scripts/telegram-bot-supervisor.sh restart <root> sadat-riyad`.
   Never launches `node dist/index.js` directly.
3. Verifies within 60 seconds: RUNNING, fresh heartbeat, live pid,
   exactly one bot process.
4. Tracks attempts in `state/telegram-bot-watchdog.json`: each entry
   holds at, reason, oldPid, newPid, and result. Entries older than 1
   hour are pruned.
5. Gives up when the bot does not come back after 2 restart attempts,
   or when it crashed 3 times within 10 minutes. On giving up it writes
   `state/telegram-bot-watchdog-disabled` with the reason and time,
   leaves the bot down, and reports to this chat plainly that the bot
   is down and auto-restart has stopped. The user starts it again from
   the TrustyHarness panel or with `node dist/index.js telegram-start`,
   which clears the marker and re-enables the watchdog.
6. Stays silent in this chat for a routine successful restart.

The worker never logs in, types a password, enters a one-time code,
solves a CAPTCHA, deploys, pushes, merges, or publishes. It never puts
a token, key, password, or secret into any message, file, or audit
event. Budget cap is 0.

## Live crash test

On 2026-11-14 about 22:09:30Z the real bot (pid 3664) was killed once
with `kill` (SIGTERM, not a supervisor stop, so it looked like a
crash). The watchdog woke 15 seconds later with reason `bot crashed`
and lastPid 3664. The worker restarted it through the supervisor: new
pid 76416, heartbeat fresh at 22:10:41Z, token set (source file),
allowlist still 1 user (1891427699), exactly one bot process. Time from
kill to a healthy bot: about 70 seconds. No duplicate bot, no stopped
marker left behind.

## Known limits

- The watchdog polls every 30 seconds, so a crash is noticed within
  about 30 seconds, plus the worker startup time. It is not instant.
- If the machine is off, nothing watches the bot. The watchdog only
  runs while the machine runs.
- A crash loop that the worker gives up on stays down until the user
  starts the bot by hand. That is deliberate: restarting forever would
  hide a real failure.
- Restarts are recorded in `state/telegram-bot-watchdog.json`, not in
  the audit log, so they do not appear in the panel Tasks tab yet.
- The panel does not show watchdog status yet.

## What is still NOT done

- No push yet. The V2.5.0 commit is for the parent to make.
- Panel watchdog status (hook state, last restart, give-up state).
- The supervisor marker change was partly committed under V2.4.1
  (commit 2ff4445) with the atomic relay lock fix, because it landed
  in the same batch; the final piece (stop writes the marker, a
  successful launch clears it) is still uncommitted in the working
  tree and belongs in the V2.5.0 commit.
