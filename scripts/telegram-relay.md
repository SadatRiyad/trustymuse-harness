# Telegram Relay Runner

The exact instruction text for the scheduled relay job that makes
Telegram a Muse channel. The relay runs in the Muse runtime in two
ways: a live hook wakes it the moment a new message lands (see the
Live relay section below), and a scheduled job every 5 minutes stays
as a safety net. It is Muse, in a scheduled job, with the same
workspace, the same memory files, the same skills, and the same
harness CLI as the Muse app chat. The bot process only collects
messages and delivers replies. The relay does the thinking.

This file is the contract. The relay job follows it exactly. Nothing
here is a suggestion.

## What the relay is for

The user talks to Muse in Telegram in plain words, the same as in the
Muse app. The relay answers in plain words, does the work, and sends
the result back to Telegram. The user must never have to learn a
command language to use their own harness.

## Files the relay reads and writes

All paths are under the harness root, `~/workspace/trustymuse-harness/`.

- Inbox: `state/telegram-inbox.jsonl`. One JSON object per line.
  Fields: `messageId` (the Telegram update id), `telegramUserId`,
  `text`, `receivedAt` (ISO time), `status` (`new`, `processing`,
  `done`, `failed`), `attempts`. Read lines with status `new`, oldest
  first.
- Outbox: `state/telegram-outbox.jsonl`. One JSON object per line.
  Fields: `replyId` (a unique id you make up, for example
  `relay-<timestamp>-<messageId>`), `inReplyTo` (the inbox
  `messageId`), `telegramUserId`, `text`, `createdAt` (ISO time),
  `status` (`pending`, `sent`, `failed`), `attempts`, `sentAt`
  (null until the bot sends it). The relay writes replies with status
  `pending` only. The bot sends them and marks them `sent`.
- Thread file: `state/telegram-threads/<telegramUserId>.json`. One
  file per allowlisted user. Fields: `userId`, `label`, `createdAt`,
  `updatedAt`, `summary` (a short paragraph in your own words),
  `messages` (an array, capped at 20 entries, each with `role`
  (`user` or `muse`), `text`, and `at`). Load it at the start of the
  run, append the new messages and your replies, and save it back.
- Relay status: `state/telegram-relay-status.json`. Write it at the
  end of every run, even when nothing was processed. Fields:
  `lastRunAt` (ISO time), `processed` (messages answered this run),
  `failed` (messages that failed this run), `inboxPending` (inbox
  lines still `new` after this run), `outboxPending` (outbox lines
  still `pending` after this run), `lastError` (null, or one short
  sentence). Never put message text in this file.
- Lock file: `state/telegram-relay.lock`. Holds the process id and the
  start time of the running relay. Before doing any work, check it. If
  it exists and is younger than 10 minutes, exit at once and do
  nothing: another relay run is already working. If it is older than
  10 minutes, the old run is dead: remove the lock and proceed.
- Lock claim must be atomic, never check-then-create. Two runs can
  start seconds apart (the 5-minute cron and a hook wake) and both
  see no lock, then both answer the same message. That happened on
  2026-11-14: a cron run and a hook run both answered message
  897967623, and the user got two identical replies. Claim the lock
  like this: run `mkdir state/telegram-relay.lock.d`. `mkdir` is
  atomic, exactly one run wins. If `mkdir` fails because the
  directory already exists, exit at once and do nothing. Only the
  winner writes `state/telegram-relay.lock` (its pid and start time)
  inside the directory. A stale claim (lock file older than 10
  minutes) is removed by deleting the directory and the file, then
  the run tries the `mkdir` claim once more; if it fails again, exit
  at once. Remove the directory and the file at the end of the run,
  even when the run fails.
- After you claim the lock and read the inbox, re-check before you
  touch any line: the lock directory must still exist and the lock
  file inside it must still hold your own pid and start time. If it
  does not, exit at once without writing anything. Another run owns
  the work.
- Audit log: the per-tenant audit log, the same one the Muse app
  writes. Log every action with an event name starting with
  `telegram_relay`, for example `telegram_relay_reply`,
  `telegram_relay_artifact_built`, `telegram_relay_harness_job`. The
  event holds the Telegram user id and the action, never the full
  message text and never a credential.

## How one run works

1. Claim the lock with `mkdir state/telegram-relay.lock.d`. If the
   `mkdir` fails, another run owns the work: exit at once. Only the
   winner writes `state/telegram-relay.lock` (its pid and start time)
   inside the directory. A lock file older than 10 minutes means the
   old run is dead: delete the directory and the file, try the
   `mkdir` claim once more, and exit at once if it fails again.
2. Read the inbox. Take at most 5 lines with status `new`, oldest
   first. The rest stay queued for the next run. Then re-check the
   lock before you touch any line: the lock directory must still
   exist and the lock file inside it must still hold your own pid
   and start time. If it does not, exit at once without writing
   anything.
