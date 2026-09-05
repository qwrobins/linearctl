# Filtering and pagination

## Pagination

By default, list commands return the first page only (up to 50 items). When results are truncated, a warning is emitted to stderr:

```text
Warning: results truncated at 50 items. Use --all to fetch all results, or --max <n> for a specific limit.
```

This prevents silently incomplete data. Always check stderr or use `--all`/`--max` when you need complete results.

`--max` and `--limit` share one bound: the last occurrence wins, including across leading and command-position options. For example, `--max 10 issue list --limit 20` uses a bound of 20.

`project list` requests 50 projects per page by default, including with `--all`, to stay under Linear's query-complexity limit while preserving milestone and team fields in JSON output. An explicit `--page-size <n>` still takes precedence.

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
linearctl issue list --team INF --all --jsonl

# Resume from a cursor (from pageInfo in --json-envelope)
linearctl issue list --team INF --after "abc123" --json
```

### Recovering from a failed page

Pagination failures preserve progress from completed pages, including HTTP errors, exhausted rate-limit retries, timeouts, network failures, and GraphQL errors. The error category and exit code are unchanged.

For buffered commands, use `--json-envelope` to retain fetched results on failure. The envelope has `ok: false` and `data: null`; recovery information is in `errors[0].details`:

- `partialItems`: raw connection nodes from completed pages (before command-specific normalization).
- `endCursor`: the cursor to pass to `--after`.
- `pageInfo`: the last completed page's pagination metadata.

For `--jsonl`, rows from completed pages are already on stdout and are not emitted again. Error details contain `totalItems` (the emitted count) instead of `partialItems`. Since `--jsonl` and `--json-envelope` are mutually exclusive, the CLI prints the count and resume cursor to stderr, keeping stdout limited to data rows.

Resume with the same command, filters, and ordering. Use `--after` with `--max` to continue across pages; `--all` and `--after` are mutually exclusive. The new `--max` applies only to the resumed request, so subtract the fetched/emitted count if maintaining an overall limit.

```bash
# Capture buffered results and recovery details even if a later page fails
linearctl issue list --team INF --max 1000 --json-envelope > result.json
# Read errors[0].details.endCursor, save partialItems, then continue
linearctl issue list --team INF --after "resume-here" --max 750 --json-envelope > resumed.json

# Keep streamed rows and diagnostics separate
linearctl issue list --team INF --max 1000 --jsonl > issues.jsonl 2> progress.log
# Use the checkpoint printed in progress.log; append only the remaining rows
linearctl issue list --team INF --after "resume-here" --max 750 --jsonl >> issues.jsonl 2>> progress.log
```

Data returned alongside GraphQL errors is not committed; resume retries that failed page. If the first page fails, the count is zero, `pageInfo` is the initial `{ "hasNextPage": false }` placeholder, and `endCursor` is the supplied `--after` cursor or `null`. With a null cursor, rerun without `--after`. Cursors are not snapshots: changes to the underlying result set between requests can still affect resumed results.

### Best practices

- Always add filters before broad pagination. Fetching all issues in a workspace without filters is expensive and slow.
- Use `--max` to set an upper bound. The default soft cap is 200 for large enumerations.
- Do not use `--all` without `--max` unless you explicitly need everything.
- Prefer `--jsonl --max <n>` for large bounded result sets, or `--jsonl --all` only when you intentionally want every result.

## Filtering

Issue list supports these filter flags:

| Flag | Description | Accepts |
|---|---|---|
| `--team <value>` | Filter by team | Name, key (e.g. `INF`), or UUID |
| `--state <value>` | Filter by workflow state; repeat or comma-separate values for a union filter | Name (e.g. `"In Progress"`) or UUID |
| `--status <value>` | Alias for `--state <value>` | Name (e.g. `"Backlog"`) or UUID |
| `--search <text>` / `--query <text>` | Full-text issue search | Search text |
| `--assignee <value>` | Filter by assignee | `"me"`, name, displayName, email, UUID, or `none`/`unassigned` |
| `--label <value>` | Filter by label | Name or UUID |
| `--priority <n>` | Filter by priority | Integer 0-4 (0 = no priority, 1 = urgent, 4 = low) |
| `--due-date <date>` | Filter by exact due date, or issues without one | `YYYY-MM-DD` or `none` |
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

# The same union using a comma-separated value, limited to unassigned work
linearctl issue list --state "In Progress,Block/Waiting" --assignee none --json

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
| `--assignee none` / `unassigned` | Matches issues whose assignee relation is null |
| `--state "In Progress"` | Resolved to the workflow state ID (team-scoped) |
| `--label "bug"` | Resolved to the label ID (team-scoped when possible) |
| `--project "Terraform Tech Debt"` | Resolved by exact name, unique prefix, or unique substring |

If a value looks like a UUID, it is passed through directly. On ambiguous matches, the CLI errors and lists candidates.

Name resolution works on: issue create, issue update, issue assign, issue list, project get, project create, cycle create, cycle list, label create, label list.
