# TrustyMUSE Harness FAQ

Version 2.0.0. Short answers, drawn only from what the harness does and
what has been verified. If an answer says something is not verified, that
is the answer. Do not assume otherwise.

## 1. What is the TrustyMUSE Harness?

A small local program that helps you send work to chat AI apps like
ChatGPT, Claude, Gemini, Grok, DeepSeek, Perplexity, Meta AI, Copilot,
and Mistral. TrustyMUSE is the controller. The chat AI apps are the
workers. It writes prompt packets you run by hand in your own chat app,
or it drives your own logged in ChatGPT or Claude account in a browser.
It never publishes, sends, merges, or deploys anything on its own. See
`GETTING-STARTED.md`.

## 2. Do I need an API key?

No. Packet mode and browser mode both use your normal chat accounts, the
ones you already open in a browser. No API key is needed, and no API key
is stored anywhere. API mode exists in the code as stubs, it is off by
default, and the budget cap of 0 blocks every paid API call. A key, when
a live API phase exists, comes from the environment only, never from a
file.

## 3. Why did the private repo give a 404? Is it public now?

A private GitHub repo returns 404 to anyone who is not signed in as the
owner or a collaborator, and `git clone` then asks for a username. That
is how GitHub hides private repos. The spelling was correct. The repo is
now public, at `https://github.com/SadatRiyad/trustymuse-harness`, so
anyone can clone it with no login:

```bash
git clone https://github.com/SadatRiyad/trustymuse-harness.git
```

The repo carries the MIT License, so anyone may use, change, and share
the code while keeping the copyright notice.

## 4. What tenant id and name should I use in setup?

The id and name are yours to choose. The id is a lowercase slug, 3 to 40
characters, single hyphens only, for example `jane-doe`. The name is a
display name, so it can have spaces and capitals, for example `Jane
Doe`. One tenant is one Muse account, so use the id and name of the
person whose Muse account will use that copy of the harness. Reserved
ids are rejected: `default`, `system`, `admin`, `root`, `all`, `shared`.

```bash
node dist/index.js setup --id jane-doe --name "Jane Doe"
```

## 5. Can one Muse account control another Muse account with this harness?

No. There is no public Muse account API and no central server. Each Muse
account runs its own copy of the harness in its own workspace, with its
own tenant, state, budget, accounts, projects, and audit log. One tenant
cannot see another tenant's data, even on the same install. There is no
hosted team server, no shared dashboard, and no cross-account job
routing. See `V1-4-MULTI-TENANT.md` and `ARCHITECTURE.md`.

## 6. Can I use the harness from another phone?

Yes, in two ways. If the other phone uses the same Muse account, sign in
with that same account and you get the same workspace and the same
harness. If the other phone uses a different Muse account, that account
needs its own copy: clone the public repo, run `npm install` and `npm
test`, then run `setup` with its own id and name. That copy has its own
tenant and its own state. It cannot see or control your copy.

## 7. Why does my cloud browser login not carry over to the harness profile?

Because they are two different browser profiles. A login in the cloud
browser belongs to that browser's profile. The harness opens its own
local profile folders under `profiles/<tenantId>/`. A login in one
profile never carries over to another profile. Each harness profile
needs its own one-time manual login, in your own browser, by hand. The
harness never asks for your password and never sees it.

## 8. Why does browser-connect say pending?

The TrustyHarness panel cannot run the Playwright driver itself, so
panel Connect records the account as pending verification, never as
connected, and shows the CLI command to run. Only a CLI `browser-connect`
can flip the account to connected, after the driver opens the profile
and verifies the login. A pending account is treated exactly like a
disconnected one: `run-browser` refuses it. Run this in the terminal:

```bash
node dist/index.js browser-connect --account main
```

## 9. What does disconnect do, and what does it not do?

`browser-disconnect` stops the harness from using one browser session.
It flips the connected flag to false, records a reason, and pauses the
account, so the queue refuses later jobs for it. It does NOT delete the
browser profile, and it does NOT log you out of the site. The login
stays in the profile, so a later `browser-connect` can verify it and
reconnect without another manual login. Disconnect is always allowed,
even with HOLD on, because stopping use must never be blocked.

## 10. Why are paid API calls blocked at cap 0?

