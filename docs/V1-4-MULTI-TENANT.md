# TrustyMUSE Harness V1.4: Multi-Tenant Support

Date: 2026-11-11. Status: V1.4 local only. Multi-tenant support added,
version 1.4.0. No GitHub push, no deploy, no live paid API, no credential
stored, no live prompt sent yet.

## The tenant model

One tenant is one Muse account. One install serves many tenants, each
fully isolated:

- State: `state/tenants/<tenantId>/audit.jsonl`, `usage.json`,
  `accounts.json`, `projects.json`.
- Browser profiles: `profiles/<tenantId>/<provider>-<id>/`.
- Packets: `packets/<tenantId>/`. Browser results:
  `browser-results/<tenantId>/`.
- Budget: per tenant. Each tenant has its own monthly cap (default 0)
  and its own usage. A tenant's cap wins over the harness-wide cap in
  config.yaml when it is set.
- Audit: the tenant id is part of every audit event.

Shared across tenants: only the code, `config.yaml`, the model
registry, and the router. The registry at `state/tenants.json` holds
only tenant ids, display names, labels, status, caps, and timestamps.
No tenant data ever lives there.

All state access goes through the tenant-scoped context in
`src/tenants/context.ts`. There is no cross-tenant read anywhere in
the CLI. A job scoped to tenant A cannot see tenant B's projects,
accounts, or audit events, and the test suite proves it.

## Setup for a new Muse account, in 5 steps

```bash
git clone <your copy of the trustymuse-harness repo>
cd trustymuse-harness
npm install
npm test
node dist/index.js setup --id <your-id> --name "<Your Name>"
```

Setup is interactive-free: it creates the tenant, writes config.yaml
from config.example.yaml when one is missing, makes the tenant the
default, and prints five next steps. It never asks for a password or
a key. Then the user connects their own ChatGPT or Claude account,
logs in once by hand in that profile, connects their own project, and
runs their first packet job. Full steps are in `INSTALL.md`.

## Isolation guarantees, and what is NOT shared

Guaranteed and tested:

- Tenant A lists zero of tenant B's projects, accounts, and audit
  events, even when both exist on the same install.
- Tenant A cannot spend tenant B's budget. Usage files are separate.
- Tenant A cannot open tenant B's browser profile. Profiles live
  under separate folders.
- A tenant id can never escape `state/tenants/` through `..`, `/`, or
  an absolute path. Validation rejects it before any path is built.
- Tenant records reject any field containing password, token, secret,
  apiKey, sessionToken, or cookie, on every load and every save.

Not shared, by design: there is no shared dashboard, no shared
queue, and no cross-account job routing in V1.4.

## Tenant resolution and fail closed

Order: `--tenant` flag, then `TRUSTYMUSE_TENANT`, then
`tenants.default` in config.yaml, then `default`. Unknown, paused,
and corrupt tenants fail closed: the command stops before any state
is read or written, and the message names the tenant and the reason.
A registered tenant whose state directory is missing is treated as
corruption, not as a fresh tenant, and is refused. `tenant-remove`
refuses to remove the last active tenant, and refuses when a tenant's
state file is corrupt. On a fresh install with no registry at all,
the built-in `default` tenant is created once, so first-run commands
keep working. `default` is reserved: `tenant-add` will not let a user
claim it as a tenant id.

## Migration notes

`node dist/index.js tenant-migrate` moves the V1.3 single-user state
(`state/projects.json`, `state/audit.jsonl`, `state/usage.json` and
`state/accounts.json` when present, `profiles/` when present) into the
`sadat-riyad` tenant. Every copy is verified byte-identical before
anything is archived. The originals are then moved, never deleted,
under `state/migrated-backup-YYYY-MM-DD/`. Running it twice changes
nothing the second time. After migration, `tenants.default` in
config.yaml is set to `sadat-riyad`, so existing commands keep working
without a `--tenant` flag. `sadat-riyad` is the migration target for
the original install only; a fresh install never uses it.

Two migration edge cases were found by the tests and fixed in the
code: the profile copy destination sits inside the source `profiles/`
directory, so the copy skips the destination folder instead of
recursing into itself, and the archive step moves each old profile
folder separately instead of renaming the whole `profiles/`
directory, which would have carried the new tenant folder into the
backup.

## Limits

- No central server. V1.4 does NOT let one user see or control
  another user's Muse account. Each Muse account runs its own copy
  of the harness in its own Muse workspace.
- No hosted team server, no shared dashboard, no shared queue.
- No live prompt has been sent through the Playwright driver yet.
- No live paid API call. Budget cap is 0 per tenant by default.
- Max 10 tenants per install by default (range 1 to 50 in
  config.yaml). Max 20 projects per tenant by default.
- The `repo` field on a project is a context and audit label only,
  not a GitHub connection.

## What a future hosted team server would need

A hosted version would need, at minimum: authenticated accounts with
a real identity provider (not a label typed at setup), transport
encryption and per-tenant encryption at rest, a server-side policy
and HOLD gate that tenants cannot bypass from the CLI, per-tenant
quotas enforced server-side, an audit log tenants cannot rewrite,
and a clear data-residency and deletion story. It would also need an
answer to the subscription-account question: normal ChatGPT and
Claude chat accounts have no official API, so a server cannot drive
them the way it drives API keys, and browser automation against them
carries the same challenge and suspension risk as the local driver.
None of that is built in V1.4, and building it would be a separate
project with its own authorization, not an extension of this one.
