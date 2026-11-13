# TrustyMUSE Harness Documentation

Version 2.0.0. Start here. Each document says who it is for in one line.

## Start here

- [`GETTING-STARTED.md`](GETTING-STARTED.md): for a complete beginner.
  Clone, install, test, setup, first packet job, browser mode, first
  project. Every step with the exact command and what success looks like.
- [`USER-GUIDE.md`](USER-GUIDE.md): for every user. The full command
  reference, with flags, real examples, packet mode vs browser mode,
  budget, HOLD, the audit log, and what each command refuses and why.
- [`FAQ.md`](FAQ.md): for anyone with a question. 27 short answers,
  drawn only from verified facts, including the 404, tenant ids, the
  cloud login, pending connect, disconnect, cap 0, CAPTCHA, Chromium
  install, and cross-account control.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md): for anyone stuck. Symptom,
  cause, and exact fix for each known failure, including test failures,
  unknown tenants, disconnected accounts, login pages, paused projects,
  and the profile path layout.

## Understand and build

- [`ARCHITECTURE.md`](ARCHITECTURE.md): for developers. The 9 design
  components mapped to code, the packet flow, the browser flow, tenant
  isolation, policy tiers, the audit format, and the honest limits.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): for contributors. How to
  send a change, the code rules, and what a reviewer checks.
- [`../INSTALL.md`](../INSTALL.md): for a new Muse account. Install,
  setup, tenants, switching tenants, migration, safety rules, and limits.
- [`../README.md`](../README.md): for everyone. The short intro,
  quickstart, feature list, safety rules, and links to all docs.

## Version notes, one per version

- [`V1-NOTES.md`](V1-NOTES.md): what V1 through V2.0 do, what they do
  not do, and how to run the first test.
- [`V1-1-BROWSER-MODE.md`](V1-1-BROWSER-MODE.md): browser session mode,
  the risk disclosure, multi account rules, and how to enable it.
- [`V1-2-LIVE-DRIVER.md`](V1-2-LIVE-DRIVER.md): the real Playwright
  driver, the verified selectors, what is still unverified, and how to
  run the first live job.
- [`V1-3-PROJECTS.md`](V1-3-PROJECTS.md): project connectors, discovery,
  context safety, and scoped jobs.
- [`V1-4-MULTI-TENANT.md`](V1-4-MULTI-TENANT.md): the tenant model,
  isolation guarantees, migration, and what a hosted team server would
  need.
- [`V1-5-MODELS.md`](V1-5-MODELS.md): the 9 subscription models, what
  Connect does and does not do, packet steps, the browser split, and what
  wiring a new driver would need.
- [`V1-6-BROWSER-CONNECT.md`](V1-6-BROWSER-CONNECT.md): browser Connect
  and Disconnect, what Connect verifies, what Disconnect does and does
  not do, the manual login step, and why the cloud browser login is not
  the same login.
- [`V1-7-CONNECTED-MEANS.md`](V1-7-CONNECTED-MEANS.md): what connected
  means, the removed auto-seed, and what existing tenants keep.
- [`V1-8-ANALYTICS-PHASE-1.md`](V1-8-ANALYTICS-PHASE-1.md): Analytics
  Phase 1, local collector with a dry-run preview only.
- [`V1-9-TELEGRAM-BOT.md`](V1-9-TELEGRAM-BOT.md): Telegram Bot control,
  allowlist, commands, and safety rules.
- [`V2-0-TELEGRAM-FULL-CONTROL.md`](V2-0-TELEGRAM-FULL-CONTROL.md):
  Telegram full control, `/run`, `/do`, the deploy gate, and the token
  fallback.
- [`V2-1-BOT-START-FROM-PANEL.md`](V2-1-BOT-START-FROM-PANEL.md):
  the bot starts from the dashboard, the supervisor contract, the
  heartbeat, and the poll loop fix for HTTP 409.
