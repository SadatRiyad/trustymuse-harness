# Getting Started with TrustyMUSE Harness

Version 1.9.0. This guide is for a complete beginner. It assumes you have
never used this harness before. It takes you from an empty folder to your
first finished job.

## What the harness is, in plain words

TrustyMUSE Harness is a small program that runs on your own computer. It
helps you send work to chat AI apps like ChatGPT, Claude, Gemini, Grok,
DeepSeek, Perplexity, Meta AI, Copilot, and Mistral. TrustyMUSE is the
controller. The chat AI apps are the workers.

It works in two ways.

**Packet mode.** The harness writes a text file called a packet. The packet
holds your task, the context, and the rules for the answer. You copy the
packet into your own chat AI app, run it there, and paste the result back.
Packet mode works for all 9 connected models at once. It needs no API key.

**Browser mode.** The harness opens your own logged in chat account in a
browser window and sends the prompt for you. Browser mode is wired only
for ChatGPT and Claude. It is off by default, and you must turn it on
yourself after reading the risk note in `V1-1-BROWSER-MODE.md`.

The harness never publishes, sends, merges, or deploys anything on its
own. It never stores your password or any API key. Its monthly budget cap
starts at 0, so no paid API call can happen until you raise the cap
yourself.

## What you need before you start

- Node 20 or newer. The file `package.json` requires Node 20 or newer.
  Check with `node --version`.
- npm, which comes with Node. Check with `npm --version`.
- git. Check with `git --version`.
- A terminal, and about 10 minutes.

No account, no API key, and no payment is needed to start. Packet mode
uses your normal chat AI accounts, the ones you already open in a browser.

## Step 1. Clone the repo

```bash
git clone https://github.com/SadatRiyad/trustymuse-harness.git
cd trustymuse-harness
```

Success looks like this: a folder named `trustymuse-harness` appears, and
the `cd` command puts you inside it. If the clone fails with a 404, the
repo address is wrong or your network blocks GitHub. The repo is public,
so no login is needed. See `FAQ.md` if you see a 404.

## Step 2. Install the dependencies

```bash
npm install
```

Success looks like this: npm finishes without an error, and a folder named
`node_modules` appears. This installs TypeScript and Playwright, the two
things the harness needs.

## Step 3. Run the tests

```bash
npm test
```

Success looks like this: all 119 test groups pass. The groups are V1 7,
browser 10, live driver 9, projects 12, tenants 14, models 15,
connection 15, model-connect 9, analytics 11, and telegram 17. Do not use the harness until the tests pass. If a test
fails, see `TROUBLESHOOTING.md`.

The test command also builds the code first, so after `npm test` the
folder `dist/` exists and the command `node dist/index.js` works.

## Step 4. Set up your tenant

One tenant is one Muse account. Your tenant holds your state, your budget,
your accounts, your projects, and your audit log. No other tenant can see
any of it.

```bash
node dist/index.js setup --id jane-doe --name "Jane Doe"
```

Replace `jane-doe` with your own id, and `Jane Doe` with your own name.
The id is a lowercase slug, 3 to 40 characters, single hyphens only, for
example `sadat-riyad` or `jane-doe`. The name is a display name, so it can
have spaces and capitals.

Success looks like this: the harness prints `Tenant created`, prints five
next steps, and saves your tenant as the default in `config.yaml`. Setup
never asks for a password or a key. If the tenant already exists, setup
says so and changes nothing.

Check your setup with:

```bash
node dist/index.js status
```

Success looks like this: the harness prints your tenant name, the mode
`subscription`, browser `OFF by default`, budget `cap 0 USD`, HOLD `OFF`,
and the list of models with `connected` or `not connected`.

## Step 5. Connect a model

Every model starts disconnected for a fresh tenant. Nothing is
connected until you connect it. Connect one like this:

```bash
node dist/index.js model-connect --model gemini
```

Success looks like this: the harness prints `Model connected` and the
chat URL for Gemini, `https://gemini.google.com`. Connecting only records
that your tenant may use the model. It does not log in, it does not store
a credential, and it places no call.

See all models and their state with:

```bash
node dist/index.js model-list
```

## Step 6. Run your first packet job

Connect ChatGPT first, because a fresh tenant starts with zero
connected models:

```bash
node dist/index.js model-connect --model chatgpt
node dist/index.js packet --model chatgpt --type seo --title "First task" --task "Write a draft about finding clients without a website."
```