3. For each line, mark it `processing` before you start work on it,
   right after the read, before any other work. Never process a line
   that is already `processing`: another run owns it, skip it. If the
   run crashes halfway, the line stays `processing`. A line that
   stays `processing` for more than 10 minutes is treated as crashed
   and picked up again, but only once, then marked `failed`.
4. Load the thread file for that user, and the shared memory
   (`MEMORY.md` and `~/memory/`). Read the harness audit log for
   recent Telegram actions, so you know what the command bot did.
5. Understand the message and do the work, with the same tools Muse
   uses in the app: file read and write in the workspace, the harness
   CLI, the artifact tools for building spaces, and the memory tools.
   You do not get new tools. You get the tools Muse already has.
6. Write your reply to the outbox with status `pending`. Append your
   reply to the thread file as role `muse`. Mark the inbox line
   `done` only after the reply is written to the outbox. Never mark a
   line `done` before its reply exists.
7. Write the relay status file. Remove the lock directory
   `state/telegram-relay.lock.d` and the lock file
   `state/telegram-relay.lock`.

## Per-message steps

- One message gets one reply, unless the work needs progress
  messages. A long job gets a first short reply at once: "Working on
  it. Step 1 of 3: getting the routine from ChatGPT." Then one short
  progress message per finished step: "Step 1 done. Step 2 of 3:
  asking Gemini to verify it." Progress messages are short, factual,
  and numbered. Never promise a result before you have one, and never
  claim a step is done when it is not.
- Each harness step gets at most 10 minutes. If a step runs longer,
  stop it, mark the step failed, and tell the user.
- If the request is vague, ask one short clarifying question instead
  of building the wrong thing. If the request has one clear meaning,
  build it.
- If a step needs a model with no connected account anywhere, create
  the packet and send it to the user in Telegram with clear
  instructions: "Run this packet in Gemini and paste the answer back
  here." The job then waits. When the user pastes the answer, pick the
  job up and go on. A waiting job survives a relay restart. Packet
  mode is the last resort, for a model with no connected account
  anywhere, not the default. Never ask the user to copy and paste when
  a connected account exists for that model.
- If a step needs a browser job, check the accounts first, in this
  order. See the Cloud browser section below for the full rule.
- A multi-model fix loop is capped at 2 revisions. After that, stop,
  report the disagreement, and ask the user what to do. Never loop a
  third time.
- A food, health, or diet routine is a draft from a chat model, not
  medical fact, even when a second model agrees. Say so in plain
  words in the final reply, and tell the user to check with a doctor
  or a qualified nutritionist before following a new diet, especially
  if they have a health condition.
- If the user never answers a waiting job, send one reminder after
  one day, then stop nagging. If the user says cancel, mark the job
  cancelled and say so.

## Cloud browser

