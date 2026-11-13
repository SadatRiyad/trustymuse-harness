# TrustyMUSE Harness

Version 2.0.0. A local harness that lets TrustyMUSE route work to chat AI
apps like ChatGPT, Claude, Gemini, Grok, DeepSeek, Perplexity, Meta AI,
Copilot, and Mistral. TrustyMUSE is the controller. The chat AI apps are
the workers.

It is free and open source under the MIT License. Clone it, run it on
your own computer, and use it with your own chat accounts. No API key is
needed. No payment is needed to start.

```bash
git clone https://github.com/SadatRiyad/trustymuse-harness.git
cd trustymuse-harness
npm install
npm test
node dist/index.js setup --id jane-doe --name "Jane Doe"
node dist/index.js model-connect --model chatgpt
node dist/index.js packet --model chatgpt --type seo --title "First task" --task "Write a draft."
```

## What it does

- **Packet mode.** The harness writes a text packet with your task,
  context, and rules. You copy it into your own chat app, run it there,
  and paste the result back. Packet mode works for all 9 connected
  subscription models at once: chatgpt, claude, gemini, grok, deepseek,
  perplexity, meta-ai, copilot, mistral.
- **Browser mode.** The harness opens your own logged in ChatGPT or
  Claude account in a browser and sends the prompt for you. Browser mode
  is wired only for ChatGPT and Claude, and it is off by default. You log
  in once, by hand, in your own browser. The harness never asks for your
  password.
- **Browser Connect and Disconnect.** `browser-connect` verifies the
  login through the driver before it marks an account connected.
  `browser-disconnect` stops use any time, even with HOLD on, and never
  deletes the profile or logs you out. `run-browser` refuses a
  disconnected account.
- **Connected means packet mode only.** A fresh tenant starts with zero
  connected models. A model connects only when you run `model-connect`
  for it. Connected is not a live login, not a stored token, and not a
  live call. See `docs/V1-7-CONNECTED-MEANS.md`.
- **Projects.** Any folder inside `~/workspace` can connect as a project.
  Jobs scoped to a project carry that project's context and boundaries,
  and stay draft only.
- **Multi-tenant.** One install serves many Muse accounts. One tenant is
  one Muse account, with its own state, budget, accounts, projects,
  browser profiles, and audit log. No tenant can see another tenant's
  data.
- **Budget guard.** The monthly budget cap starts at 0, so no paid API
  call can happen. The harness warns at 80 percent and stops hard at the
  cap.
- **Policy and HOLD.** Publish, send, merge, and deploy are never
  automatic. HOLD is a kill switch that fails closed and stops all
  writes.
- **Audit log.** Every packet, check, block, and result is written to an
  append only audit log, per tenant.
- **Telegram full control.** A Telegram Bot runs everything the harness can do from your phone: projects, models, tasks, HOLD, one browser job at a time on a connected account with `/run`, and plain-language `/do` instructions into packets or a plan-then-audit pipeline. Only allowlisted Telegram user ids get a reply. The token comes from `TELEGRAM_BOT_TOKEN` first, then from the file token in `state/telegram.json`. V2.1 starts the bot from the dashboard, not the terminal: `telegram-start` is supervisor-managed, the bot writes a heartbeat on every poll, and the poll loop never overlaps `getUpdates`. V2.2 makes Telegram a Muse channel: plain text that is not a command is queued for a scheduled relay job run by Muse, which answers it within a few minutes. Nothing here ever deploys. See `docs/V2-2-TELEGRAM-MUSE-CHANNEL.md`.

## Safety rules

- No credential in code, config, packets, or logs. Keys come from
  environment variables only.
- No auto publish, send, merge, or deploy.
- If HOLD is on, or policy cannot be read, the harness fails closed and
  stops.
- CAPTCHA is never auto solved. A challenge pauses the account at once.
- Browser mode is off by default. Read `docs/V1-1-BROWSER-MODE.md`
  before you turn it on. Automated use of a chat account can trigger a
  rate limit, a challenge, or a suspension.
- If you are unsure, keep the action as a draft and ask the user.

## Honest limits

- No live prompt has been sent through the Playwright driver yet. The
  first live job is still untested.
- The browser driver is wired only for ChatGPT and Claude. The other
  seven models are packet-only.
- No live paid API call has ever been made. The API adapters are stubs,
  and the budget cap is 0 by default.
- A live Telegram bot is running on the owner's install, restarted on V2.1 code with the panel Start button, and the owner is allowlisted. The bot cannot run a browser job from an unconnected account, and it cannot send, publish, merge, or deploy anything. Chat mode is built but the relay cron job is not created yet, so chat messages queue and wait for a Muse reply.
- There is no public Muse account API and no central server. Each Muse
  account runs its own copy of the harness. One account cannot see or
  control another Muse account.

## Documentation

