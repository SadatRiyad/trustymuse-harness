# V1.6 Browser Connect and Disconnect

Version 1.6.0. Local only. One install, many tenants, same safety rules as V1.

## What Connect means

`browser-connect` verifies the login for one browser account, and only
then marks it connected. It opens the account's browser profile with the
driver and checks the login the same way `openProfile` does: the provider
page must load, the prompt box must be there, and the logged in profile
marker must be present. If the driver reports not logged in, a login page,
or a challenge, the account stays disconnected and the exact reason is
recorded. Connected is a verified fact, never a claim.

Connect never types a password, never stores a login detail, and never
auto solves a challenge. If a challenge is on the page, connect fails
and the user checks it by hand, exactly as in V1.1 and V1.2.

## What Disconnect does, and does not do

`browser-disconnect` stops the harness from using the session. It flips
the connected flag to false, records a reason, and pauses the account,
so the queue refuses later jobs for it. It does NOT delete the browser
profile, and it does NOT log the user out of the site. The login stays
in the profile, so a later `browser-connect` can verify it and reconnect
without another manual login.

Disconnect is always allowed, even with HOLD on, because stopping use
must never be blocked. Connect is refused while HOLD is on.

## Commands

```bash
cd ~/workspace/trustymuse-harness
npm run build

# See every account and its connection state.
node dist/index.js browser-status

# Connect one account. Verifies the login first.
node dist/index.js browser-connect --account main

# Run a job. Refuses a disconnected account and names browser-connect.
node dist/index.js run-browser --model chatgpt --account main --type seo --title "Task" --task "Write a draft."

# Disconnect one account, any time, for any reason.
node dist/index.js browser-disconnect --account main --reason "Taking a break."

# Check again. session-status shows the same connection line per account.
node dist/index.js session-status
```

All three commands accept `--tenant <id>`. Connection state is per
tenant: connecting an account in one tenant never changes another
tenant's accounts. Unknown accounts fail closed.

## The manual login step, once per profile

Connect verifies a login; it does not create one. The order is:

1. `account-add --provider chatgpt --id main --label "Main ChatGPT"`.
   The profile folder is `profiles/<tenantId>/chatgpt-main`.
2. Open your own browser with that profile folder, go to the provider
   site, and log in by hand with your own account. Close the browser.
3. `browser-connect --account main`. The driver opens the profile and
   checks the login. If it is there, the account is connected.
4. `run-browser` works from now on, until you disconnect or the
   account is paused after a challenge or driver errors. A paused
   account is marked disconnected again, and needs a fresh
   `browser-connect` after you check it by hand.

## Why the cloud browser login is not the same login

The live checks in V1.2 ran in a cloud browser, and the logins there
belong to that browser's profile. The harness opens its own local
profile folders under `profiles/<tenantId>/`. A login in the cloud
browser does not carry over to a harness profile, and a login in a
harness profile does not carry over to the cloud browser. Each profile
needs its own one-time manual login. This is the same rule as V1.1:
one profile per account, never shared.

## Limits

- The browser driver is wired only for chatgpt and claude. Every other
  subscription model is packet-only, and `run-browser` refuses it.
  `browser-connect` refuses a packet-only model the same way.
- No live prompt has been sent through the driver yet. Connect only
  verifies the login; it sends nothing.
- No live paid API call. Budget cap is 0 per tenant, API adapters are
  still stubs.
- The panel Connect and Disconnect buttons come later. V1.6 is the CLI
  only: the commands above, and the same state the panel will read.
- A connect does not prove the send button or the response extraction
  works. Those were not verified live, and the driver still falls back
  to Enter when no Send message button is visible.
