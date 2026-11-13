# V2.4: Live Relay Hook

Date: 2026-11-14. Status: V2.4 local only, multi-tenant, public repo. Version 2.4.0. No central service, no data leaves the machine, no deploy, no live paid API, no credential stored.

## The problem this fixes

The owner asked a plain question: when he writes in the Telegram bot, the reply takes 1 to 3 minutes, so can it be real-time with Muse? The acknowledgement was already real-time: the bot sends "Got it. Muse will reply here." within seconds of the message arriving, because it long-polls Telegram. The wait was the Muse reply, and most of it was the schedule: the relay cron runs every 1 minute, so a message waits up to 1 minute for the next run, then the agent starts and thinks. The fix is to stop waiting for the clock and wake the relay the moment a message lands.

## What V2.4 adds

A runtime hook, id `telegram-live-relay`, poll interval 10 seconds.

- Hook script: `~/hooks/scripts/telegram-inbox-watch.sh`. The script lives outside the harness repo, under the hooks dir, because hooks live under `~/hooks/scripts/` with state under `~/hooks/state/`.
- The script follows the hook protocol exactly: `#!/usr/bin/env bash`, `set -euo pipefail`, it sources `$HATCH_HOOK_RUNTIME`, it locks with `flock` on the hook state dir, and it ends with exactly one `silent` or `wake` call.
- Each poll it reads `state/telegram-inbox.jsonl` with `jq` and looks for lines with status `new`. It wakes only when a `messageId` appears that it has not seen before. It keeps a watermark of seen message ids in the hook state dir, never in the harness state, and never reads message text into the payload: the wake payload holds only the new message ids and their count.
- A dry run (`HATCH_HOOK_DRY_RUN=1`) never writes the watermark, so it never consumes a detection. The decision is still reported, but the next real poll wakes for the same ids.
- If the inbox file does not exist, the script stays silent. If the relay lock file exists and is younger than 10 minutes, the script stays silent, because another run is already working; the new message stays unwatermarked, so the next poll after the lock clears wakes for it.
- A corrupt inbox line is skipped, never fatal.

## The worker the hook wakes

The worker prompt is self-contained: it tells the worker to read the exact contract file `scripts/telegram-relay.md` and follow it exactly (harness root, tenant sadat-riyad, only allowlisted user 1891427699, at most 5 new messages oldest first, replies to the outbox, thread update, inbox lines done only after their reply is written, relay status file, lock removal, stay silent in chat for routine runs, report only when approval is needed in the Muse app or the relay itself fails, never deploy, push, merge, publish, log in, type a password, enter a one-time code, or solve a CAPTCHA, budget cap 0, no paid API call, no long dash characters). There is no second contract: the hook worker and the cron worker follow the same file.

## The 5-minute cron stays

The hook makes replies faster; it does not replace the cron. The scheduled relay job every 5 minutes stays as a safety net. It still picks up anything the hook misses, for example a message that arrived while a relay run was already working, or a line the worker failed to finish. Do not remove the cron.

## What the latency is now

- Fixed acknowledgement: seconds, unchanged.
- Simple reply: about 10 to 30 seconds once the hook wakes the worker, plus the time Muse needs to answer.
- A job with browser steps: still as long as the models take to answer, minutes for ChatGPT and Gemini. The hook only removes the wait for the next run; it cannot make a model answer faster.
- Honest limit: this is near real-time, not instant, and not a webhook. A Muse agent run still has to start and think, the bot still uses long polling, and the machine must be running. If the machine is off, messages wait in the inbox until the next run.

## Duplicate-reply race, found live and fixed in 2.4.1

On 2026-11-14 a cron relay run and a hook relay run both answered
Telegram message 897967623, 4 seconds apart, and the user got two
identical replies in Telegram. The duplicate cannot be unsent. Root
cause: the lock was check-then-create, so both runs saw no lock and
both proceeded. The fix, in the relay contract
(`scripts/telegram-relay.md`): the lock claim is atomic with `mkdir
state/telegram-relay.lock.d`, exactly one run wins and the loser
exits at once; the winner writes `state/telegram-relay.lock` inside
the directory; the run re-checks the lock after reading the inbox;
lines already `processing` are skipped. The hook script also treats
the lock directory as running. Verified with a scratch simulation:
two concurrent claims, one WON, one LOST with File exists, exactly
one directory.

## Known limits

- A relay run that takes longer than 10 minutes makes its lock look dead to the next worker, the same as under the cron. The contract caps each step at 10 minutes, so a run should not normally pass that. This is a pre-existing contract rule, not a new risk from the hook.
- The hook cannot wake a worker while the machine is off or the scheduler is down. The cron has the same limit.
- The panel does not show hook status yet. The hook logs live under `~/hooks/logs/telegram-live-relay.jsonl`.

## Safety

- The hook script never reads message text, never writes to any harness state file, never sends anything to Telegram, never calls api.telegram.org, and never touches a credential. The wake payload holds only message ids and a count.
- The hook never changes the allowlist, the budget cap, or the safety rules. The worker it wakes follows the same contract, HOLD, and deploy gate as the cron worker.
- The hook polls local files only. No network call, no public endpoint.

## Tests

New test group 66 in `tests/run-telegram-tests.mjs`, temp dirs only, no live network, no real token: the hook script file exists and is executable, it contains the required protocol lines (`#!/usr/bin/env bash`, `set -euo pipefail`, sourcing `$HATCH_HOOK_RUNTIME`, `silent`, `wake`, `hook_state_get`, `hook_state_set`, `HATCH_HOOK_DRY_RUN`), it contains no token-like pattern, and the watermark logic works on a scratch inbox file with a stub runtime (first run wakes for two new ids and records them, second run stays silent, a dry run wakes but does not write the watermark, a real run then wakes for the same id, a young lock stays silent, a missing inbox stays silent). `npm test` now runs 183 groups.

## Still not done

- The real proof is the user's next Telegram message arriving once, not twice, after the atomic lock fix. The hook has woken live for message 897967622, and the race was proven live by the duplicate replies to message 897967623.
- The panel does not show hook status yet.
- No webhook mode. Long polling only.
- No deploy from Telegram. The deploy gate decision (option A, B, or C, in writing) is still open.
