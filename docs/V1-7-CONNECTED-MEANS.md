# V1.7: What "Connected" Means

Version 1.7.0. Local only. This note explains the bug V1.7 fixes, what
the fix changes, and what connected, browser connected, and live mean
now.

## The bug

Before V1.7, a fresh tenant was seeded with ChatGPT and Claude
connected on first read. `loadConnectedIds` in `src/models/connect.ts`
wrote `["chatgpt", "claude"]` into a brand new tenant's `models.json`
before the user had connected anything. So `status` and `model-list`
showed ChatGPT and Claude as connected on a fresh install, and a packet
for either model worked at once.

That display looked like a live connection. It was not. Connecting has
always been a local record only: it never logs in, never stores a
password or a token, and never places a call. A fresh install reporting
2 connected models overstated what the harness had actually done, and a
new user could reasonably read it as "ChatGPT and Claude are live and
responding". They were not.

## The fix

V1.7 removes the auto-seed. `loadConnectedIds` now writes an empty list
for a missing file, so a fresh tenant starts with zero connected
models. A model becomes connected only through an explicit
`model-connect` command by the user, which is audit logged as before:

```bash
node dist/index.js model-connect --model chatgpt
node dist/index.js model-connect --model claude
node dist/index.js model-list
```

`status` and `model-list` now print a one-line legend after the
connected list, so the meaning is visible every time the state is
shown:

```text
Connected means enabled for packet mode only. It is not a live login, not a stored token, and not a live call. For chatgpt and claude, run browser-status to check the live browser verification.
```

## What existing tenants keep

Only the first-read seeding for brand-new tenants changed. A tenant
whose `models.json` already exists keeps exactly what it has. Nothing
is disconnected on load, and no file is rewritten except when the user
runs `model-connect` or `model-disconnect`.

The original tenant `sadat-riyad` keeps all 9 subscription models
connected, because each one was connected by explicit user activation.
A fresh tenant on the same install starts with zero. The two tenants do
not affect each other.

## What the three states mean now

Connected (subscription model): the model is enabled for packet mode
for one tenant. The harness may write a packet for it. The user runs
the packet by hand in their own chat app and pastes the result back.
Connected says nothing about a login, a token, or a live call.

Browser connected (browser account): the harness verified the login
through the Playwright driver with `browser-connect`, and the account
is allowed to run browser jobs. `browser-status` shows it. Only
chatgpt and claude have a wired driver. Disconnect stops use at any
time, even with HOLD on, and never deletes the profile or logs the user
out of the site. See `docs/V1-6-BROWSER-CONNECT.md`.

Live: a prompt was sent and an answer came back. Packet mode is live
only when the user runs the packet in their own app. Browser mode is
live only when a browser job runs against a verified login. No live
prompt has been sent through the Playwright driver yet, and no paid API
call has ever been made. Budget cap is 0 per tenant, and API mode is
off.

## Tests

New tests in `tests/run-model-connect-tests.mjs`, 9 groups, temp dirs
only: fresh tenant has 0 connected models; model-connect adds exactly
one; model-disconnect removes it; a pre-existing 9-model file still
loads as 9; a pre-existing pair file is preserved exactly; connecting
twice does not duplicate; unknown and API connects are refused; status
and model-list print the legend line in the real CLI. The older model
tests in `tests/run-model-tests.mjs` were updated for the same change:
the fresh tenant test now expects zero, and the disconnect test
connects chatgpt first. `npm test` now runs 91 groups: V1 7, browser
10, live driver 9, projects 12, tenants 14, models 15, connection 15,
model-connect 9.

## Honest limits, unchanged

- Browser mode is still off by default.
- No live driver job yet, for any model.
- No paid API call. Budget cap is still 0 per tenant, API adapters are
  still stubs.
- There is no public Muse account API and no central server. Each Muse
  account runs its own copy of the harness.
