# Filtering and pagination

## Pagination

By default, list commands return the first page only (up to 50 items). When results are truncated, a warning is emitted to stderr:

```text
Warning: results truncated at 50 items. Use --all to fetch all results, or --max <n> for a specific limit.
```

This prevents silently incomplete data. Always check stderr or use `--all`/`--max` when you need complete results.

### Flags

| Flag | Description |
|---|---|
| `--all` | Auto-paginate through all results |
| `--max <n>` | Cap total results (works with or without `--all`) |
| `--limit <n>` | Alias for `--max <n>` |
| `--page-size <n>` | Number of results per page (API request) |
| `--after <cursor>` | Resume from a pagination cursor |

### Examples

```bash
# First page (default)
linearctl issue list --team INF --json

# All issues, capped at 50
linearctl issue list --team INF --all --max 50 --json

# Stream all issues as JSONL
linearctl issue list --team INF --jsonl

# Resume from a cursor (from pageInfo in --json-envelope)
linearctl issue list --team INF --after "abc123" --json
```

### Best practices

- Always add filters before broad pagination. Fetching all issues in a workspace without filters is expensive and slow.
- Use `--max` to set an upper bound. The default soft cap is 200 for large enumerations.
- Do not use `--all` without `--max` unless you explicitly need everything.
- Prefer `--jsonl` for large result sets -- it streams results as they arrive.

## Filtering

Issue list supports these filter flags:

| Flag | Description | Accepts |
|---|---|---|
| `--team <value>` | Filter by team | Name, key (e.g. `INF`), or UUID |
| `--state <value>` | Filter by workflow state; repeat for a union filter | Name (e.g. `"In Progress"`) or UUID |
| `--status <value>` | Alias for `--state <value>` | Name (e.g. `"Backlog"`) or UUID |
| `--search <text>` / `--query <text>` | Full-text issue search | Search text |
| `--assignee <value>` | Filter by assignee | `"me"`, name, displayName, email, or UUID |
| `--label <value>` | Filter by label | Name or UUID |
| `--priority <n>` | Filter by priority | Integer 0-4 (0 = no priority, 1 = urgent, 4 = low) |
| `--cycle <value>` | Filter by cycle | UUID |
| `--project <value>` | Filter by project | project name or UUID |
| `--created-after <date>` | Issues created on or after date | ISO 8601 date (e.g. `2024-01-01`) |
| `--updated-after <date>` | Issues updated on or after date | ISO 8601 date |
| `--completed-after <date>` | Issues completed on or after date | ISO 8601 date |
| `--filter-json <json>` | Full Linear filter object | JSON string |
| `--order-by <field>` | Order results | Field name (e.g. `createdAt`, `updatedAt`) |

### Examples

```bash
# Issues assigned to me in a specific state
linearctl issue list --assignee me --state "In Progress" --json

# Issues in either of two states
linearctl issue list --state "In Progress" --state "Block/Waiting" --json

# High-priority issues on a team
linearctl issue list --team INF --priority 1 --json

# Issues with a specific label
linearctl issue list --team INF --label "bug" --json

# Issues completed in the last 30 days
linearctl issue list --team INF --completed-after 2024-03-01 --all --json

# Issues created this week
linearctl issue list --team INF --created-after 2024-03-25 --json

# Complex filter using JSON
linearctl issue list --filter-json '{"state":{"name":{"in":["Todo","In Progress"]}},"priority":{"lte":2}}' --json
```

### Filter precedence

When `--filter-json` is provided, it is used directly. Individual filter flags (`--team`, `--state`, etc.) are ignored. When `--filter-json` is not provided, individual flags are combined into a filter object.

Project list supports:

| Flag | Description | Accepts |
|---|---|---|
| `--team <value>` | Filter by team | Name, key (e.g. `INF`), or UUID |
| `--state <value>` | Filter by project status type; repeat for a union filter | `backlog`, `planned`, `started`, `paused`, `completed`, `canceled` |
| `--query <text>` / `--search <text>` / `--name <text>` | Filter by project name text | Search text |
| `--all-teams` | Disable default-team team filtering | boolean |

## Name resolution

Curated commands automatically resolve friendly names to Linear UUIDs:

| Input | Resolution |
|---|---|
| `--team "Infrastructure"` | Resolved by team name |
| `--team INF` | Resolved by team key |
| `--assignee "me"` | Resolved to the current user's ID |
| `--assignee "alice"` | Resolved by Linear displayName |
| `--assignee "alice@example.com"` | Resolved by email |
| `--state "In Progress"` | Resolved to the workflow state ID (team-scoped) |
| `--label "bug"` | Resolved to the label ID (team-scoped when possible) |
| `--project "Terraform Tech Debt"` | Resolved by exact name, unique prefix, or unique substring |

If a value looks like a UUID, it is passed through directly. On ambiguous matches, the CLI errors and lists candidates.

Name resolution works on: issue create, issue update, issue assign, issue list, project get, project create, cycle create, cycle list, label create, label list.
