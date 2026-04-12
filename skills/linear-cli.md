# linear-agent-cli

Default skill for all Linear CLI usage. Use this skill for any request involving Linear data unless raw GraphQL is explicitly required or the curated/generated layers cannot cover the operation.

## First-time setup

If the user has not configured the CLI yet, help them bootstrap:

1. Create the config directory: `mkdir -p ~/.config/linear`
2. Create a credentials file with their API key:
   ```bash
   export LINEAR_API_KEY=lin_api_...
   linear-agent auth login --profile <name> --api-key-env LINEAR_API_KEY --set-default
   ```
3. Set a default team: `linear-agent team list --json` to find team keys, then `linear-agent team get <key> --set-default`
4. Verify: `linear-agent auth whoami --json`

API keys are created at https://linear.app/settings/api. For OAuth, see https://linear.app/settings/api/applications.

## Command routing

1. Use curated commands when they cover the operation.
2. Otherwise use generated `linear-agent api` commands.
3. Otherwise use `linear-agent gql`.

Raw GraphQL should not be used merely because it is possible. It is the fallback for gaps only.

## Available curated commands

### Issues
- `linear-agent issue get <identifier> --json` — fetch a single issue by identifier (e.g. INF-2975) or UUID
- `linear-agent issue list [--state <name>] [--assignee <id>] [--team <id>] [--everything] [--json]` — list issues with filters
- `linear-agent issue create --title <title> --team <id> [--description <text>] [--priority <0-4>] [--assignee <id>] [--label <id>] [--state <id>] --json` — create an issue
- `linear-agent issue update <identifier> [--title <text>] [--description <text>] [--priority <0-4>] [--assignee <id>] [--state <id>] --json` — update an issue
- `linear-agent issue close <identifier> --json` — archive an issue
- `linear-agent issue assign <identifier> <assignee-id> --json` — assign an issue
- `linear-agent issue comment <identifier> --body <text> --json` — add a comment to an issue

### Bulk operations
- `linear-agent issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] [--priority <0-4>] [--label <id>] --json`
- `linear-agent issue bulk-close --ids <id1,id2,...> --json`
- `linear-agent issue bulk-assign --ids <id1,id2,...> --assignee <id> --json`

### Projects
- `linear-agent project get <id> --json`
- `linear-agent project list [--team <id>] [--everything] --json`
- `linear-agent project create --name <name> [--description <text>] [--team <id>] --json`
- `linear-agent project update <id> [--name <text>] [--description <text>] [--state <state>] --json`
- `linear-agent project delete <id> --json`

### Project statuses
- `linear-agent project-status list --json` — list workspace-level project statuses
- `linear-agent project-status get <id> --json`
- `linear-agent project-status create --name <name> --status-type <type> --color <hex> --json` (types: backlog, planned, started, paused, completed, canceled)
- `linear-agent project-status delete <id> --json` — archives the status

### Cycles
- `linear-agent cycle get <id> --json`
- `linear-agent cycle list [--team <id>] [--everything] --json`
- `linear-agent cycle create --team <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json`
- `linear-agent cycle update <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json`

### Teams
- `linear-agent team get <id-or-key> [--set-default] --json` — fetch team; --set-default saves as profile default
- `linear-agent team list --json`

### Users
- `linear-agent user get <id> --json`
- `linear-agent user me --json`
- `linear-agent user list --json`

### Labels
- `linear-agent label get <id> --json`
- `linear-agent label list [--team <id>] [--everything] --json`
- `linear-agent label create --name <name> [--description <text>] [--color <hex>] [--team <id>] --json`
- `linear-agent label delete <id> --json`

### Comments
- `linear-agent comment list --issue <id> --json`
- `linear-agent comment create --issue <id> --body <text> --json`
- `linear-agent comment update <id> --body <text> --json`
- `linear-agent comment delete <id> --json`

### Attachments
- `linear-agent attachment list --issue <id> --json`
- `linear-agent attachment create --issue <id> --url <url> --title <title> --json`
- `linear-agent attachment delete <id> --json`

### Files
- `linear-agent file upload <path> [--issue <id>] --json`
- `linear-agent file url <attachment-id> [--expires-in <seconds>] --json`
- `linear-agent file download <url> [--output <path>] --json`

### Workflow states
- `linear-agent state list [--team <id>] [--everything] --json` — list issue workflow states for a team
- `linear-agent state get <id> --json`
- `linear-agent state create --name <name> --team <id> --state-type <type> --json` (types: backlog, unstarted, started, completed, canceled)

### Skills
- `linear-agent skills install [--location project|user] --json` — write embedded skill files to disk
- `linear-agent skills list --json` — list available embedded skills

### Schema
- `linear-agent schema version --json`
- `linear-agent schema pull --json`
- `linear-agent schema check --json`

### Auth
- `linear-agent auth status --json`
- `linear-agent auth login --profile <name> --api-key-env <ENV>`
- `linear-agent auth login --profile <name> --oauth --oauth-client-id <id>`
- `linear-agent auth logout --profile <name>`
- `linear-agent auth switch <profile>`
- `linear-agent auth whoami --json`

### Workspace
- `linear-agent workspace list --json`

## Generated commands

When no curated command exists, use `linear-agent api <resource> <operation>`:
- `linear-agent api search <term>` — discover available generated commands
- `linear-agent api <resource> --help` — list operations for a resource
- `linear-agent api <resource> <operation> --id <id> --json` — execute a generated command
- `linear-agent api <resource> <operation> --input-json '<json>' --json` — execute with JSON input

## Output modes

- Use `--json` when parsing output programmatically
- Use `--json-envelope` only when metadata (pagination, rate limits, complexity) is needed
- Use `--jsonl` for streaming large list results (one JSON object per line, auto-paginates)
- Do not parse human-readable default output

## Default team

Each profile can have a default team. When set, list commands (issue, project, cycle, label) automatically filter to that team.

- Set it: `linear-agent team get <key> --set-default`
- Override per-command: `--team <other>`
- Bypass and see everything: `--everything`
- `--team` and `--everything` cannot be used together

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
- `linear-agent issue create --title "test" --team INF --dry-run --json`
- `linear-agent issue bulk-close --ids "id1,id2" --dry-run --json`
- Works on create, update, close, assign, comment, delete, and upload operations

## Pagination

- Default list behavior is bounded (first page only)
- Use `--max <n>` to cap results
- Use `--all` for full autopagination (with `--max` to limit)
- Add filters before broad pagination whenever possible
- Treat 200 as the default soft cap for large enumerations

## Profile selection

1. If an explicit profile is specified, use `--profile <name>`
2. Otherwise rely on `LINEAR_PROFILE` env var
3. Otherwise run `linear-agent auth status` to check the default profile
4. Do not silently choose among multiple profiles

## Error handling

| Exit code | Meaning | Action |
|---|---|---|
| 0 | Success | |
| 1 | General error | Read stderr for details |
| 2 | Auth error | Run `linear-agent auth status`, re-authenticate if needed |
| 3 | Rate limit | Wait, reduce result count, add filters |
| 4 | Not found | Verify identifier/ID |
| 5 | Validation error | Check flags and input |
| 6 | Schema drift | Fall back to `linear-agent gql`, update CLI |

## Anti-patterns

- Do not use `linear-agent gql` when curated or generated commands cover the task
- Do not use `--all` without `--max` unless explicitly asked for everything
- Do not parse human-mode output programmatically
- Do not guess profile names
- Do not pass secrets as CLI arguments
- Do not retry immediately after rate-limit exhaustion
- Do not run destructive operations without explicit user confirmation
