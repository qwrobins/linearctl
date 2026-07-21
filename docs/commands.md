# Command reference

All commands support `--json` for machine-readable output and `--json-envelope` for metadata-enriched output. Mutating commands support `--dry-run` to preview without executing; dry runs validate and resolve friendly names before emitting the preview payload.

Global flags: `--profile <name>`, `--no-retry`, `--max-retries <n>`.

## Issue

```bash
# Get a single issue by identifier or UUID
linearctl issue get <identifier> --json
linearctl issue view <identifier> --json

# List issues with filters
linearctl issue list [--search <text>|--query <text>] [--team <name|key|id>] [--state <name|id> ...] [--status <name|id>] [--assignee <name|displayName|email|"me"|id>] \
  [--label <name|id>] [--priority <0-4>] [--cycle <id>] [--project <name|id>] \
  [--created-after <date>] [--updated-after <date>] [--completed-after <date>] \
  [--all-teams] [--filter-json <json>] [--order-by <field>] \
  [--all] [--max <n>|--limit <n>] [--page-size <n>] [--after <cursor>] --json

# Search issues by text. Profile default teams are not applied; pass --team to scope explicitly.
linearctl issue search [<text>|--query <text>] [--team <name|key|id>] [--all] --json

# Create an issue
linearctl issue create --title <title> --team <name|key|id> \
  [--description <text>|--description-file <path|->] [--priority <0-4>] [--estimate <n>] [--assignee <email|"me"|id>] \
  [--label <name|id>] [--state <name|id>] [--cycle <id>] [--project <name|id>] \
  [--project-milestone <id>|--milestone <id>] \
  [--parent <identifier>] --json

# Update an issue
linearctl issue update <identifier> [--title <text>] [--description <text>|--description-file <path|->] \
  [--priority <0-4>] [--estimate <n>] [--assignee <email|"me"|id>] [--label <name|id>] \
  [--state <name|id>] [--cycle <id>] [--project <name|id>] \
  [--project-milestone <id>|--milestone <id>] [--parent <identifier>] --json

# Close an issue (transitions to a terminal completed/canceled state, defaults to "Done")
linearctl issue close <identifier> [--state <name>] --json

# Delete an issue
linearctl issue delete <identifier> --json

# Assign an issue
linearctl issue assign <identifier> <assignee> --json

# Link a Slack thread to an issue
linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>] --json

# Add a comment
linearctl issue comment <identifier> (--body <text>|--body-file <path|->) --json
```

`issue get` / `issue view` returns soft-deleted Linear issues when the API can still read them. JSON output includes `projectMilestone`, `trashed`, and `archivedAt`; human output prints `Trashed: true` and `Archived: <timestamp>` when applicable. A missing referenced issue returns exit 4 with `category: "not-found"` in `--json-envelope`.

### Bulk operations

```bash
# Bulk update fields on multiple issues
linearctl issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] \
  [--priority <0-4>] [--estimate <n>] [--label <id>] [--cycle <id>] \
  [--project-milestone <id>|--milestone <id>] --json

# Bulk close multiple issues by transitioning them to a completed workflow state
linearctl issue bulk-close --ids <id1,id2,...> [--state <name|id>] --json

# Bulk archive multiple issues
linearctl issue bulk-archive --ids <id1,id2,...> --json

# Bulk delete multiple issues
linearctl issue bulk-delete --ids <id1,id2,...> --yes|--confirm --json

# Bulk assign multiple issues
linearctl issue bulk-assign --ids <id1,id2,...> --assignee <id> --json
```

Bulk operations fail the command when any item fails. With `--json-envelope`, partial failures return `ok: false`, populate `errors[]`, include per-item `data.succeeded` and `data.failed`, and set `meta.partial: true` when at least one item succeeded. Per-item failures preserve mapped error categories, and the overall exit code is selected by highest-priority category: auth, rate-limit, not-found, then general.

Friendly names for teams, users, labels, workflow states, and projects resolve case-insensitively. When multiple case-insensitive matches exist, exact case-sensitive matches win before ambiguity is reported; user email matches outrank name/displayName matches, and team-scoped labels outrank same-named workspace labels under `--team`. When `issue list --state <name>` has a team scope from `--team` or the profile default team, it resolves the state name to an ID before filtering; without a team scope, it falls back to a case-insensitive state-name filter.

## Relation

```bash
linearctl relation list <issue> [--all] [--max <n>] --json
linearctl relation create --issue <issue> --related <issue> \
  --type <blocks|duplicate|related|similar> --json
linearctl relation delete <relation-id> --json       # [destructive]
```

`relation list` resolves a human-readable issue identifier or UUID and returns both outbound and inbound relations. Each result preserves the API's `issue` and `relatedIssue` endpoints and adds `direction` relative to the issue being listed.

