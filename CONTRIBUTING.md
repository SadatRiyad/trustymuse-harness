# Contributing to TrustyMUSE Harness

Version 1.6.0. Thank you for helping. This file says how to send a
change that can be accepted. The short rule is: run the full test suite
before any change, keep every safety rule, and never claim what you have
not verified.

## How to contribute

1. Clone the public repo and install:

```bash
git clone https://github.com/SadatRiyad/trustymuse-harness.git
cd trustymuse-harness
npm install
npm test
```

All 82 test groups must pass before you change anything. If they do not
pass on a fresh clone, stop and report it. Do not build on a failing
suite.

2. Make your change on a branch, not on `main`:

```bash
git checkout -b my-change
```

3. Write or update a test for the change, in the matching suite under
`tests/`. A new command needs a test. A new refusal needs a test. A new
gate needs a test that the gate blocks and a test that it allows.
4. Run the full suite again:

```bash
npm test
```

All 82 groups, plus any new groups you added, must pass. No suite makes
a live network call. Tests use temp folders only, the mock driver, or
fake pages.

5. Update the docs that describe what you changed. A new command goes in
`docs/USER-GUIDE.md`. A new behaviour goes in `docs/GETTING-STARTED.md`
when a beginner meets it. A new limit goes in `docs/FAQ.md` and in the
honest limits section of `docs/ARCHITECTURE.md`. A version note goes in
`docs/V1-NOTES.md`.
6. Send the change for review. Explain what you changed, why, what the
tests prove, and what is still unverified. Do not merge your own change.

## Code rules

These rules are not style tips. They are safety rules. A change that
breaks one is refused.

- No credential in code, config, packets, or logs. No password, token,
  secret, API key, session token, or cookie is ever stored, printed, or
  written to a file. Keys come from the environment only. Test data must
  never hold a real credential. If a record could hold a secret-like
  field, reject it on load and on save, the way the account, tenant, and
  project registries already do.
- No auto publish, send, merge, or deploy. Nothing in the harness may
  take an external action on its own. A draft stays a draft until the
  user approves that exact item, outside the harness.
- HOLD fails closed. When HOLD is on, or when policy cannot be read,
  writes stop. A new write path must check HOLD. The one exception is
  `browser-disconnect`, which is never blocked, because stopping use
  must never be blocked.
- No secret in tests. Tests use temp folders only, the mock driver, or
  fake pages. No test makes a live network call, logs in to a real
  account, or sends a live prompt.
- Fail closed, with a clear reason. A refusal must print why it refused
  and write a blocked audit event. Never claim success you have not
  verified. A connected flag must come from a verified check, never from
  a guess.
- No id, name, or data-testid is hardcoded for a live site unless it was
  verified live on that site. Use role and accessible name only, and
  record what was verified and what was not.
- Keep the budget guard in front of every paid call. The cap defaults to
  0, which blocks every paid API call. A new adapter must stay a stub
  until a live API phase is built and approved, and it must keep the same
  guard.
- CAPTCHA is never auto solved. A challenge pauses the account at once.
  A new driver path must keep that rule.
- Keep tenant isolation total. No cross-tenant read anywhere. State
  access goes through the tenant-scoped context. A tenant id is validated
  before any path is built.
- Keep the code plain and short. Short sentences in docs, short
  functions in code, no marketing fluff, no invented features, no fake
  badges, no fake version numbers. Never use long dash characters in
  docs. Use commas, periods, colons, or short hyphens only.

## How to propose a change

Open an issue first when the change is bigger than a small fix. Say what
problem it solves, what you plan to change, what the tests will prove,
and what will stay unverified. Wait for a maintainer to agree before you
build it. Small fixes, such as a typo in a doc or a wrong example
command, can go straight to a change with a short note.

A good change has:

- A clear problem, in one or two sentences.
- A test that fails before the change and passes after it.
- Docs updated in the same change, not later.
- No new dependency without a reason, and no dependency that makes a
  live call during tests.

## What a reviewer checks

- The full suite passes, old groups and new groups.
- No credential, no secret, and no live call in the change.
- Every new refusal has a clear message and a blocked audit event.
- Every new command is in `docs/USER-GUIDE.md` with flags and a real
  example, and every new behaviour is in the right doc.
- Nothing is claimed that the tests do not prove. A connected flag, a
  verified selector, and a live test are claims that need proof in the
  change.

## License

The harness is under the MIT License. See `LICENSE`. By sending a
change, you agree that your change is under the same license.
