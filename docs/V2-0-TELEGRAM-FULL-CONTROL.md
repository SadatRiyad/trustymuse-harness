# TrustyMUSE Harness V2.0: Telegram Full Control

Date: 2026-11-14. Status: V2.0 local only, multi-tenant, public repo. Version 2.0.0. No central service, no data leaves the machine, no deploy, no live paid API, no credential stored, no live bot run yet.

V1.9 gave Telegram read-only commands plus draft packets. V2.0 finishes the job the user asked for: control everything the harness can do from Telegram, without coming to the Muse app every time. Project add, remove, and pause, model connect and disconnect, task creation, HOLD on and off, and one browser job at a time on a connected account with `/run`. `/do` takes plain words and turns them into a packet, a project-scoped task, or a plan-then-audit pipeline. The bot never deploys, publishes, merges, or sends anything.

## The token: environment first, file second, panel box next

The bot reads the token from `TELEGRAM_BOT_TOKEN` first, then from the file token in gitignored `state/telegram.json`. The file holds the allowlist and, under the key `botToken`, the token. The environment token wins when both are set.

This order exists so the TrustyHarness panel can write the token from a box: the panel box writes the file token, and the bot picks it up on the next start. The panel box itself is a panel change that comes after this CLI work. It is not built yet, so for now the token is set in the environment, or written to the file by `setTelegramFileToken` in code.

The token is never logged, never printed, and never included in an audit event. `telegram-token-status` prints only set or not set, and the source, env or file. `telegram-token-clear` removes the file token and keeps the allowlist. Starting the bot with no token in either place refuses, exactly as in V1.9.

```bash
export TELEGRAM_BOT_TOKEN=<token from @BotFather>
node dist/index.js telegram-start
node dist/index.js telegram-token-status
node dist/index.js telegram-token-clear
```

## Full command list

Read-only, as in V1.9: `/start`, `/help`, `/status`, `/models`, `/projects` (also `/project_list`), `/browser_status`, `/analytics_status`, `/analytics_preview`, `/audit`.

New read commands: `/account_list` (browser accounts and their state), `/tenant_status` (tenant, budget, projects, accounts, audit count).

Write commands, all for allowlisted ids only, all audit logged per tenant, HOLD blocks every one of them:

- `/project_add <id> <name> <kind> <path>` connects a project. The path must sit inside the workspace, the same rule as `project-add`. Quote a name with spaces.
- `/project_remove <id>` disconnects a project.
- `/project_pause <id>` pauses a project. Paused projects cannot run jobs.
- `/model_connect <id>` connects a subscription model. API models are refused.
- `/model_disconnect <id>` disconnects a subscription model. Disconnecting chatgpt or claude is refused while this tenant still has an active browser account for it, the same rule as `model-disconnect` on the command line.
- `/task --model <id> --type <type> --title "<title>" --task "<task>" [--project <id>]` creates a task and its packet, the same as `/packet`.
- `/hold on` turns HOLD on at once. `/hold off` asks for a YES in the next message first, and only turns HOLD off when the user replies YES. Any other next message cancels the confirmation. Turning HOLD on is always allowed, even while a confirmation is pending. The pending confirmation lives in memory only, so a bot restart clears it.

## /run: one browser job from Telegram

```
/run --account <id> --task "<task>" [--model <id>] [--type <type>] [--title "<title>"] [--project <id>]
```

Every gate from `run-browser` applies, in the same order: HOLD, browser mode on, wired driver (chatgpt and claude only), account found, provider matches the model, account connected. A disconnected or pending account is refused and the reply names `browser-connect`. The shared queue enforces one job at a time per account, pacing, the daily limit, and retry once then pause. The result file is written to `browser-results/<tenant>/`, the same as the CLI, and the reply is the worker's own words, truncated to the 4000 character Telegram limit.

`/run_browser` stays refused. It now names `/run` instead of the CLI only.

## /do: plain words into harness work

`/do` is a small intent parser, no LLM call. It handles three patterns, in this order:

