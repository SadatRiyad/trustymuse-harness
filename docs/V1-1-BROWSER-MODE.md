# TrustyMUSE Harness V1.1 Browser Session Mode

Date: 2026-11-10. Status: opt in local layer only. Browser mode is off by default. Live login and logged in selectors are now verified, see docs/V1-2-LIVE-DRIVER.md. The real driver is wired in V1.2. Packet mode stays as the safe fallback.

## Why this mode exists

In V1, ChatGPT and Claude worked only by packet. The harness wrote a prompt file, the user copied it into their own app, ran it, and pasted the result back. That is safe, but it is not automation. If every result needs manual copy and paste, the harness adds little value. V1.1 adds a browser session mode so a logged in normal account can work through the harness without manual copy and paste, as the primary flow, while packet mode stays as the fallback.

## How it works, in plain words

1. You create an account in the harness with `account-add`. You give an id, a provider (chatgpt or claude), and a label. You never give a password. There is no password field anywhere in V1.1.
2. You log in once, by hand, in your own browser, in that account's own profile folder under `profiles/`. The harness opens that already logged in profile later. It does not type your password and it never sees your password.
3. You run a job with `run-browser`. The harness opens the profile, sends the prompt, waits for the response, saves the result to `browser-results/`, and logs every step to `state/audit.jsonl`.
4. If the account is challenged, rate limited, or fails twice, the harness pauses that account and stops. You check it by hand before you use it again.
5. If browser mode is ever unsafe or paused, packet mode still works. That is the fallback.

## Honest risk disclosure, read this before you turn it on

- ChatGPT and Claude web use is governed by their terms. Automated use of a chat account can trigger a rate limit, a challenge, or a suspension. This risk is real, and it applies to any tool that drives the chat website, including this one. V1.1 does not remove that risk. It only reduces it with pacing, daily limits, one job at a time, and an immediate pause on challenge.
- This mode uses your own browser profile and your own manual login. Muse never sees your password, and no credential is uploaded anywhere. Sessions stay local in `profiles/` on this machine. That folder is gitignored and must never be shared, copied to a public place, or committed.
- Login is done by the user once per profile, in the user's own browser. The harness never asks for your password, never stores a session token in code or in a file it writes, and never auto solves a CAPTCHA. If a CAPTCHA appears, the account is paused and you solve it by hand, or you leave the account paused.
- The live selectors for the ChatGPT and Claude web UI are verified in V1.2, from live checks on 2026-11-10, see docs/V1-2-LIVE-DRIVER.md and LIVE_SELECTORS in src/session/browser.ts. Both sites change their UI often, so a selector that works today can break tomorrow. Send button after typing and model picker menu contents are still unverified, and the driver handles them with an honest fallback. A first live job still needs your explicit go ahead, in your own browser, and it should be one small job first.
- Do not run browser mode and packet mode for the same account at the same time. Do not run two accounts in parallel on the same provider. Use one job at a time, with the pacing delay between jobs.

## Multi account rules

- One separate browser profile per account. Never share a profile between accounts. The profile folder name is `profiles/<provider>-<id>`, for example `profiles/chatgpt-main` and `profiles/claude-main`.
- Never run two accounts in parallel on the same provider. The queue enforces one job at a time per account, and you must rotate only after the pacing delay.
- At most 3 accounts in V1.1, set by `browser.max_accounts`. The default daily limit is 20 jobs per account, set by `browser.daily_limit_per_account`. Lower the limit if an account is new or has been challenged before.
- A paused or challenged account is never retried automatically. Check it by hand, solve any challenge by hand, then set it back to active only if it looks normal again.

## How to enable it

1. Copy `config.example.yaml` to `config.yaml` if you have not done so already.
2. Read this file once, in full.
3. Set `browser.enabled` to `true` in `config.yaml`. Browser mode stays off until you do this. Nothing else turns it on.
4. Run `node dist/index.js session-status` to confirm browser mode, pacing, daily limit, and accounts.
5. Add an account: `node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT"`.
6. Log in once, by hand, in that profile. See the login steps in README.md.
7. Run the first test with the mock driver first, then ask for a live test only when you are ready.

## What is still not live tested

- No live prompt has been sent through the harness driver, and no live response has been collected through it. That is the first live job, not yet run.
- Send button after typing and model picker menu contents are still unverified on both sites.
- Response stop control label and assistant message extraction are best effort, not verified live.
- Live login is verified: ChatGPT logged in with Google, profile business mail, plan Free. Claude logged in with Google after the user solved the hCaptcha by hand, at claude.ai/new, BB Free, Free plan. Logged in prompt boxes, model picker label for Claude, and new chat controls are verified, see docs/V1-2-LIVE-DRIVER.md.
- The mock driver in tests proves the queue, pacing, daily limit, challenge pause, and retry logic. It does not prove the live websites will accept the driver. Only a first live job proves that.

## If an account is paused

1. Run `node dist/index.js session-status` and `node dist/index.js audit` to see what happened.
2. Open the provider site in your own browser, in that profile, and check the account by hand.
3. If a challenge is showing, solve it by hand or leave the account paused.
4. Use packet mode for that task while the account is paused.
5. Only set the account back to active when the account looks normal again.