The monthly budget cap defaults to 0 USD, per tenant. With 0, every paid
API call is blocked by design. The harness warns at 80 percent of the
cap and stops hard at the cap. You can raise the cap later in
`config.yaml` or with `tenant-add --cap <amount>`, but setting a cap
alone does not make a live call in V1.6, because the API adapters are
stubs. A live API phase would replace the stubs and keep the budget
guard in front of every call. A browser job does not spend API budget,
and a packet costs nothing, because you run it in your own chat app
under your own subscription.

## 11. Why is CAPTCHA never auto solved?

Because auto solving a CAPTCHA breaks the chat sites' rules and risks
the account being flagged, challenged, or suspended. The harness never
auto solves a CAPTCHA or a challenge. If one appears, the account is
paused at once, `browser-connect` fails closed, and you check it by hand
and solve it yourself, or you leave the account paused. Packet mode
stays available as the fallback while the account is paused.

## 12. What do I do when the Chromium install fails on a small /tmp?

The Playwright download is about 198 MB, and it uses the system temp
folder while it downloads. On a machine where `/tmp` is small, for
example a 512 MB tmpfs, the download fills it and dies near 90 percent.
Point the temp folder at your home folder first, then install:

```bash
TMPDIR=~/tmp npx playwright install chromium
```

Make sure `~/tmp` exists first with `mkdir -p ~/tmp`.

## 13. Is my password stored anywhere?

No. There is no password field and no token field anywhere in the code,
in config, in packets, in state, or in logs. You log in once, by hand, in
your own browser, in the account's own profile folder. The harness opens
that already logged in profile later. It never types your password and
never sees it. The `profiles/` folder is gitignored and must never be
shared, copied to a public place, or committed. The same rule holds for
API keys: they come from the environment only, never from a file.

## 14. What is HOLD, and when should I turn it on?

HOLD is the kill switch, `policy.hold` in `config.yaml`. When HOLD is
on, the harness fails closed and stops. It blocks setup, tenant writes,
tenant migration, model connects and disconnects, project writes,
project-scoped jobs, browser connects, and browser jobs. Turn it on when
you want everything to stop, for example while you check a problem. Two
things are never blocked by HOLD: `browser-disconnect`, because stopping
use must never be blocked, and read-only commands such as `status`,
`audit`, `model-list`, `project-list`, and `browser-status`.

## 15. What does the harness refuse to do on its own?

Publish, send, merge, and deploy are never automatic. A draft still
needs per-item user approval before any of those happen, outside the
harness. The policy tiers are: Tier 0 read only, Tier 1 draft only,
Tier 2 needs explicit approval for that exact item, Tier 3 blocked. The
harness also never auto solves a CAPTCHA, never stores a credential, and
never makes a paid API call while the cap is 0.

## 16. Which models work in browser mode, and which are packet-only?

Browser mode is wired only for ChatGPT and Claude. The driver has
selectors verified live for those two. Gemini, Grok, DeepSeek,
Perplexity, Meta AI, Copilot, and Mistral are packet-only. `run-browser`
refuses them with a clear message telling you to use packet mode. Do not
claim a live browser connection for a packet-only model. Wiring a new
driver needs the same path as V1.2: live login check, live selector
verification, and one small first live test. See `V1-5-MODELS.md`.

## 17. Has a live prompt been sent through the driver yet?

No. No live prompt has been sent through the Playwright driver yet, for
any model. `browser-connect` only verifies the login. It sends nothing.
The first live job is still untested, so keep it small, keep it to one
account, and keep packet mode ready as the fallback. The Send button
after typing, the model picker menu contents, the response stop control
label, and assistant message extraction are also not verified live. The
driver falls back to Enter and to waiting for a stable assistant message,
and it logs which path was used.

## 18. What happens when a project is paused?

A paused project cannot run jobs until it is active again. Any packet or
browser job scoped to it is refused with a clear message and a blocked
audit event. There is no resume command in V1.6. To use a paused project
again, remove it with `project-remove` and re-add it with the same
values. The project folder itself is never touched by remove.

## 19. What happens when the tests fail?

Stop and read the failure before you change anything. `npm test` must
pass before you use the harness. A failing suite means the code on your
machine is not the code that was verified. See `TROUBLESHOOTING.md` for
the common causes: a missing build, a wrong Node version, or a dirty
working folder. Never run a live browser job while the tests fail.