1. `plan with chatgpt then audit with claude: <task>` is a two-step pipeline. Step 1 writes a plan with the first model, step 2 audits it with the second. When both models have connected browser accounts, both steps run through the driver, plan first, then audit with the plan result as its input. When either account is missing, both steps become packets instead, and the reply tells the user to run them. The plan packet is type `research`, the audit packet is type `code_review`.
2. `project <id>: <task>` is a project-scoped task. It creates one packet with that project's context.
3. `<task> with <model>` picks the model. The trailing word must be a known subscription model id, so "write a blog post with images" stays a plain task.

Anything else is a plain task for chatgpt, type `content`.

The pipeline reply puts the audit first, then the plan, because the audit is what the user decides on. Both results are saved to `browser-results/<tenant>/` when they run.

## The deploy gate

`/do` never deploys. When the instruction mentions deploy, live, or publish, the bot runs the plan and audit steps and then reports the verdict:

- Audit ran and passed the text-marker check: "Audit passed. Ready to deploy, but the deploy itself needs your approval in the Muse app."
- Audit ran and failed the text-marker check: "Audit failed. Not deploying."
- Audit never ran (packets only): "Nothing was deployed. The audit has not run yet, so nothing is verified."

The text-marker check looks for failure words in the audit reply: fail, failed, failure, error, not ready, blocked, cannot proceed, do not deploy. The reply says plainly that this is a text-marker check, not a full verification, and that the user must read the audit before approving anything. A passing marker check is not proof the work is good. The deploy step stays approval-gated in the Muse app.

## Safety, unchanged in shape, wider in scope

- Only allowlisted numeric Telegram user ids get any reply. A non-allowlisted id gets no reply at all, and the attempt is audit logged once per minute per user.
- HOLD blocks every Telegram write: packets, tasks, projects, models, browser jobs, and the pipeline. Turning HOLD on is never blocked. Turning it off needs the YES confirmation.
- Budget cap 0 still blocks paid API calls. The bot never places an API call and never spends budget.
- Per-user rate limit: 20 commands per minute, then a polite slow-down reply. It applies to writes as well as reads.
- Every handled Telegram command writes exactly one audit event per tenant, with the numeric Telegram user id only, plus the owner-given label when one exists. Browser job lifecycle events are not written to the audit log from Telegram: the single command outcome event is the record. No prompt text is ever put in an audit event, and `/audit` output still carries no detail text.
- The bot never sends a prompt that contains a credential, because no credential is ever stored in a packet, a project, an account, or the allowlist.

## What is still NOT done

- No dashboard token box yet. The file-token fallback is built, and the panel box that writes it is a separate panel change that comes after this CLI work.
- No live bot run yet. No real token exists, so the bot has only run against a mock Telegram API in tests.
- No deploy from Telegram. The deploy step stays approval-gated in the Muse app.
- No webhook mode. Long polling only.
- No Phase 2 analytics service. `/analytics_preview` is still a dry-run preview, and `analytics-enable` is still refused.

## Tests

`tests/run-telegram-tests.mjs` now runs 35 groups: the 17 V1.9 groups, plus 18 V2.0 groups, temp dirs only, mock Telegram API only, never api.telegram.org, no real token. The new groups cover: token from file fallback and env precedence, token-status never printing a token and token-clear removing it (real CLI in a scratch copy), file token and allowlist preserving each other, `/project_add` through the bot with an outside-workspace path refused, `/project_remove` and `/project_pause`, `/model_connect` and `/model_disconnect` with the active-account refusal, `/hold on` immediate and `/hold off` needing YES with a non-YES cancel, `/run` refusing a disconnected account, `/run` enforcing the daily limit, `/run` succeeding with the mock driver and writing exactly one audit event, `/do` parsing all three patterns, the pipeline with deploy words and no accounts never deploying, the pipeline with mock drivers for both accounts running plan then audit and reporting the deploy verdict, the project pattern creating a project-scoped packet, the rate limit applying to writes, one audit event per write command, the `/task` alias with `/account_list` and `/tenant_status`, and `/run` with HOLD on refused.

`npm test` now runs 137 groups: V1 7, browser 10, live driver 9, projects 12, tenants 14, models 15, connection 15, model-connect 9, analytics 11, telegram 35.