For `duplicate`, `--issue` is the duplicate and `--related` is the canonical issue. For `blocks`, `--issue` blocks `--related`. `related-to` and `relatedTo` are accepted as aliases for the API's `related` type. Creation resolves both issue identifiers before mutation and supports `--dry-run`.

## Project

```bash
linearctl project get <name|id> --json             # supports exact, unique prefix, or unique substring names
linearctl project list [--query <text>|--search <text>|--name <text>] [--team <name|key|id>] [--state <status-type> ...] [--all-teams] --json
linearctl project create --name <name> [--description <text>|--description-file <path|->] \
  [--content <text>|--content-file <path|->] [--team <name|key|id>] [--lead <user-id|email|"me">] \
  [--status <id|name|type>|--state <name|type>] [--start-date <YYYY-MM-DD>] [--target-date <YYYY-MM-DD>] --json
linearctl project create-with-issues --name <name> --team <name|key|id> \
  --issues-json '[{"title":"...","teamId":"..."}]' [--description <text>|--description-file <path|->] \
  [--content <text>|--content-file <path|->] [--lead <user-id|email|"me">] \
  [--status <id|name|type>|--state <name|type>] [--start-date <YYYY-MM-DD>] [--target-date <YYYY-MM-DD>] --json
linearctl project update <id> [--name <text>] [--description <text>|--description-file <path|->] \
  [--content <text>|--content-file <path|->] \
  [--status <id|name|type>|--state <name|type>] [--lead <user-id|email|"me">] \
  [--start-date <YYYY-MM-DD>] [--target-date <YYYY-MM-DD>] --json
linearctl project delete <id> --json              # [destructive]
```

`project list --json` includes portfolio fields such as `progress`, `health`, `description`, `updatedAt`, `currentProgress`, a normalized `milestones` array with `name`, `targetDate`, `progress`, and `status`, and milestone pagination metadata (`milestonesPageInfo`, `milestonesTruncated`) so clients can detect truncation. Human output also shows progress, health, description, updated time, and milestone summaries.

For `project create`, `project create-with-issues`, and `project update`, `--status` accepts a status name, status type, or status ID. `--state` remains supported as an alias for compatibility.

For issue and project create/update descriptions, use `--description-file <path>` to read markdown from a file, or `--description-file -` to read from stdin explicitly. `--description` and `--description-file` are mutually exclusive. For long-form project bodies, use `--content` or `--content-file` the same way.

For `project list`, `--state` accepts project status types: `backlog`, `planned`, `started`, `paused`, `completed`, or `canceled`. Repeat `--state` to return projects matching any provided type. Use `--query`, `--search`, or `--name` to filter by project name.

For `project get`, name resolution accepts exact names, unique prefixes, or unique substrings. Ambiguous partial matches fail with candidate projects.

## Cycle

```bash
linearctl cycle get <id> --json
linearctl cycle list [--team <name|key|id>] --json
linearctl cycle current [--team <name|key|id>] --json
linearctl cycle create --team <name|key|id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json
linearctl cycle update <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json
linearctl cycle archive <id> --json
linearctl cycle delete <id> --json
```

`cycle get` and `cycle current` JSON include sprint reporting fields such as `progress`, derived `scopeCount`, `completedScopeCount`, `inProgressScopeCount`, `startedScopeCount`, issue counts, history arrays, and uncompleted issues captured on close.

Linear does not expose hard deletion for cycles. `cycle delete` is an alias for archive and reports `requestedAction: "delete"` with `performedAction: "archive"` in JSON and dry-run output.

## Team

```bash
linearctl team get <id-or-key> --json
linearctl team list --json
linearctl team members <id-or-key> [--all] --json
```

`team members` includes `id`, `name`, `displayName`, `email`, and `active`.

## User

```bash
linearctl user get <id> --json
linearctl user me --json
linearctl user list --json
```

## Label

```bash
linearctl label get <id> --json
linearctl label list [--team <name|key|id>] --json
linearctl label create --name <name> [--description <text>] [--color <hex>] [--team <name|key|id>] --json
linearctl label delete <id> --json                # [destructive]
```

## Workflow state

```bash
linearctl state get <id> --json
linearctl state list [--team <name|key|id>] [--all-teams] --json
linearctl state create --name <name> --team <name|key|id> --state-type <type> \
  [--description <text>] [--color <hex>] [--position <n>] --json
linearctl state archive <id|name> [--team <name|key|id>] --json
linearctl state delete <id|name> [--team <name|key|id>] --json     # [destructive]
```

`--state-type` must be one of: `backlog`, `unstarted`, `started`, `completed`, `canceled`.

## Project status

