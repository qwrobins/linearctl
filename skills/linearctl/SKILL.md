---
name: linearctl
description: Agent-first CLI for the Linear API — curated commands, generated API, and raw GraphQL with stable JSON output contracts
---

# linearctl

Default skill for all Linear CLI usage. Use this skill for any request involving Linear data unless raw GraphQL is explicitly required or the curated/generated layers cannot cover the operation.

## First-time setup

If the user has not configured the CLI yet, help them bootstrap:

1. Create the config directory: `mkdir -p ~/.config/linear`
2. Create a credentials file with their API key:
   ```bash
   export LINEAR_API_KEY=lin_api_...
   linearctl auth login --profile <name> --api-key-env LINEAR_API_KEY --set-default
   ```
3. Set a default team: `linearctl team list --json` to find team keys, then `linearctl team get <key> --set-default`
4. Verify: `linearctl auth whoami --json`

API keys are created at https://linear.app/settings/api. For OAuth, see https://linear.app/settings/api/applications.

## Command routing

1. Use curated commands when they cover the operation.
2. Otherwise use generated `linearctl api` commands.
3. Otherwise use `linearctl gql`.

Raw GraphQL should not be used merely because it is possible. It is the fallback for gaps only.

## Available curated commands

### Issues
- `linearctl issue get <identifier> --json` / `linearctl issue view <identifier> --json` — fetch a single issue by identifier (e.g. INF-2975) or UUID
- `linearctl issue list [--search <text>|--query <text>] [--state <name> ...] [--status <name>] [--assignee <name|displayName|email|"me"|id>] [--team <id|key|name>] [--label <name|id>] [--priority <0-4>] [--cycle <id>] [--project <name|id>] [--created-after <date>] [--updated-after <date>] [--completed-after <date>] [--order-by <field>] [--all-teams] [--all] [--max <n>|--limit <n>] [--json]` — list issues with filters; repeated `--state` values are unioned; `--status` aliases `--state`; `--search`/`--query` routes to full-text search and composes with the other filters; friendly names resolve case-insensitively
- `linearctl issue search [<text>|--query <text>] [--all] --json` — full-text search across issues
- `linearctl issue create --title <title> --team <id> [--description <text>|--description-file <path|->] [--priority <0-4>] [--estimate <n>] [--assignee <id>] [--label <id>] [--state <id>] [--cycle <id>] [--project <name|id>] [--project-milestone <id>|--milestone <id>] --json` — create an issue
- `linearctl issue update <identifier> [--title <text>] [--description <text>|--description-file <path|->] [--priority <0-4>] [--estimate <n>] [--assignee <id>] [--label <name|id>] [--state <id>] [--cycle <id>] [--project <name|id>] [--project-milestone <id>|--milestone <id>] --json` — update an issue
- `linearctl issue close <identifier> [--state <name>] --json` — close an issue (transitions to a terminal completed/canceled workflow state; defaults to "Done", use --state to pick another)
- `linearctl issue delete <identifier> --json` — delete/trash an issue by identifier or UUID
- `linearctl issue assign <identifier> <assignee-id> --json` — assign an issue
- `linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>] --json` — link a Slack thread to an issue (--sync enables bidirectional comment sync)
- `linearctl issue comment <identifier> --body <text> --json` — add a comment to an issue

### Bulk operations
- `linearctl issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] [--priority <0-4>] [--estimate <n>] [--label <id>] [--cycle <id>] [--project-milestone <id>|--milestone <id>] --json`
- `linearctl issue bulk-close --ids <id1,id2,...> [--state <name|id>] --json` — transition issues to a completed/canceled workflow state, matching `issue close`
- `linearctl issue bulk-archive --ids <id1,id2,...> --json` — archive multiple issues
- `linearctl issue bulk-delete --ids <id1,id2,...> --yes|--confirm --json` — delete/trash multiple issues; `--confirm` is accepted as an alias for `--yes`
- `linearctl issue bulk-assign --ids <id1,id2,...> --assignee <id> --json`

