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
- `linearctl issue get <identifier> --json` — fetch a single issue by identifier (e.g. INF-2975) or UUID
- `linearctl issue list [--state <name>] [--assignee <id>] [--team <id>] [--label <name|id>] [--priority <0-4>] [--cycle <id>] [--project <id>] [--created-after <date>] [--updated-after <date>] [--completed-after <date>] [--order-by <field>] [--all-teams] [--all] [--json]` — list issues with filters
- `linearctl issue search --query <text> [--all] --json` — full-text search across issues
- `linearctl issue create --title <title> --team <id> [--description <text>] [--priority <0-4>] [--estimate <n>] [--assignee <id>] [--label <id>] [--state <id>] [--cycle <id>] [--project <id>] --json` — create an issue
- `linearctl issue update <identifier> [--title <text>] [--description <text>] [--priority <0-4>] [--estimate <n>] [--assignee <id>] [--state <id>] --json` — update an issue
- `linearctl issue close <identifier> [--state <name>] --json` — close an issue (transitions to completed workflow state; defaults to "Done", use --state to pick another)
- `linearctl issue assign <identifier> <assignee-id> --json` — assign an issue
- `linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>] --json` — link a Slack thread to an issue (--sync enables bidirectional comment sync)
- `linearctl issue comment <identifier> --body <text> --json` — add a comment to an issue

### Bulk operations
- `linearctl issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] [--priority <0-4>] [--estimate <n>] [--label <id>] [--cycle <id>] --json`
- `linearctl issue bulk-close --ids <id1,id2,...> --json`
- `linearctl issue bulk-assign --ids <id1,id2,...> --assignee <id> --json`

### Projects
- `linearctl project get <id> --json`
- `linearctl project list [--team <id>] [--state <name>] [--all-teams] --json`
- `linearctl project create --name <name> [--description <text>] [--team <id>] --json`
- `linearctl project create-with-issues --name <name> --team <id> --issues-json <json> [--description <text>] --json` — create a project and batch-create linked issues atomically
- `linearctl project update <id> [--name <text>] [--description <text>] [--state <state>] --json`
- `linearctl project delete <id> --json`

### Project statuses
- `linearctl project-status list --json` — list workspace-level project statuses
- `linearctl project-status get <id> --json`
- `linearctl project-status create --name <name> --status-type <type> --color <hex> --json` (types: backlog, planned, started, paused, completed, canceled)
- `linearctl project-status delete <id> --json` — archives the status

### Cycles
- `linearctl cycle get <id> --json`
- `linearctl cycle list [--team <id>] [--all-teams] --json`
- `linearctl cycle current [--team <id>] --json` — get the currently active cycle for a team
- `linearctl cycle create --team <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json`
- `linearctl cycle update <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json`

### Teams
- `linearctl team get <id-or-key> [--set-default] --json` — fetch team; --set-default saves as profile default
- `linearctl team list --json`

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

### Auth
- `linearctl auth status --json`
- `linearctl auth login --profile <name> --api-key-env <ENV>`
- `linearctl auth login --profile <name> --oauth --oauth-client-id <id>`
- `linearctl auth logout --profile <name>`
- `linearctl auth switch <profile>`
- `linearctl auth whoami --json`

### Workspace
- `linearctl workspace list --json`

## Generated commands

When no curated command exists, use `linearctl api <resource> <operation>`:
- `linearctl api search <term>` — discover available generated commands
- `linearctl api <resource> --help` — list operations for a resource
- `linearctl api <resource> <operation> --id <id> --json` — execute a generated command
- `linearctl api <resource> <operation> --input-json '<json>' --json` — execute with JSON input

## Output modes

- Use `--json` when parsing output programmatically
- Use `--json-envelope` only when metadata (pagination, rate limits, complexity) is needed
- Use `--jsonl` for streaming large list results (one JSON object per line, auto-paginates)
- Do not parse human-readable default output

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
- `--assignee "quentin@example.com"` resolves by email
- `--state "In Progress"` resolves to the workflow state ID (team-scoped)
- `--label "bug"` resolves to the label ID (team-scoped when possible)

If a value looks like a UUID, it's passed through directly. On ambiguous matches, the CLI errors with candidates.

## Dry run

Use `--dry-run` on any mutating command to preview what would happen without executing:
- `linearctl issue create --title "test" --team INF --dry-run --json`
- `linearctl issue bulk-close --ids "id1,id2" --dry-run --json`
- Works on create, update, close, assign, comment, delete, and upload operations

## Pagination

- Default list behavior returns the first page only (up to 50 items)
- **When results are truncated, a warning is emitted to stderr** — check stderr to know if you have incomplete data
- Use `--all` to fetch all results (with `--max` to limit)
- Use `--max <n>` to cap total results
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
