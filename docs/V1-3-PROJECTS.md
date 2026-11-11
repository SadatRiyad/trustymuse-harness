# TrustyMUSE Harness V1.3: Project Connectors

Date: 2026-11-10. Status: V1.3 local only, version 1.3.0. No GitHub push, no deploy, no live prompt sent, no live paid API call, no credential stored. Budget cap stays 0.

## What V1.3 adds

Any running project, or any new project, can connect to the harness. Every harness job can be scoped to one project, with that project's context, boundaries, and audit trail. A project is a scope, not a deployment target. Connecting a project never deploys it, never publishes from it, and never stores a credential.

- `src/projects/projects.ts`: project registry in `state/projects.json`, following the `accounts.ts` pattern. Validation rejects duplicate ids, missing or non-existent root paths, any root outside `~/workspace` (including `..` escapes, `/tmp`, `/etc`, and the home directory itself), any field containing a password, token, secret, API key, session token, or cookie, unknown kinds, unknown task types, and any allowed action beyond read and draft.
- `src/projects/discover.ts`: read-only discovery. Scans one level deep under `~/workspace` and `~/workspace/github-repos`, detects `package.json`, `server.js`, `README.md`, `.git`, extension manifests, and `docs/`, and classifies kind and stack from what is actually present. It never auto-connects and never writes anything.
- `src/projects/context.ts`: builds a short, safe context block for packets and browser jobs. Project name, id, kind, stack, live URL, repo, root path, allowed task types, and boundaries, plus a top-level file listing only, at most 20 entries. It never reads file contents, and it always excludes `.env`, `*.pem`, `*.key`, `node_modules`, `.git`, credentials, secrets, `profiles`, and `state`.
- CLI: `project-add`, `project-list`, `project-show`, `project-remove`, `project-pause`, `project-discover`, `project-status`, and a `--project <id>` flag on `packet` and `run-browser`.
- Config: `projects.max_projects`, default 20, range 1 to 100. No other default changed. Budget cap stays 0, API stays off, browser stays off.

## What connects

Any folder inside `~/workspace` that exists on disk. Kinds: `web-app`, `api`, `extension`, `static-site`, `docs`, `repo-only`. A running project connects the same way a new project does. The only difference is that a running project already has files, a live URL, and a repo to record, while a new project starts with an empty folder and no live URL yet.

Already connected and seeded in `state/projects.json`, verified against the real folders on disk:

| Project | Kind | Stack | Live URL | Repo |
|---|---|---|---|---|
| trustytouch | web-app | Node.js, server.js, libsql/Turso, QR | https://trustytouch.com | none recorded |
| clienthunt-production | web-app | Node.js Express, static HTML, Chrome extension (Google Maps) | https://clienthuntai.com | none recorded |
| clienthuntai-api | api | Node.js Express, MongoDB, Stripe | none recorded | SadatRiyad/clienthuntai-api |
| trusty-github-engineering | repo-only | Python, GitHub automation | none recorded | SadatRiyad/trusty-github-engineering |

No live URL is recorded unless it was one of the two verified live URLs above. No repo is recorded unless it was verified. Duplicate `clienthunt-new-*` and `clienthunt-reset-*` folders were not seeded.

## How to connect a running project, in 4 steps

1. Find candidates, read only, nothing is connected yet:
   `node dist/index.js project-discover`
2. Connect the one you want, with its real folder. Use the exact kind from discovery, or the kind you checked by hand:
   `node dist/index.js project-add --id trustytouch --name "TrustyTouch" --kind web-app --path ~/workspace/trustytouch --live-url https://trustytouch.com --stack "Node.js, server.js, libsql/Turso, QR"`
3. Check it:
   `node dist/index.js project-show --id trustytouch`
4. Run a job scoped to it:
   `node dist/index.js packet --model chatgpt --type seo --title "TrustyTouch homepage draft" --task "Write a draft about the TrustyTouch digital card." --project trustytouch`