Project statuses are workspace-level (not team-scoped) and represent customizable statuses for projects.

```bash
linearctl project-status list [--json]
linearctl project-status get <id> [--json]
linearctl project-status create --name <name> --status-type <type> \
  [--description <text>] [--color <hex>] [--position <n>] [--json]
linearctl project-status delete <id> [--json]          # [destructive]
```

`--status-type` must be one of: `backlog`, `planned`, `started`, `paused`, `completed`, `canceled`.

## Comment

```bash
linearctl comment list <issue> --json
linearctl comment list --issue <id> --json
linearctl comment create --issue <id> (--body <text>|--body-file <path|->) --json
linearctl comment update <id> (--body <text>|--body-file <path|->) --json
linearctl comment delete <id> --json              # [destructive]
```

The positional issue argument and `--issue` are equivalent. When either is a human-readable issue identifier such as `INF-123`, `comment list` first verifies that the parent issue exists and returns exit 4 / `category: "not-found"` if it does not. Comments are read from the issue's own comments connection.

## Attachment

```bash
linearctl attachment list --issue <id> --json
linearctl attachment create --issue <id> --url <url> --title <title> --json
linearctl attachment delete <id> --json            # [destructive]
```

## File

```bash
# Upload a file (optionally attach to an issue)
linearctl file upload <path> [--issue <id>] --json

# Get a signed URL for an attachment
linearctl file url <attachment-id> [--expires-in <seconds>] --json

# Download a file
linearctl file download <url> [--output <path>] --json
```

File upload and download requests use manual redirect handling. Same-host redirects keep signed upload headers and Linear authorization. Cross-host redirects are followed only after dropping those headers.

## Auth

```bash
# API key login
linearctl auth login --profile <name> --api-key-env <ENV_VAR> [--set-default]

# OAuth login
linearctl auth login --profile <name> --oauth --oauth-client-id <id> \
  [--callback-port <port>] [--no-browser] [--set-default]

# Stdin API key
linearctl auth login --profile <name> --api-key-stdin [--set-default]

# Show all profiles
linearctl auth status --json

# Show current user and workspace
linearctl auth whoami --json

# Switch default profile
linearctl auth switch <profile>

# Remove a profile [destructive with --remove-config]
linearctl auth logout --profile <name> [--remove-config]
```

OAuth token refresh re-reads credentials after an `invalid_grant` response so concurrent CLI invocations can tolerate one process refreshing the token before another finishes.

See [auth-and-profiles.md](auth-and-profiles.md) for details.

## Workspace

```bash
linearctl workspace list --json
```

## Schema

```bash
# Show bundled schema version
linearctl schema version --json

# Pull latest schema from Linear API
linearctl schema pull [--output-dir <path>] --json

# Check for schema drift between bundled and live
linearctl schema check --json
```

`schema pull` writes `schema.json` and `schema-meta.json`; normal commands and `schema version` prefer metadata from pulled files in the profile config directory when present. Best-effort freshness checks run after command completion, skip help and dry-run paths, cache successful or failed attempts for 24 hours, and time out quickly so they do not delay command output.

See [schema-and-generated.md](schema-and-generated.md) for details.

## Skills

```bash
# Install agent skills to project (.claude/skills/)
linearctl skills install [--json]

# List embedded skills
linearctl skills list [--json]
```

Auto-discovers installed agents (Claude Code, Codex) at project and user level and installs skills to all found directories.

## Generated API

The generated layer covers any Linear API resource not handled by curated commands.

For curated commands, use top-level help for a grouped overview and resource help
for the full usage lines:

```bash
linearctl --help
linearctl issue --help
linearctl project --help
```

```bash
# List all available resources
linearctl api --help

# List operations for a resource
linearctl api <resource> --help

# Show usage for one generated operation
linearctl api <resource> <operation> --help

# Search for commands
linearctl api search <term>

# Execute a generated command
linearctl api <resource> <operation> [--id <id>] [--input-json <json>] \
  [--input-file <path>] [--input-stdin] [--fields <f1,f2>] --json
```

See [schema-and-generated.md](schema-and-generated.md) for details.

## Raw GraphQL

Fallback for operations not covered by curated or generated commands.

```bash
# Inline query
linearctl gql query '{ viewer { id name } }' --json

# Query from file with variables
linearctl gql query --file query.graphql --var "teamId=abc123" --json

# Mutation from file with variable file
linearctl gql mutation --file mutation.graphql --vars-file vars.json --json

# Bare mutation selection set, wrapped automatically as a mutation
linearctl gql mutation '{ issueDelete(id: "issue-id") { success } }' --json

# Introspection
linearctl gql introspect --json
```

Output modes for `gql`: `--json`, `--json-envelope`, `--raw`.
