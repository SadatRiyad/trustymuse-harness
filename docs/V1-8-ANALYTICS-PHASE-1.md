# TrustyMUSE Harness V1.8 Notes: Analytics Phase 1, Local Collector, Dry-Run Preview Only

Date: 2026-11-12. Status: V1.8 local only, multi-tenant, public repo. Version 1.8.0. No central service, no data leaves the machine, no deploy, no live paid API, no credential stored, no live prompt sent yet.

## What V1.8 adds: Analytics Phase 1

Phase 1 of the analytics design builds the local collector only. It does
not build any sending code, and the central service does not exist yet.
See `docs/V1-8-ANALYTICS-PHASE-1.md` and the full design at
`~/workspace/your_files/trustymuse-ai-harness-analytics-design/trustymuse-ai-harness-analytics-design.md`.

- New module `src/analytics/collector.ts`: reads the per-tenant audit
  log and `usage.json` and builds one JSON payload per install, from
  counts only. The payload covers the last 24 hours, except
  `last_active_day`, which is the latest day any packet or browser job
  ran in the whole local audit history.
- Payload fields, exactly the design allowlist, version 1: install id
  (one random UUID, made once, stored in gitignored
  `state/analytics.json`, never identity), harness version, sent time,
  tenant count, connected model ids, jobs by type and by model, packet
  and browser job counts, jobs ok and failed, results validated, error
  categories, budget cap and used bands, browser account counts,
  active project count, last active day, platform family, Node major
  version. The validator refuses any payload whose keys, types, or size
  (10 KB limit) break the allowlist.
- The collector never reads an audit event's detail field, and it never
  reads a project name or path, an account label, a tenant display name
  or label, an email, or a credential. Tenants are counted, never
  named: no tenant id or tenant label appears anywhere in the payload.
  Error categories map by event name only. Two design categories have
  no event name yet in V1.8, so they stay empty: `hold_blocked` and
  `browser_challenge`. `browser_connect_blocked` maps to
  `browser_login_failed`, because the common cause is a profile that is
  not logged in.
- The module holds no remote-call code at all: no fetch, no http, no
  socket, no net module. A test reads the source and refuses any of
  them. Analytics never writes to the harness: it cannot change HOLD,
  budget, policy, models, projects, or accounts, and it cannot trigger
  a job, a publish, a send, a merge, or a deploy.
- CLI: `analytics-preview` (prints the exact JSON payload that would be
  sent, stamps the local last-preview time, and states that nothing was
  sent), `analytics-status` (shows off, the install id or that it is
  not generated yet, payload version 1, collector readiness, last
  preview, last send never), `analytics-enable` (refused: the central
  service is not built yet, Phase 2), `analytics-disable` (a no-op that
  confirms nothing is being sent and changes nothing; the stored install
  id is kept, so Phase 2 can reuse it). All four commands are audit
  logged to the resolved tenant only.
- New tests in `tests/run-analytics-tests.mjs`, 11 groups, temp dirs
  only, no live network: correct counts from a synthetic two-tenant
  audit log with 24 hour window filtering, denylist strings never in
  the payload, install id generated once and stable, budget bands,
  empty install gives zero counts, source scan for remote-call code,
  real CLI scratch-copy tests for preview, status, enable, and
  disable, tenant isolation (each preview audit event lands only in
  its own tenant log), identical counts on a second build, validator
  refuses an extra field and an over-size payload. `npm test` now runs
  102 groups: V1 7, browser 10, live driver 9, projects 12, tenants 14,
  models 15, connection 15, model-connect 9, analytics 11.

## What V1.8 does not do

- It does not send anything. `analytics-preview` is a dry run only.
- It does not enable analytics. There is no key, no registration, and
  no service to register with.
- It does not add a dashboard. The space panel is untouched in V1.8.
- It does not change the harness for a user who never runs an
  analytics command. The only new file a preview creates is
  `state/analytics.json`, which holds the random install id, the
  payload version, and the last preview time.
- Phase 2 (central service, ingest API, owner dashboard) still needs
  the owner decisions from Section 11 of the design: hosting, retention,
  per-install detail vs aggregates only, geography, dashboard home,
  pilot group, and cost ceiling.