Success looks like this: the harness prints `Packet created` and a file
path under `packets/<your-tenant-id>/`, plus the route and the next step.

Now finish the job by hand:

1. Open the packet file and read it.
2. Copy the whole packet into your own ChatGPT app at
   `https://chatgpt.com` and run it there.
3. Paste the result back to TrustyMUSE. The harness checks it before any
   draft is approved.

Try the same with Claude. Connect it first too:

```bash
node dist/index.js model-connect --model claude
node dist/index.js packet --model claude --type code_review --title "Review budget guard" --task "Review src/budget.ts for bypass paths."
```

Check what was logged:

```bash
node dist/index.js audit
```

Success looks like this: the audit list shows your `packet_generated`
events for this tenant.

## Step 7. Browser mode, only for ChatGPT and Claude

Browser mode is optional. Packet mode already works, and you can stop
here. Turn browser mode on only after you read
`V1-1-BROWSER-MODE.md` in full. Automated use of a chat account can
trigger a rate limit, a challenge, or a suspension, and that risk is real.

1. Copy `config.example.yaml` to `config.yaml` if you have not done so
   already, and set `browser.enabled` to `true`.
2. Add a browser account. You give an id, a provider, and a label. You
   never give a password.

```bash
node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT"
```

Success looks like this: the harness prints `Account added` and the
profile folder, for example `profiles/jane-doe/chatgpt-main`.

3. Log in once, by hand, in your own browser, using that profile folder.
   Open your browser with that profile, go to `https://chatgpt.com`, and
   log in with your own account. Close the browser when you are done.
   The harness never asks for your password and never sees it.
4. Verify the login with:

```bash
node dist/index.js browser-connect --account main
```

Success looks like this: the harness prints `Browser connected` and the
time it was verified. If the profile is still on a login page, or a
challenge is showing, connect fails closed and the account stays
disconnected. That is the correct result. Log in by hand and try again.
5. Run a browser job:

```bash
node dist/index.js run-browser --model chatgpt --account main --type seo --title "First live test" --task "Write one short paragraph about finding clients without a website."
```

Success looks like this: the harness prints `Browser job finished`, the
result is saved under `browser-results/<your-tenant-id>/`, and the audit
shows `browser_job_done`. Keep the first live job small, and keep packet
mode ready as the fallback.

Stop using the session any time with:

```bash
node dist/index.js browser-disconnect --account main --reason "Taking a break."
```

Disconnect never deletes the profile and never logs you out of the site,
so you can reconnect later with `browser-connect`. See
`V1-6-BROWSER-CONNECT.md` and `USER-GUIDE.md`.

## Step 8. Connect a project

A project scopes a job to your real work. The harness only reads a short
context block for the project. It never deploys or publishes it.

First, see what the harness can find, read only:

```bash
node dist/index.js project-discover
```

Then connect one project:

```bash
node dist/index.js project-add --id my-project --name "My Project" --kind web-app --path ~/workspace/my-project
```

The project folder must already exist inside `~/workspace`, and the kind
must be one of `web-app`, `api`, `extension`, `static-site`, `docs`, or
`repo-only`. Success looks like this: the harness prints
`Project connected` and the allowed task types.

Run a job scoped to it. Connect ChatGPT first if it is not connected yet:

```bash
node dist/index.js model-connect --model chatgpt
node dist/index.js packet --model chatgpt --type seo --title "Homepage draft" --task "Write a draft about the project homepage." --project my-project
```

Scoped jobs are draft only. They never publish, send, merge, or deploy.

## What to do next

- Read `USER-GUIDE.md` for every command, with flags and examples.
- Read `FAQ.md` for the common questions.
- Read `TROUBLESHOOTING.md` when something fails.
- Read `ARCHITECTURE.md` if you want to understand how the code is built
  or how to contribute.
- Read `CONTRIBUTING.md` before you send a change.

## The short version, all commands in one place

```bash
git clone https://github.com/SadatRiyad/trustymuse-harness.git
cd trustymuse-harness
npm install
npm test
node dist/index.js setup --id jane-doe --name "Jane Doe"
node dist/index.js model-connect --model gemini
node dist/index.js model-connect --model chatgpt
node dist/index.js packet --model chatgpt --type seo --title "First task" --task "Write a draft."
node dist/index.js audit
```