### Projects
- `linearctl project get <name|id> --json` — richer single-project detail payload than `project list` (includes progress/health/currentProgress, and milestones with id, name, description, targetDate, sortOrder, createdAt, updatedAt); project names resolve by exact match, unique prefix, or unique substring
- `linearctl project list [--query <text>|--search <text>|--name <text>] [--team <id>] [--state <status-type> ...] [--all-teams] --json` — includes portfolio fields (`progress`, `health`, `description`, `updatedAt`, `currentProgress`), normalized `milestones` with `name`, `targetDate`, `progress`, and `status`, and milestone truncation metadata (`milestonesPageInfo`, `milestonesTruncated`) in JSON output; human output shows progress, health, description, updated time, and milestone summaries; `--state` values: backlog, planned, started, paused, completed, canceled; repeated `--state` values are unioned; text flags filter project names
- `linearctl project create --name <name> [--description <text>|--description-file <path|->] [--content <text>|--content-file <path|->] [--team <id>] [--lead <user-id|email|"me">] [--status <id|name|type>|--state <name|type>] [--start-date <YYYY-MM-DD>] [--target-date <YYYY-MM-DD>] --json`
- `linearctl project create-with-issues --name <name> --team <id> --issues-json <json> [--description <text>|--description-file <path|->] [--content <text>|--content-file <path|->] [--lead <user-id|email|"me">] [--status <id|name|type>|--state <name|type>] [--start-date <YYYY-MM-DD>] [--target-date <YYYY-MM-DD>] --json` — create a project then batch-create linked issues (reports partial success if issue creation fails after project was created)
- `linearctl project update <id> [--name <text>] [--description <text>|--description-file <path|->] [--content <text>|--content-file <path|->] [--status <id|name|type>|--state <name|type>] [--lead <user-id|email|"me">] [--start-date <YYYY-MM-DD>] [--target-date <YYYY-MM-DD>] --json` — `--status`/`--state` accepts status names, state types, or status IDs; `--state` remains an alias
- `linearctl project delete <id> --json`

### Project statuses
- `linearctl project-status list --json` — list workspace-level project statuses
- `linearctl project-status get <id> --json`
- `linearctl project-status create --name <name> --status-type <type> --color <hex> --json` (types: backlog, planned, started, paused, completed, canceled)
- `linearctl project-status delete <id> --json` — archives the status

### Cycles
- `linearctl cycle get <id> --json` — includes progress/scope fields (`progress`, derived `scopeCount`, `completedScopeCount`, `inProgressScopeCount`, `startedScopeCount`, issue counts, history arrays, and uncompleted issues captured on close)
- `linearctl cycle list [--team <id>] [--all-teams] --json`
- `linearctl cycle current [--team <id>] --json` — get the currently active cycle for a team; includes progress/scope fields
- `linearctl cycle create --team <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json`
- `linearctl cycle update <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json`
- `linearctl cycle archive <id> --json`
- `linearctl cycle delete <id> --json` — Linear does not hard-delete cycles; this archives the cycle and reports `requestedAction: "delete"` / `performedAction: "archive"` in JSON and dry-run output

### Teams
- `linearctl team get <id-or-key> [--set-default] --json` — fetch team; --set-default saves as profile default
- `linearctl team list --json`
- `linearctl team members <id-or-key> [--all] --json` — list team members with `id`, `name`, `displayName`, `email`, and `active`

### Users
- `linearctl user get <id> --json`
- `linearctl user me --json`
- `linearctl user list --json`

### Labels
- `linearctl label get <id> --json`
- `linearctl label list [--team <id>] [--all-teams] --json`
- `linearctl label create --name <name> [--description <text>] [--color <hex>] [--team <id>] --json`
- `linearctl label delete <id> --json`

### Comments
- `linearctl comment list --issue <id> --json`
- `linearctl comment create --issue <id> --body <text> --json`
- `linearctl comment update <id> --body <text> --json`
- `linearctl comment delete <id> --json`

### Attachments
- `linearctl attachment list --issue <id> --json`
- `linearctl attachment create --issue <id> --url <url> --title <title> --json`
- `linearctl attachment delete <id> --json`

### Files
- `linearctl file upload <path> [--issue <id>] --json`
- `linearctl file url <attachment-id> [--expires-in <seconds>] --json`
- `linearctl file download <url> [--output <path>] --json`
- Upload/download use manual redirect handling and reject redirects to a different host before reusing signed upload headers or Linear authorization.

### Workflow states
- `linearctl state list [--team <id>] [--all-teams] --json` — list issue workflow states for a team
- `linearctl state get <id> --json`
- `linearctl state create --name <name> --team <id> --state-type <type> --json` (types: backlog, unstarted, started, completed, canceled)

### Skills
- `linearctl skills install [--json]` — auto-detect agents and install skill files
- `linearctl skills list --json` — list available embedded skills

### Schema
- `linearctl schema version --json`
- `linearctl schema pull --json`
- `linearctl schema check --json`
- Normal commands run best-effort schema freshness checks after command output, skip help/dry-run paths, and warn on stderr when the effective schema metadata is stale. `schema pull` writes `schema.json` and `schema-meta.json`; commands prefer pulled metadata from the profile config directory when present. Configure `[schema] stale_after_days` and `auto_update = true` in the linear config to opt into automatic schema pulls (`schema.autoUpdate`).

