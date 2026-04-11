# linear-cli

Default skill for all Linear CLI usage. Use this skill for any request involving Linear data unless raw GraphQL is explicitly required or the curated/generated layers cannot cover the operation.

## Command routing

1. Use curated commands when they cover the operation.
2. Otherwise use generated `linear api` commands.
3. Otherwise use `linear gql`.

Raw GraphQL should not be used merely because it is possible. It is the fallback for gaps only.

## Available curated commands

### Issues
- `linear issue get <identifier> --json` — fetch a single issue by identifier (e.g. INF-2975) or UUID
- `linear issue list [--state <name>] [--assignee <id>] [--team <id>] [--label <id>] [--priority <0-4>] [--filter-json <json>] --json` — list issues with filters
- `linear issue create --title <title> --team <id> [--description <text>] [--priority <0-4>] [--assignee <id>] [--label <id>] [--state <id>] --json` — create an issue
- `linear issue update <identifier> [--title <text>] [--description <text>] [--priority <0-4>] [--assignee <id>] [--state <id>] --json` — update an issue
- `linear issue close <identifier> --json` — archive an issue
- `linear issue assign <identifier> <assignee-id> --json` — assign an issue
- `linear issue comment <identifier> --body <text> --json` — add a comment to an issue

### Projects
- `linear project get <id> --json`
- `linear project list --json`
- `linear project create --name <name> [--description <text>] [--team <id>] --json`
- `linear project update <id> [--name <text>] [--description <text>] [--state <state>] --json`

### Cycles
- `linear cycle get <id> --json`
- `linear cycle list [--team <id>] --json`
- `linear cycle create --team <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json`
- `linear cycle update <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json`

### Teams
- `linear team get <id-or-key> --json`
- `linear team list --json`

### Users
- `linear user get <id> --json`
- `linear user me --json`
- `linear user list --json`

### Labels
- `linear label get <id> --json`
- `linear label list [--team <id>] --json`
- `linear label create --name <name> [--description <text>] [--color <hex>] [--team <id>] --json`

### Comments
- `linear comment list --issue <id> --json`
- `linear comment create --issue <id> --body <text> --json`
- `linear comment update <id> --body <text> --json`
- `linear comment delete <id> --json`

### Attachments
- `linear attachment list --issue <id> --json`
- `linear attachment create --issue <id> --url <url> --title <title> --json`
- `linear attachment delete <id> --json`

### Files
- `linear file upload <path> [--issue <id>] --json`
- `linear file url <attachment-id> [--expires-in <seconds>] --json`
- `linear file download <url> [--output <path>] --json`

### Schema
- `linear schema version --json`
- `linear schema pull --json`
- `linear schema check --json`

### Auth
- `linear auth status --json`
- `linear auth login --profile <name> --api-key-env <ENV>`
- `linear auth logout --profile <name>`
- `linear auth switch <profile>`

## Generated commands

When no curated command exists, use `linear api <resource> <operation>`:
- `linear api search <term>` — discover available generated commands
- `linear api <resource> --help` — list operations for a resource
- `linear api <resource> <operation> --id <id> --json` — execute a generated command
- `linear api <resource> <operation> --input-json '<json>' --json` — execute with JSON input

## Output modes

- Use `--json` when parsing output programmatically
- Use `--json-envelope` only when metadata (pagination, rate limits, complexity) is needed
- Do not parse human-readable default output

## Pagination

- Default list behavior is bounded (first page only)
- Use `--max <n>` to cap results
- Use `--all` for full autopagination (with `--max` to limit)
- Add filters before broad pagination whenever possible
- Treat 200 as the default soft cap for large enumerations

## Profile selection

1. If an explicit profile is specified, use `--profile <name>`
2. Otherwise rely on `LINEAR_PROFILE` env var
3. Otherwise run `linear auth status` to check the default profile
4. Do not silently choose among multiple profiles

## Error handling

| Exit code | Meaning | Action |
|---|---|---|
| 0 | Success | |
| 1 | General error | Read stderr for details |
| 2 | Auth error | Run `linear auth status`, re-authenticate if needed |
| 3 | Rate limit | Wait, reduce result count, add filters |
| 4 | Not found | Verify identifier/ID |
| 5 | Validation error | Check flags and input |
| 6 | Schema drift | Fall back to `linear gql`, update CLI |

## Anti-patterns

- Do not use `linear gql` when curated or generated commands cover the task
- Do not use `--all` without `--max` unless explicitly asked for everything
- Do not parse human-mode output programmatically
- Do not guess profile names
- Do not pass secrets as CLI arguments
- Do not retry immediately after rate-limit exhaustion
- Do not run destructive operations without explicit user confirmation