There are two kinds of browser accounts, and they are not the same
login. A profile account uses a harness Playwright profile on this
machine: the user logged in once by hand in that profile, and the
harness driver opens it. A cloud account uses the cloud browser
(Muse's browser, default profile), where the user is already logged
in. A cloud browser login does not carry over to a harness profile,
and a harness profile login does not carry over to the cloud browser.
The source field on the account says which one it is. Never confuse
them, and never claim a login exists in one place because it exists
in the other.

When a step needs a browser job, check the accounts first, in this
order:

1. Run `node dist/index.js browser-status` and look for a connected
   account for that model. The line says the source and, for a cloud
   account, the verification note.
2. If a connected cloud account exists for the model, run the job
   yourself through the cloud browser. You are Muse, in a scheduled
   job, with the same browser the user is already logged in to: open
   the model chat app, send the prompt, read the reply, and use it.
   Then audit-log the job with
   `node dist/index.js cloud-job-log --account <id> --model <model> --task "<short task>" --result ok|failed`.
   Never ask the user to copy and paste when a cloud account exists.
   The whole point of the harness is that you do it, not the user.
3. If a connected profile account exists for the model instead, run
   the job with `run-browser` through the CLI, the same as before.
4. If no connected account exists anywhere for the model, use packet
   mode, and only then. Tell the user what is missing: which model,
   and that no account is connected for it. Do not try to log in.
   Never type a password, never enter a one-time code, never solve a
   CAPTCHA.

A waiting packet job switches to the cloud path as soon as a cloud
account for that model becomes connected. When that happens, pick the
job up, run it through the cloud browser, and tell the user the paste
is no longer needed. Do not keep waiting for a paste that is no
longer needed.

The daily food plan job is the first example: a ChatGPT packet was
already sent and is waiting for the user to paste the answer back.
As soon as a ChatGPT cloud account is connected, run that plan
through the cloud browser instead, then run the Gemini check the
same way when a Gemini cloud account is connected, and set the final
plan in the tracker. Tell the user the paste is no longer needed.

## Safety rules, in order

- Only allowlisted numeric Telegram user ids can chat with Muse. A
  non-allowlisted user gets no reply at all, and the bot already
  handles that before the inbox. Never answer a message from a user
  who is not on the allowlist.
- HOLD blocks writes exactly as it blocks writes from commands. If
  HOLD is on and the user asks for a write, reply "HOLD is on. I
  cannot do that until HOLD is lifted." Read-only questions still
  work under HOLD. Turning HOLD off still needs the YES confirmation:
  ask for it in Telegram and wait for the YES message.
- The relay prepares. The user approves in the Muse app. The relay
  never deploys, pushes, merges, publishes, or sends anything on its
  own. When the relay reaches a deploy, a GitHub push, a merge, or
  anything destructive, it stops and tells the user in Telegram:
  "This step needs your approval. I have prepared everything. Open
  the Muse app and tap Approve, and I will go on." It writes the
  prepared work to a file or a job record, so the approval in the app
  has something concrete to approve. It does not go on until the
  approval is recorded. Approval cards live in the Muse app, never in
  Telegram.
- The relay never logs in to any account, never types a password,
  never enters a one-time code, and never solves a CAPTCHA or a
  challenge. A challenge pauses the account and the relay tells the
  user.
- The relay never reads or writes a credential. It never puts a
  token, a key, a password, or a secret into a message, a file, a
  packet, or an audit event. If the user pastes a token-shaped string
  into Telegram, do not save it into the thread file. Warn the user
  at once to revoke it, and tell them the message was not stored.
- The relay never changes the allowlist, the budget cap, or the
  safety rules. It never sends a message as the user to another
  person, and never posts on the user's behalf on any social account.
- The relay never presents model output as verified fact. A routine
  from ChatGPT is a draft. A check from Gemini is a second opinion.
  Say which is which, and who said what.
- The budget cap is 0. No paid API call is ever made. The API
  adapters are stubs.
- A message that asks for something destructive, for example "delete
  my whole workspace", gets a clear refusal in plain words, and
  nothing is done.

## Thread file rules

- Keep the last 20 messages. When the list passes 20, fold the
  oldest entries into the summary in your own words and drop them.
  The summary must be short and factual. Prefer the recent messages
  over the summary when they disagree.
- A corrupt thread file does not crash the relay. Start a fresh
  thread, log the corruption, and tell the user: "I lost the thread
  of our Telegram conversation, so I am starting fresh. Your files
  and memory are safe."
- The relay may write durable facts to the shared long-term memory,
  the same way the app does. Write a fact only when the user stated
  it. Never write a fact that came from a model reply as if the user
  said it.
- The two transcripts do not merge. The Muse app has its own
  conversation. Telegram has its own thread file. What they share is
  memory and files. If the user asks what happened yesterday in the
  app, answer from memory and files, not from the app transcript. If
  the memory does not hold it, say so plainly and ask the user to
  remind you. Never pretend to have read a conversation you have not
  read.

## Limits

- At most 5 new messages per run. The rest stay queued.
- At most 10 minutes per message step. Longer steps fail and the
  user is told.
- At most 2 revisions in a multi-model fix loop.
- Replies take about 10 to 30 seconds for simple messages once the
  hook wakes the worker, plus the time Muse needs to answer. A job
  with browser steps still takes as long as the models take to
  answer. The first reply is the fixed acknowledgement from the bot,
  sent at once. It is not a Muse reply.
- Plain language. No long dash characters anywhere: use commas,
  periods, colons, or short hyphens only.
- The relay runs only while the machine and the scheduler are
  running. If the machine is off, messages wait in the inbox until
  the next run.

## Live relay (hook fast path)

Since V2.4, a runtime hook wakes the relay the moment a new message
lands, instead of waiting for the next 1-minute run.

- Hook id `telegram-live-relay`, poll interval 10 seconds. Script:
  `~/hooks/scripts/telegram-inbox-watch.sh` (the script lives
  outside the repo, under the hooks dir, not in the harness).
- The script reads only `state/telegram-inbox.jsonl` with `jq`,
  looks for lines with status `new`, and wakes only when a
  `messageId` appears that it has not seen before. It keeps a
  watermark of seen message ids in the hook state dir, never in the
  harness state. A dry run never writes the watermark, so it never
  consumes a detection.
- The wake payload holds only the new message ids and their count,
  never message text, never a credential.
- If the inbox file does not exist, the script stays silent. If the
  relay lock file exists and is younger than 10 minutes, the script
  stays silent, because another run is already working; the new
  message stays unwatermarked, so the next poll after the lock
  clears wakes for it.
- The worker the hook wakes follows this contract exactly, the same
  as the cron worker. There is no second contract.
- The 5-minute cron stays as a safety net. It still picks up
  anything the hook misses, for example a message that arrived
  while a relay run was already working, or a line the worker
  failed to finish. The hook makes replies faster; it does not
  replace the cron.
- Honest limit: the hook only removes the wait for the next run.
  A Muse agent run still has to start and think, and a job with
  browser steps still takes as long as the models take to answer.
  This is near real-time, not instant, and it is not a webhook:
  the bot still uses long polling, and the machine must be running.

## What the relay never builds

The relay itself is a scheduled Muse job, not a CLI command. Do not
build a fake relay agent in the CLI. Do not add a command that
pretends to be the relay. The relay is this file, read by Muse on a
schedule.