## How to connect a new project

1. Create the folder first, inside `~/workspace`. The harness never creates a project folder for you:
   `mkdir -p ~/workspace/my-new-project`
2. Connect it. Leave the live URL off until the project is really live:
   `node dist/index.js project-add --id my-new-project --name "My New Project" --kind web-app --path ~/workspace/my-new-project --stack "Node.js"`
3. Run a scoped job the same way as for a running project, with `--project my-new-project`. When the project goes live later, the live URL is recorded by removing and re-adding the project with `--live-url`, because there is no edit command in V1.3.

## What is allowed and what is blocked

Allowed for every connected project, by default:

- `read`: the harness may read the project context and the top-level file listing.
- `draft`: the harness may produce drafts for the project, in packets and in browser jobs.

Blocked, always, for every project:

- `publish`, `send`, `merge`, `deploy`: rejected at validation time if anyone tries to allow them, and never automatic. A draft still needs per-item user approval before any of those happen, outside the harness.
- A job for a task type the project does not allow. Example: `clienthuntai-api` allows `code_review`, `research`, and `content` only, so a `seo` job scoped to it fails closed with a clear message.
- A job for a paused or archived project. Only active projects run jobs.
- Any project write while HOLD is on: `project-add`, `project-remove`, and `project-pause` are all blocked, and so is any scoped job.
- Any root path outside `~/workspace`, any secret in any field, and any project count above `max_projects`.

Every project event is written to the audit log in `state/audit.jsonl`: `project_added`, `project_removed`, `project_paused`, `packet_generated` with `project:<id>`, `browser_job_done` with `project:<id>`, and blocked events with result `blocked`.

## How discovery works

`project-discover` scans one level deep under `~/workspace` and `~/workspace/github-repos`. It skips hidden folders, `node_modules`, `.git`, `state`, `profiles`, and the harness folder itself. For each folder it records signals (`package.json`, `server.js`, `server/package.json`, `index.html`, `README.md`, `.git`, extension manifest, `docs/`, `src/`) and classifies:

- Extension manifest only: `extension`.
- Server package with no site index: `api`.
- Package, server, or site index: `web-app`.
- Index page only: `static-site`.
- README and docs only: `docs`.
- Git repo or README with no code signals: `repo-only`.

Stack comes from what is actually present: Node.js, Express, MongoDB, Stripe, libsql/Turso, Next.js, React, Python, Chrome extension, static HTML. If nothing is detected, the stack says so honestly instead of guessing. Discovery is a suggestion list. It never connects anything on its own.

## First project job example

Connect, then run a scoped packet, then check the audit:

```bash
cd ~/workspace/trustymuse-harness
npm test
node dist/index.js project-list
node dist/index.js packet --model claude --type code_review --title "Review TrustyTouch server" --task "Review server.js for security issues. Draft only, list findings with exact file and line." --project trustytouch
node dist/index.js audit
```

The packet file in `packets/` contains the project context block: project name, kind, stack, live URL, root path, allowed task types, boundaries, and the top-level file listing. Copy it into your own Claude app, run it, and paste the result back, the same as any V1 packet.

## Limits in V1.3

- No edit command. To change a project's live URL, repo, stack, or allowed task types, remove it and re-add it with the corrected values. The project folder itself is never touched by remove.
- No per-project budget. The single monthly budget cap still applies to the whole harness, and it stays 0.
- No GitHub connection. A `repo` field is a label for context and audit only. The harness does not read the repo, push to it, or open issues in it.
- No live job through the driver yet. Scoped packets work now. A scoped browser job needs browser mode on and a logged in local profile, the same as any V1.2 browser job, and no live prompt has been sent through the driver yet.
- Discovery is one level deep only. A project nested two levels down is not found by discovery, but it can still be connected with `project-add` using its full path, as long as it is inside `~/workspace`.
