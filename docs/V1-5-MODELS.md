# TrustyMUSE Harness V1.5: Subscription Models

Date: 2026-11-11. Status: V1.5 local only, multi-tenant. Version 1.5.0. No GitHub push, no deploy, no live paid API, no credential stored, no live prompt sent yet.

## The idea in one line

Every major chat AI gets a default Connect button for subscription use (a normal chat account, no API key), not only API. Connecting a model means the harness can route packet jobs to it. That is all it means in V1.5.

## The full model table

| Model | Provider | Connection | Chat URL | Browser support | Connected by default |
|---|---|---|---|---|---|
| chatgpt | OpenAI | subscription | https://chatgpt.com | wired | yes |
| claude | Anthropic | subscription | https://claude.ai | wired | yes |
| gemini | Google | subscription | https://gemini.google.com | packet-only | no |
| grok | xAI | subscription | https://grok.com | packet-only | no |
| deepseek | DeepSeek | subscription | https://chat.deepseek.com | packet-only | no |
| perplexity | Perplexity | subscription | https://perplexity.ai | packet-only | no |
| meta-ai | Meta | subscription | https://meta.ai | packet-only | no |
| copilot | Microsoft | subscription | https://copilot.microsoft.com | packet-only | no |
| mistral | Mistral AI | subscription | https://chat.mistral.ai | packet-only | no |
| openai-api | OpenAI | api | none | packet-only | never, API flow |
| anthropic-api | Anthropic | api | none | packet-only | never, API flow |
| gemini-api | Google | api | none | packet-only | never, API flow |

`gemini` (subscription) and `gemini-api` (API) are two separate entries. Do not confuse them: the subscription entry runs packets in the Gemini chat app, the API entry needs a key and a budget cap above 0.

## What Connect does and does not do

Connect does:

- Records the model as connected for one tenant only, in `state/tenants/<tenantId>/models.json`. Tenant A connecting Gemini does not change tenant B.
- Unlocks packet mode for that model at once. A packet is plain text, so it works for every chat model immediately.
- Writes a `model_connected` audit event with the tenant id.

Connect does NOT:

- Log in to anything. There is no login step, no password, no token, no cookie. The user already has their own chat account and opens it themselves.
- Store a credential of any kind. The file holds only model ids.
- Place any call, send any prompt, or open any browser window.
- Wire a browser driver. That is a separate, per-model job (see below).

## Packet steps for a new model (Gemini example)

```bash
cd ~/workspace/trustymuse-harness
node dist/index.js model-connect --model gemini
node dist/index.js packet --model gemini --type seo --title "First Gemini task" --task "Write a draft about finding clients without a website."
```

1. Open the packet file in `packets/<tenantId>/`.
2. Open https://gemini.google.com in your own browser or app.
3. Copy the packet in, run it there.
4. Paste the result back to TrustyMUSE. The harness validates it and logs it.

Grok works the same way:

```bash
node dist/index.js model-connect --model grok
node dist/index.js packet --model grok --type content --title "First Grok task" --task "Write a short draft."
```

The packet itself names the model and its chat URL at the top, so the user always knows where to run it. For packet-only models it also says browser mode is not wired yet.

## The browser split, stated plainly

- Wired: chatgpt and claude only. The Playwright driver is wired with selectors verified live on 2026-11-10 (V1.2). `run-browser` works for these two, and only these two.
- Packet-only: gemini, grok, deepseek, perplexity, meta-ai, copilot, mistral. No login check, no selector, and no live test exists for any of them. `run-browser --model gemini` is refused with a clear message telling the user to use packet mode instead, even if a browser account exists for that model.

Do not claim a live browser connection for any packet-only model. The Connect button is a subscription packet connection, not a browser connection.

## What wiring a new driver would need

Exactly the V1.2 path, per model, with nothing skipped:

1. Live login check: the user logs in by hand in a profile, the harness checks the logged-in state and fails closed on a login page or a challenge.
2. Live selector verification: prompt box by role and accessible name only, send control behaviour after typing, profile or account button, model picker if one exists. No id, name, or data-testid is hardcoded unless it is actually exposed and verified live.
3. First live test: one small prompt, sent once, result checked and recorded, exactly like the 2026-11-10 ChatGPT and Claude tests.
4. Docs and tests updated, and the registry entry flipped from `packet-only` to `wired` only after steps 1 to 3 pass.

Until then the model stays packet-only, and that is the correct state, not a bug.

## Slot suggestions

`modelsForSlot(slot)` in `src/router.ts` returns subscription models suggested for each slot. These are suggestions only, never a verified capability claim:

- drafting: chatgpt, claude, gemini, grok, deepseek
- research: perplexity, claude, gemini
- coding: claude, chatgpt, deepseek
- reasoning: claude, grok, gemini
- media: gemini, chatgpt

Existing route primaries and fallbacks are unchanged. A suggestion never overrides the router, the tier, or the policy gate.

## Commands

- `node dist/index.js model-list [--tenant <id>]`: every model with connection, browser support, chat URL, and connected or not for the active tenant.
- `node dist/index.js model-connect --model gemini [--tenant <id>]`: connect one subscription model for this tenant. `connect` is an alias. API models are refused with a message saying API needs a key and a budget cap above 0. Unknown models fail closed.
- `node dist/index.js model-disconnect --model gemini [--tenant <id>]`: disconnect one model. Refused while the tenant still has an active browser account for chatgpt or claude. Packets for a disconnected model are refused until it is connected again.
- `node dist/index.js packet --model <any connected subscription model>`: widened in V1.5. An unconnected model is refused with "connect it first with model-connect". An API model is refused.
- `node dist/index.js run-browser --model <model>`: refuses every packet-only model with "browser driver is not wired for <model> yet, use packet mode".
- `node dist/index.js status [--tenant <id>]`: now shows the connected subscription models for the active tenant.

## Disconnect guard

Disconnecting chatgpt or claude is refused while the tenant still has an active browser account for that model, because the account would be left pointing at a model the harness no longer routes to. Remove or pause the account first, then disconnect. Other models have no browser accounts, so they disconnect at once. There is no persisted browser queue to check: the queue only lives in memory while a browser job runs, so the guard checks the account registry.

## Limits in V1.5

- Browser driver not wired for any new model. No live login or selector check for them.
- No live job through the Playwright driver yet, for any model, scoped or otherwise.
- No live paid API call. Budget cap is still 0 per tenant, API adapters are still stubs.
- No per-model budget. The single per-tenant cap still applies.
- The TrustyHarness space was not touched in V1.5. It still shows V1.4 and does not yet show the new models.
