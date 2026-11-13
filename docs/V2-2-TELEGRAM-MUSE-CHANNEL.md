# V2.2: Telegram as a Muse Channel

Date: 2026-11-14. Status: V2.2 local only, multi-tenant, public repo. Version 2.2.0. No central service, no data leaves the machine, no deploy, no live paid API, no credential stored. A live Telegram bot is running on the owner's install, restarted on V2.1 code with the panel Start button, and the owner is allowlisted.

## What V2.2 adds

Telegram stops being only a remote control with commands and becomes a second chat window for Muse. Plain text that is not a command is a chat message. The bot queues it in the inbox, sends one fixed acknowledgement at once ("Got it. Muse will reply here."), and a scheduled relay job run by Muse answers it later. The relay writes its reply to the outbox, and the bot delivers it on its next poll cycle. Commands keep working exactly as in V2.0 and V2.1. A message that starts with "/" is a command. Anything else is chat. There is no guessing.

## How it works

1. The user sends a plain message to the bot in Telegram.
2. The bot checks the allowlist. A non-allowlisted user gets no reply at all, the same as for commands.
3. The bot appends one line to `state/telegram-inbox.jsonl` and sends the fixed acknowledgement at once. The acknowledgement is a fixed string, not a Muse reply. It exists so the user is not left wondering whether the message arrived.
4. A scheduled relay job runs every 5 minutes, and since V2.4 a live hook (`telegram-live-relay`, poll every 10 seconds) wakes the relay the moment a new message lands, so simple replies no longer wait for the next scheduled run. The 5-minute job stays as a safety net. The relay reads the inbox, takes up to 5 lines with status `new`, oldest first, and marks each one `processing` before it starts work on it.
5. The relay acts as Muse, with the same workspace, memory, skills, and harness CLI as the Muse app chat. It reads the thread file for that user, understands the message, does the work, and writes its reply.
6. The relay appends the reply to `state/telegram-outbox.jsonl` with status `pending`, appends its reply to the thread file, and marks the inbox line `done` only after the reply is written.
7. The bot, on its next poll cycle, reads the outbox, sends every `pending` line with `sendMessage`, and marks each one `sent` only after Telegram confirms the send.

Replies take about 10 to 30 seconds for simple messages once the hook wakes the worker, plus the time Muse needs to answer. A job with browser steps still takes as long as the models take to answer. A long job gets short progress messages while it works. See `V2-4-LIVE-RELAY.md` for the hook fast path.

## Queue file formats

Inbox, `state/telegram-inbox.jsonl`, one JSON object per line:

```json
{"messageId": 7, "telegramUserId": 111, "text": "Hello, open a gym food tab for me", "receivedAt": "2026-11-14T00:00:00.000Z", "status": "new", "attempts": 0}
```

Statuses: `new`, `processing`, `done`, `failed`. `messageId` is the Telegram update id.

Outbox, `state/telegram-outbox.jsonl`, one JSON object per line:

```json
{"replyId": "relay-2026-11-14T00-00-00-7", "inReplyTo": 7, "telegramUserId": 111, "text": "Your gym food tab is ready.", "createdAt": "2026-11-14T00:00:00.000Z", "status": "pending", "attempts": 0, "sentAt": null}
```

Statuses: `pending`, `sent`, `failed`. The bot sends a line only while its status is `pending`, and marks it `sent` right after the send returns, so it is never sent twice in normal running. A failed send leaves the line `pending` and stops that cycle, so order is kept and the next cycle retries. After three failed attempts the line is marked `failed` and never retried. A reply over 4000 characters is split into numbered parts, `[1/3]`, `[2/3]`, `[3/3]`, each under the limit.

Thread file, `state/telegram-threads/<telegramUserId>.json`:

```json
{"userId": 111, "label": "Owner", "createdAt": "2026-11-14T00:00:00.000Z", "updatedAt": "2026-11-14T00:00:00.000Z", "summary": "", "messages": [{"role": "user", "text": "Hello, open a gym food tab for me", "at": "2026-11-14T00:00:00.000Z"}]}
```

The last 20 messages are kept. When the list passes 20, the relay folds the oldest entries into the summary and drops them. The thread never holds a token, a password, or a credential: a token-shaped string in a chat message is still queued in the inbox, so the relay can warn the user to revoke it, but it is never written to the thread file.

Relay status, `state/telegram-relay-status.json`, written by the relay job after each run:

```json
{"lastRunAt": "2026-11-14T00:00:00.000Z", "processed": 2, "failed": 0, "inboxPending": 0, "outboxPending": 1, "lastError": null}
```

A missing file means the relay has never run, never an error.

## The relay runner contract

`scripts/telegram-relay.md` is the exact instruction text for the scheduled relay job: what it reads, how it replies, its safety rules, and its limits. The relay is a scheduled Muse job, not a CLI command. There is no relay command in the CLI, and no fake relay agent. The contract says, in short:

- At most 5 new messages per run, at most 10 minutes per message step, at most 2 revisions in a multi-model fix loop.
- A lock file, `state/telegram-relay.lock`, so two relay runs never overlap. A lock younger than 10 minutes makes the new run exit at once. A lock older than 10 minutes is treated as dead.
- The relay logs every action with an event name starting with `telegram_relay`, with the Telegram user id and the action, never the full message text and never a credential.
- The relay may build artifacts, run harness jobs, and read files and project state, with the same tools Muse uses in the app.
- The relay never deploys, pushes, merges, publishes, or sends anything. When it reaches one of those, it stops and tells the user in Telegram that the step needs approval in the Muse app, and it does not go on until the approval is recorded. Approval cards live in the Muse app, never in Telegram.
- The relay never logs in, never types a password, never enters a one-time code, and never solves a CAPTCHA. A challenge pauses the account and the relay tells the user.
- HOLD blocks writes from the relay exactly as it blocks writes from commands. Turning HOLD off still needs the YES confirmation.
- A food, health, or diet routine is a draft from a chat model, not medical fact, even when a second model agrees. The final reply says so in plain words.

## New CLI commands

- `telegram-relay-status`: inbox pending count, outbox pending count, and the last relay run time if the relay has run. Prints only counts and times, never any message text.
- `telegram-inbox [--show-text]`: pending inbox messages with id, user id, and received time. The full text is shown only with `--show-text`.
- `telegram-outbox [--show-text]`: pending outbox replies the same way.

## Rate limits

- Commands: 20 per minute per user, unchanged from V2.0.
- Chat: 10 messages per user per 10 minutes, separate from the command limit. The 11th gets one polite slow-down reply: "You are sending messages faster than I can answer them. I will catch up, please wait a little." Further messages in the window are dropped silently, with no reply and no audit event, until the window passes.
- The relay handles at most 5 new messages per run. The rest stay queued.

## Safety

- Only allowlisted numeric Telegram user ids can chat with Muse. The allowlist is the same file the command bot uses, `state/telegram.json`.
- Every chat message writes exactly one audit event per tenant, `telegram_chat_queued`, with the numeric Telegram user id only, never the message text.
- Chat messages do not count toward the command rate limit, and commands do not count toward the chat limit.
- The inbox, outbox, thread files, relay status file, and lock file are all gitignored. A corrupt queue line is skipped, never fatal: one bad line must not stop the bot from polling or delivering the rest.
- The relay job is created after this build. Until then, chat messages are queued and acknowledged, but no Muse reply arrives. Replies take about 10 to 30 seconds for simple messages once the relay runs (see `V2-4-LIVE-RELAY.md`).

## The two user examples

- "Open a new tab for my gym food, where I track everything I eat." The relay builds the tab as a space with the artifact tools, writes the link into the outbox, and the user taps the link in Telegram. The memory records that the user has a gym food tab.
- "For that gym food tab, get ChatGPT to make the best routine and verify it with Gemini, whether ChatGPT gave it right, and if everything is fine we will follow it." The relay gets the routine from ChatGPT through the driver when a ChatGPT browser account is connected, or as a packet when it is not. Gemini is packet-only, so the relay creates a Gemini packet with the routine inside it and sends it to the user in Telegram, and the job waits until the user pastes Gemini's answer back. If Gemini agrees, the relay saves the routine in the tab. If Gemini disagrees, the fix loop runs at most twice, then the relay stops and reports the disagreement. The final reply says the routine is a draft, checked by Gemini, and the user should check with a doctor or a qualified nutritionist before following a new diet.

## Tests

New tests in `tests/run-telegram-tests.mjs`, 15 groups, temp dirs only, mock Telegram API only, never api.telegram.org, no real token: chat text is queued with the right fields and the acknowledgement is sent, commands are not queued, non-allowlisted chat gets no reply and is not queued, chat rate limit triggers on the 11th message in 10 minutes and stays silent after the first slow-down reply, outbox lines are sent exactly once and marked sent, long outbox text is split into numbered parts, outbox delivery failure leaves the line pending and retries next cycle, thread file keeps the last 20 messages, thread file skips secret-like text but the message is still queued, relay-status counts are right and never print message text, inbox and outbox show the full text only with `--show-text`, queue files are gitignored, chat and command rate limits are separate, outbox lines are delivered oldest first. `npm test` now runs 167 groups.

## Still not done

- No relay cron job yet. The relay contract is written in `scripts/telegram-relay.md`, but the scheduled job that runs it every 1 minute is created by the parent after verification. Until then, chat messages queue and wait.
- No live chat reply yet. The bot acknowledges chat at once, but no Muse reply has been delivered through the outbox, because the relay has not run. Since V2.4 a live hook wakes the relay the moment a message lands; replies take about 10 to 30 seconds for simple messages once the hook wakes the worker, not 1 to 3 minutes.
- No panel change in this build. The panel does not show the inbox, the outbox, or the relay status yet.
- No webhook mode. Long polling only.
- No deploy from Telegram. The deploy gate decision (option A, B, or C, in writing) is still open.