Start with [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) for a
complete beginner walkthrough. Then read
[`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) for every command,
[`docs/FAQ.md`](docs/FAQ.md) for common questions, and
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) when something
fails. Developers start with
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Contributors read
[`CONTRIBUTING.md`](CONTRIBUTING.md). The full index is in
[`docs/README.md`](docs/README.md).

- [`INSTALL.md`](INSTALL.md): install, setup, tenants, migration.
- [`docs/V1-NOTES.md`](docs/V1-NOTES.md): what V1 through V2.2 do, and
  what they do not do.
- [`docs/V1-1-BROWSER-MODE.md`](docs/V1-1-BROWSER-MODE.md): browser
  session mode and the risk disclosure.
- [`docs/V1-2-LIVE-DRIVER.md`](docs/V1-2-LIVE-DRIVER.md): the Playwright
  driver and the verified selectors.
- [`docs/V1-3-PROJECTS.md`](docs/V1-3-PROJECTS.md): project connectors.
- [`docs/V1-4-MULTI-TENANT.md`](docs/V1-4-MULTI-TENANT.md): the tenant
  model and isolation guarantees.
- [`docs/V1-5-MODELS.md`](docs/V1-5-MODELS.md): the 9 subscription
  models and the browser split.
- [`docs/V1-6-BROWSER-CONNECT.md`](docs/V1-6-BROWSER-CONNECT.md):
  browser Connect and Disconnect.
- [`docs/V1-7-CONNECTED-MEANS.md`](docs/V1-7-CONNECTED-MEANS.md):
  what connected means, and the removed auto-seed.
- [`docs/V1-8-ANALYTICS-PHASE-1.md`](docs/V1-8-ANALYTICS-PHASE-1.md):
  Analytics Phase 1, local collector with a dry-run preview only.
- [`docs/V1-9-TELEGRAM-BOT.md`](docs/V1-9-TELEGRAM-BOT.md):
  Telegram Bot control, allowlist, commands, and safety rules.
- [`docs/V2-0-TELEGRAM-FULL-CONTROL.md`](docs/V2-0-TELEGRAM-FULL-CONTROL.md):
  Telegram full control, `/run`, `/do`, the deploy gate, and the token
  fallback.
- [`docs/V2-1-BOT-START-FROM-PANEL.md`](docs/V2-1-BOT-START-FROM-PANEL.md):
  the bot starts from the dashboard, the supervisor contract, the
  heartbeat, and the poll loop fix for HTTP 409.
- [`docs/V2-2-TELEGRAM-MUSE-CHANNEL.md`](docs/V2-2-TELEGRAM-MUSE-CHANNEL.md):
  Telegram as a Muse channel, chat mode, the inbox and outbox queues,
  the relay contract, and the thread file.

## Quick start

```bash
cd trustymuse-harness
npm install
npm test
node dist/index.js setup --id jane-doe --name "Jane Doe"
node dist/index.js status
```

`npm test` runs 167 test groups: V1 7, browser 10, live driver 9,
projects 12, tenants 14, models 15, connection 15, model-connect 9, analytics 11, telegram 65. Do not use the
harness until the tests pass.

First packet job. Connect ChatGPT first, because a fresh tenant starts
with zero connected models:

```bash
node dist/index.js model-connect --model chatgpt
node dist/index.js packet --model chatgpt --type seo --title "First task" --task "Write a draft about finding clients without a website."
```

Open the packet file under `packets/<your-tenant-id>/`, copy it into
your own ChatGPT app, run it, and paste the result back.

First browser job, ChatGPT only, after you read
`docs/V1-1-BROWSER-MODE.md` and log in by hand in the profile:

```bash
node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT"
node dist/index.js browser-connect --account main
node dist/index.js run-browser --model chatgpt --account main --type seo --title "First live test" --task "Write one short paragraph about finding clients without a website."
node dist/index.js browser-disconnect --account main --reason "Taking a break."
```

## Version history

- V1: subscription packet mode, budget guard, policy gate, audit log.
- V1.1: browser session mode, opt in, off by default.
- V1.2: real Playwright driver, wired for ChatGPT and Claude.
- V1.3: project connectors, any running or new project can connect.
- V1.4: multi-tenant, one install, many Muse accounts, each isolated.
- V1.5: 9 subscription models with a Connect button, packet mode for
  all, browser driver still only for ChatGPT and Claude.
- V1.6: browser Connect and Disconnect per account, with the login
  verified before Connect is claimed.

Full notes are in [`docs/V1-NOTES.md`](docs/V1-NOTES.md).

## Backend choice for V1: Node with TypeScript, not Rust

V1 uses Node with TypeScript because the existing stack is Node, iteration
is faster, and the adapter ecosystem is wider. RAM saving from Rust is
tiny at this scale, because V1 is a local CLI with small files and small
logs, not a high traffic server. The main risks are credential leak,
prompt injection, an accidental paid call, and an unapproved publish or
deploy, and those are handled by the budget guard, the policy gate, and
the audit log. The adapter interface is language agnostic, so a Rust
sidecar can be added later for a measured hot path without a rewrite.

## License

MIT License. See [`LICENSE`](LICENSE).