## 20. How do I update to a new version?

Pull the latest code from the public repo, run `npm install`, then run
`npm test`. All 137 test groups must pass before you use the new version.
Your state lives under `state/tenants/<your-id>/` and `profiles/`, and
those folders are gitignored, so a pull does not touch them. Check the
new version number in `package.json` and read the new `V1-*.md` notes
under `docs/` for what changed.

## 21. Why did ChatGPT show connected before I connected it?

Before V1.7, a fresh tenant was seeded with ChatGPT and Claude
connected on first read, so `status` and `model-list` showed them as
connected even though nobody had connected them. That was a bug: the
display looked like a live connection, but it was only a local record.

Since V1.7, a fresh tenant starts with zero connected models. A model
becomes connected only when you run `model-connect --model <id>` for
it. Tenants that already had models connected keep exactly what they
had; nothing was disconnected by the fix.

Connected still means only one thing: the model is enabled for packet
mode for your tenant. It is not a live login, not a stored token, and
not a live call. For ChatGPT and Claude, run `browser-status` to check
the live browser verification. See `V1-7-CONNECTED-MEANS.md`.

## 22. What does analytics-preview send?

Nothing. `analytics-preview` builds the exact JSON payload that would
be sent and prints it, so you can read it before anything is ever
enabled. It sends nothing, because Phase 1 has no sending code and
the central service does not exist yet. The payload holds counts only:
tenant count, connected model ids, job counts by type and model,
packet and browser job counts, jobs ok and failed, results validated,
error categories, budget bands, browser account counts, active project
count, last active day, platform family, and Node major version. It
never holds prompt text, result text, file contents, project names or
paths, account labels, tenant names, emails, or credentials. The
collector never reads an audit event's detail field. `analytics-enable`
is refused until Phase 2 builds the central service, and
`analytics-disable` is a no-op that confirms nothing is being sent.
See `V1-8-ANALYTICS-PHASE-1.md`.

## 23. How do I control the harness from Telegram?

Create a bot with @BotFather in Telegram, copy the token it gives you,
and set it in the environment only, never in a file:

```bash
export TELEGRAM_BOT_TOKEN=<token from @BotFather>
node dist/index.js telegram-start
```

Send `/start` to the bot, read your numeric Telegram user id from the
terminal where the bot runs, and allowlist yourself:

```bash
node dist/index.js telegram-allow --user-id <id> --label "Your Name"
```

Send `/start` again and the bot replies. From Telegram you can check
`/status`, `/models`, `/projects`, `/browser_status`,
`/analytics_status`, `/analytics_preview`, and `/audit`, create tasks
and packets with `/task` and `/packet`, add, remove, and pause projects,
connect and disconnect models, turn HOLD on and off, run one browser job
at a time on a connected account with `/run`, and give plain-language
instructions with `/do`. Only allowlisted user ids get any reply. The
bot never deploys, publishes, merges, or sends anything. HOLD blocks
every Telegram write. Stop the bot any time with Ctrl+C. No live bot run
has happened yet, because no real token exists; the bot has only been
run against a mock Telegram API in tests. See
`V2-0-TELEGRAM-FULL-CONTROL.md`.

## 24. What does /do do, and does it deploy?

`/do` turns plain words into harness work, with no LLM call. It
handles three patterns: `plan with chatgpt then audit with claude:
<task>` runs a plan step and then an audit step, on the browser driver
when both models have connected browser accounts, or as two packets
when they do not; `project <id>: <task>` creates a project-scoped
packet; `<task> with <model>` picks the model. It never deploys. When
the instruction mentions deploy, live, or publish, it reports the
audit verdict from a text-marker check and says the deploy itself
needs your approval in the Muse app. A passing marker check is not
proof the work is good. See `V2-0-TELEGRAM-FULL-CONTROL.md`.

## 25. Can I paste the bot token into the dashboard box?

Not yet. V2.0 builds the file-token fallback the box needs: the bot
reads the token from `TELEGRAM_BOT_TOKEN` first, then from the file
token in `state/telegram.json`. The TrustyHarness panel box that writes
that file token is a separate panel change that comes after this CLI
work. Until then, set the token in the environment. Check it any time
with `telegram-token-status`, which prints only set or not set, never
the value. See `V2-0-TELEGRAM-FULL-CONTROL.md`.
