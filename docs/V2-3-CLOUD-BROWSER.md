# V2.3: Cloud Browser Mode

Date: 2026-11-14. Status: V2.3 local only, multi-tenant, public repo. Version 2.3.0. No central service, no data leaves the machine, no deploy, no live paid API, no credential stored.

## The bug this fixes

The user said it plainly: "If I have to copy and paste, what is the harness for?" He was right. The relay had asked him to run a ChatGPT packet by hand and paste the answer back, even though he had already connected ChatGPT in his browser. The harness had zero browser accounts, because its browser was never connected, and the logins he remembered live in a different browser than the one the harness drives.

There are two browsers, and two separate logins:

- The cloud browser is Muse's browser, default profile. That is where the user is already logged in to ChatGPT, Claude, and Gemini. Its login does not carry over to a harness profile.
- The harness profile is a Playwright Chromium profile on this machine, under `profiles/<tenantId>/<provider>-<id>`. That is what the harness driver opens. Its login does not carry over to the cloud browser.

V2.2 treated the second one as the only browser there is. When it was empty, the relay fell back to packet mode and asked the user to do the work himself. V2.3 records the first one as a real account, so the relay runs the job itself instead of asking.

## What V2.3 adds

An account record gains a source field: `profile` or `cloud`.

- A profile account is the existing kind. It uses a harness Playwright profile, it is verified by the driver opening that profile, and its jobs run with `run-browser` through the CLI. Only chatgpt and claude can be profile accounts, because the driver is wired only for those two.
- A cloud account is new. It is a model the user is already logged in to in the cloud browser. It has no local profile dir. It is verified by a browser task that checks the login in the cloud browser, never by the driver. Any subscription model can be a cloud account, including gemini, because the cloud browser can reach any chat app the user is logged in to.

The default for `account-add` stays `profile`, so nothing existing changes meaning. Old records without a source field are treated as profile accounts.

## How a cloud account is verified

A cloud account is connected only when the caller passes verification evidence:

```
node dist/index.js browser-connect --account gem --verified-via browser-task:abc123 --verified-note "gemini.google.com shows the prompt box and the business mail account"
```

- `--verified-via` is the browser task id that checked the login.
- `--verified-note` is the plain-words observation of what that task saw.

The CLI stores `verifiedAt`, `verifiedVia`, and `verifiedNote` on the account, and audit-logs the connect with those fields. Without both flags, `browser-connect` for a cloud account refuses and says the login must be verified by a browser task first. The evidence is an observation, never a login detail: no password, no token, no cookie, no session is ever stored. `browser-disconnect` works for cloud accounts exactly as for profile accounts.

## How a cloud job runs

A cloud browser job never runs from the CLI. `run-browser` on a cloud account refuses with a clear message: the job runs from Muse, through the cloud browser where the user is already logged in. The Telegram relay or the Muse app chat runs the job itself, reads the reply, and audit-logs it with:

```
node dist/index.js cloud-job-log --account gem --model gemini --task "Daily food plan draft" --result ok
```

The log command only records that the job ran, with the account, the model, a short task description, and the result. It refuses an unknown account, a profile account, a disconnected account, a provider mismatch, and a bad result value. It also refuses while HOLD is on. The account use count goes up by one, the same as a profile browser job.

The Telegram `/run` command refuses a cloud account with the same message, and the `/do` pipeline only ever picks profile accounts for its driver jobs. If the only connected account for a model is a cloud account, `/do` says so plainly in its packet fallback reply instead of silently skipping it.

## What the relay does now

The relay contract in `scripts/telegram-relay.md` has a new Cloud browser section. When a step needs a browser job, the relay checks the accounts first, in this order:

1. A connected cloud account for the model: the relay runs the job itself through the cloud browser, reads the reply, and audit-logs it with `cloud-job-log`. It never asks the user to copy and paste.
2. A connected profile account for the model: the relay runs it with `run-browser` through the CLI, as before.
3. No connected account anywhere for the model: packet mode, and only then. The relay tells the user what is missing.

Packet mode is now the last resort, not the default.

A waiting packet job switches to the cloud path as soon as a cloud account for that model becomes connected. The relay picks the job up, runs it through the cloud browser, and tells the user the paste is no longer needed.

The first example is the daily food plan job: a ChatGPT packet was already sent and is waiting for the user to paste the answer back. As soon as a ChatGPT cloud account is connected, the relay runs that plan through the cloud browser instead, then runs the Gemini check the same way when a Gemini cloud account is connected, and sets the final plan in the tracker.

## New CLI commands and flags

- `account-add --provider <model> --id <id> --label "<Label>" [--source cloud]`: source defaults to profile. A cloud account accepts any subscription model and has no local profile dir.
- `browser-connect --account <id> --verified-via <browser task id> --verified-note "<observation>"`: required for cloud accounts, refused for profile accounts.
- `cloud-job-log --account <id> --model <model> --task "<short task>" --result ok|failed [--type <type>] [--detail "..."]`: records one cloud browser job in the audit log.
- `account-list`, `session-status`, `browser-status`, and `status` all show the source and, for a cloud account, the verification note. `status` also shows the cloud and profile counts separately.

## Safety

- A cloud connect is refused while HOLD is on, the same as a profile connect.
- The driver never opens a cloud account. `connectBrowser` refuses it before the driver is even created.
- `run-browser` never silently falls back to packet mode for a cloud account, and never pretends the CLI ran it. It refuses, and no packet is created.
- The relay never logs in, never types a password, never enters a one-time code, and never solves a CAPTCHA. A challenge pauses the account and the relay tells the user.
- The budget cap is 0. No paid API call is ever made.
- Deploy, GitHub push, merge, and anything destructive still need approval in the Muse app. The deploy gate decision (option A, B, or C, in writing) is still open.

## Tests

New tests in `tests/run-connection-tests.mjs`, 15 groups, temp dirs only, mock driver only, no live network, no real token: old records without a source field are backfilled to profile with empty verification fields, a cloud account uses any subscription model and has no local profile dir, a cloud account refuses an unknown provider and a profile account refuses gemini, source defaults to profile when absent and an unknown source is refused, a cloud connect refuses without verification evidence, a cloud connect with flags stores verifiedAt, verifiedVia, and verifiedNote and marks connected, a cloud connect refuses with HOLD on and refuses for a profile account, the driver connect refuses a cloud account and leaves it disconnected, disconnect works for cloud accounts and keeps the verification fields recorded, the status line shows the source and the verification note, the cloud refusal names the relay and says no packet was created, a disconnected cloud account gets the verify-first message, recording a cloud job refuses bad input and never logs, recording a cloud job appends the audit event and records one use, the secret-field guard rejects every forbidden key in a record. `npm test` now runs 182 groups.

## Still not done

- No cloud accounts recorded yet on the real install. The parent records them after the browser verification tasks, with the exact commands in the V2.3 report.
- No live browser job through the cloud path yet. The first one runs when the relay picks up a job for a connected cloud account.
- The daily food plan job still waits for the cloud path: the ChatGPT packet is out, and the relay switches it to the cloud browser as soon as a ChatGPT cloud account is connected.
- No panel change in this build. The panel does not show cloud accounts or their verification notes yet.
- No webhook mode. Long polling only.
- No deploy from Telegram. The deploy gate decision (option A, B, or C, in writing) is still open.