### Auth
- `linearctl auth status --json`
- `linearctl auth login --profile <name> --api-key-env <ENV>`
- `linearctl auth login --profile <name> --oauth --oauth-client-id <id>`
- `linearctl auth logout --profile <name>`
- `linearctl auth switch <profile>`
- `linearctl auth whoami --json`
- OAuth refresh tolerates concurrent CLI invocations by re-reading credentials after `invalid_grant`; token errors omit raw response bodies.

### Workspace
- `linearctl workspace list --json`

## Generated commands

When no curated command exists, use `linearctl api <resource> <operation>`:
- `linearctl --help` — grouped overview of curated resources
- `linearctl <resource> --help` — full usage lines for one curated resource
- `linearctl api search <term>` — discover available generated commands
- `linearctl api <resource> --help` — list operations for a resource
- `linearctl api <resource> <operation> --help` — show generated operation usage and input flags
- `linearctl api <resource> <operation> --id <id> --json` — execute a generated command
- `linearctl api <resource> <operation> --input-json '<json>' --json` — execute with JSON input

## Output modes

- Use `--json` when parsing output programmatically
- Use `--json-envelope` only when metadata (pagination, rate limits, complexity) is needed
- Parse-level validation errors also emit failure envelopes when `--json-envelope` is set
- Use `--jsonl --all` for streaming all list results, or `--jsonl --max <n>` to stream a bounded set; `--jsonl` no longer implies `--all`
- Do not parse human-readable default output
- Bulk operations fail non-zero when any item fails. With `--json-envelope`, partial failures return `ok: false`, populate `errors[]`, include per-item `data.succeeded`/`data.failed`, and set `meta.partial: true` when some items succeeded.
- GraphQL retry is default-on for rate limits (`--max-retries` defaults to 3); pass `--no-retry` to disable it.

## Default team

Each profile can have a default team. When set, list commands (issue, project, cycle, label) automatically filter to that team.

- Set it: `linearctl team get <key> --set-default`
- Override per-command: `--team <other>`
- Bypass and see all teams: `--all-teams`
- `--team` and `--all-teams` cannot be used together

## Name resolution

Curated commands resolve friendly names to IDs automatically:
- `--team "Infrastructure"` or `--team INF` resolves to the team's UUID
- `--assignee "me"` resolves to the current user's ID
- `--assignee "aborges"` resolves by Linear displayName
- `--assignee "quentin@example.com"` resolves by email
- `--state "In Progress"` resolves to the workflow state ID (team-scoped)
- `--label "bug"` resolves to the label ID (team-scoped when possible)
- `--project "Terraform Tech Debt"` resolves by exact project name, unique prefix, or unique substring

If a value looks like a UUID, it's passed through directly. On ambiguous matches, the CLI errors with candidates.

## Dry run

Use `--dry-run` on any mutating command to preview what would happen without executing:
- `linearctl issue create --title "test" --team INF --dry-run --json`
- `linearctl issue bulk-close --ids "id1,id2" --dry-run --json`
- Works on create, update, close, assign, comment, delete, and upload operations

## Pagination

- Default list behavior returns the first page only (up to 50 items)
- **When results are truncated, a warning is emitted to stderr** — check stderr to know if you have incomplete data
- Use `--all` to fetch all results (with `--max` or `--limit` to limit)
- Use `--max <n>` or `--limit <n>` to cap total results
- Use `--quiet` / `-q` to suppress the truncation warning (useful when piping JSON)
- Add filters before broad pagination whenever possible
- Prefer `--jsonl` for large result sets — it streams and auto-paginates

## Profile selection

1. If an explicit profile is specified, use `--profile <name>`
2. Otherwise rely on `LINEAR_PROFILE` env var
3. Otherwise run `linearctl auth status` to check the default profile
4. Do not silently choose among multiple profiles

## Error handling

| Exit code | Meaning | Action |
|---|---|---|
| 0 | Success | |
| 1 | General error | Read stderr for details |
| 2 | Auth error | Run `linearctl auth status`, re-authenticate if needed |
| 3 | Rate limit | Wait, reduce result count, add filters |
| 4 | Not found | Verify identifier/ID |
| 5 | Validation error | Check flags and input |
| 6 | Schema drift | Fall back to `linearctl gql`, update CLI |

## Anti-patterns

- Do not use `linearctl gql` when curated or generated commands cover the task
- Do not use `--all` without `--max` unless explicitly asked for everything
- Do not parse human-mode output programmatically
- Do not guess profile names
- Do not pass secrets as CLI arguments
- Do not retry immediately after rate-limit exhaustion
- Do not run destructive operations without explicit user confirmation
