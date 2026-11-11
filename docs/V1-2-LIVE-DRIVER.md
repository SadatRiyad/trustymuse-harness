# TrustyMUSE Harness V1.2 Live Driver

Date: 2026-11-10. Status: real Playwright driver wired, version 1.2.0. Local only, no GitHub push, no deploy, no live prompt sent in V1.2 work, no live paid API call.

## What is now wired

- Playwright is a dependency, version 1.65.0, recorded in package.json. Chromium binary is Chrome for Testing 158.0.8127.18, in the Playwright cache as chromium-1254 and chromium_headless_shell-1254, and a real headless launch was verified with launchPersistentContext.
- Install note, read before you reinstall: `npx playwright install chromium` failed repeatedly on this machine because /tmp is a 512M tmpfs and it filled up during the 197.8 MiB download, so the download died near 90 percent each time. The binaries were installed manually instead, with curl and resume into the Playwright cache. For a future reinstall, set TMPDIR to a home directory first, for example `TMPDIR=~/tmp npx playwright install chromium`, so the download temp dir has room.
- `PlaywrightBrowserDriver` in `src/session/browser.ts` is a real driver, not a skeleton. Its `wired` flag is true.
- `openProfile` launches Chromium with a persistent context at the account profileDir, opens the provider URL, and checks the user is logged in before any prompt is sent. It fails closed if the profile is still on a login page, or if a challenge is on the page.
- `sendPrompt` finds the prompt box by role textbox and accessible name, types the prompt, waits briefly, then clicks the Send message button if it appears and is enabled, otherwise presses Enter. It records which path was used in `lastSendPath`, and the CLI prints it after a job.
- `waitForResponse` waits for the response to finish, using a stop control or a stable assistant message, with a timeout, and returns the last assistant message text. It throws on challenge text and on timeout.
- Challenge detection is kept, and CAPTCHA is never auto solved. A challenge pauses the account through the queue, as in V1.1.
- The CLI `run-browser` now uses the real driver by default. `TRUSTYMUSE_BROWSER_MOCK=1` still selects the mock driver for queue tests. Packet mode stays as the fallback.

## Selectors used, and only these

All selectors below were verified live on 2026-11-10. They are in `LIVE_SELECTORS` in `src/session/browser.ts`. No id, name, or data-testid was exposed for either prompt box in the live checks, so the driver uses role and accessible name and placeholder only.

ChatGPT, logged in:
- Profile shows business mail, plan Free, button Open profile menu.
- Prompt box is role textbox, name Ask ChatGPT, placeholder Ask ChatGPT.
- Composer has Add files and more, Think, Dictate, Start Voice.
- No Send message button in the empty state, no separate model picker.
- New chat in Chat history, Recents shows No chats.

Claude, logged in at claude.ai/new:
- BB Free, Free plan.
- Prompt box is role textbox, name Write your prompt to Claude, placeholder How can I help you today?
- Composer has Add files, connectors, and more, Surface Chat checked and Cowork, Press and hold to record, Use voice mode.
- Model picker is button Model: Sonnet 5.5 Medium.
- New chat link is New, Chats and tasks list exists.
- No send button in the empty state.

Note on the Claude profile label: BB Free was the observed button label for this account. It may differ per account. The driver checks the Free plan text first, and uses BB Free only as a fallback, then the /new URL.

## What is still unverified

- Send button after typing, on both sites. It was not visible in the empty state on either site, and no prompt was sent in the live checks, so the driver cannot claim it is verified. The driver tries it first if it appears and is enabled, otherwise it presses Enter, and it logs which path was used.
- Model picker menu contents, on both sites. The Claude model button label is verified, but the menu inside it was not opened, because no prompt was to be sent.
- Response stop control label. The driver checks for Stop and Stop generating, but neither label was verified live as a stop control. If neither appears, the driver falls back to waiting for a stable assistant message.
- Assistant message extraction. The driver tries the data-message-author-role assistant marker first, then falls back to main text. That marker was not verified live as a DOM attribute, because the live checks used accessible names only. If the first live job returns a wrong or truncated text, report it and the extraction must be fixed before the next job.

## How to run the first live job

1. Run `npm install`, then `npm test`. All test groups must pass.
2. Run `npx playwright install chromium` once, if the browser binary is not already installed.
3. Read `docs/V1-1-BROWSER-MODE.md` in full, then set `browser.enabled` to true in `config.yaml`.
4. Add an account if you have not done so: `node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT"`.
5. Log in once, by hand, in that profile, in your own browser. The harness never asks for your password.
6. Run one small live job first, with a short prompt, for example:
   `node dist/index.js run-browser --model chatgpt --account main --type seo --title "First live test" --task "Write one short paragraph about finding clients without a website."`
7. Check the output in `browser-results/`, check `node dist/index.js audit`, and check the printed send path. If the send path was enter, that is expected until the send button is verified live.
8. Do the same for Claude only after the ChatGPT live job looks correct.
9. If an account is paused or challenged, stop, check it by hand, and use packet mode while it is paused.

## Risk note

- Automated use of a chat account can trigger a rate limit, a challenge, or a suspension. V1.2 does not remove that risk. It only reduces it with pacing, daily limits, one job at a time, and an immediate pause on challenge.
- The live websites change their UI often. A selector verified on 2026-11-10 can break later. If a job fails with prompt box not found, or a login check fails, do not retry in a loop. Check the site by hand first.
- No live prompt was sent while V1.2 was built. The first live job is the first real test, so keep it small, keep it to one account, and keep packet mode ready as the fallback.
- Budget cap is still 0, and API adapters are still stubs. A browser job does not spend API budget, and it does not publish, send, merge, or deploy anything on its own.
