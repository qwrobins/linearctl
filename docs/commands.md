# Command reference

All commands support `--json` for machine-readable output and `--json-envelope` for metadata-enriched output. Mutating commands support `--dry-run` to preview without executing.

Global flags: `--profile <name>`, `--no-retry`, `--max-retries <n>`.

## Issue

```bash
# Get a single issue by identifier or UUID
linearctl issue get <identifier> --json

# List issues with filters
linearctl issue list [--team <name|key|id>] [--state <name|id> ...] [--assignee <name|displayName|email|"me"|id>] \
  [--label <name|id>] [--priority <0-4>] [--cycle <id>] [--project <name|id>] \
  [--created-after <date>] [--updated-after <date>] [--completed-after <date>] \
  [--all-teams] [--filter-json <json>] [--order-by <field>] \
  [--all] [--max <n>] [--page-size <n>] [--after <cursor>] --json

# Search issues by text
linearctl issue search --query <text> [--all] --json

# Create an issue
linearctl issue create --title <title> --team <name|key|id> \
  [--description <text>] [--priority <0-4>] [--estimate <n>] [--assignee <email|"me"|id>] \
  [--label <name|id>] [--state <name|id>] [--cycle <id>] [--project <name|id>] \
  [--project-milestone <id>|--milestone <id>] \
  [--parent <identifier>] --json

# Update an issue
linearctl issue update <identifier> [--title <text>] [--description <text>] \
  [--priority <0-4>] [--estimate <n>] [--assignee <email|"me"|id>] [--label <name|id>] \
  [--state <name|id>] [--cycle <id>] [--project <id>] [--parent <identifier>] --json

# Close an issue (transitions to completed state, defaults to "Done")
linearctl issue close <identifier> [--state <name>] --json

# Assign an issue
linearctl issue assign <identifier> <assignee> --json

# Link a Slack thread to an issue
linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>] --json

# Add a comment
linearctl issue comment <identifier> --body <text> --json
```

### Bulk operations

```bash
# Bulk update fields on multiple issues
linearctl issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] \
  [--priority <0-4>] [--estimate <n>] [--label <id>] [--cycle <id>] --json

# Bulk close multiple issues
linearctl issue bulk-close --ids <id1,id2,...> --json

# Bulk assign multiple issues
linearctl issue bulk-assign --ids <id1,id2,...> --assignee <id> --json
```

Bulk operations report partial success. Check the response for per-item results.

## Project

```bash
linearctl project get <name|id> --json             # supports exact, unique prefix, or unique substring names
linearctl project list [--team <name|key|id>] [--state <status-type> ...] [--all-teams] --json
linearctl project create --name <name> [--description <text>] [--team <name|key|id>] --json
linearctl project create-with-issues --name <name> --team <name|key|id> \
  --issues-json '[{"title":"...","teamId":"..."}]' [--description <text>] --json
linearctl project update <id> [--name <text>] [--description <text>] \
  [--status <id|name|type>|--state <name|type>] [--lead <user-id|email|"me">] \
  [--start-date <YYYY-MM-DD>] [--target-date <YYYY-MM-DD>] --json
linearctl project delete <id> --json              # [destructive]
```

`project list --json` includes portfolio fields such as `progress`, `health`, `description`, `updatedAt`, `currentProgress`, a normalized `milestones` array with `name`, `targetDate`, `progress`, and `status`, and milestone pagination metadata (`milestonesPageInfo`, `milestonesTruncated`) so clients can detect truncation. Human output also shows progress, health, description, updated time, and milestone summaries.

For `project update`, `--status` accepts a status name, status type, or status ID. `--state` remains supported as an alias for compatibility.

For `project list`, `--state` accepts project status types: `backlog`, `planned`, `started`, `paused`, `completed`, or `canceled`. Repeat `--state` to return projects matching any provided type.

For `project get`, name resolution accepts exact names, unique prefixes, or unique substrings. Ambiguous partial matches fail with candidate projects.

## Cycle

```bash
linearctl cycle get <id> --json
linearctl cycle list [--team <name|key|id>] --json
linearctl cycle current [--team <name|key|id>] --json
linearctl cycle create --team <name|key|id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json
linearctl cycle update <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json
```

`cycle get` and `cycle current` JSON include sprint reporting fields such as `progress`, derived `scopeCount`, `completedScopeCount`, `inProgressScopeCount`, `startedScopeCount`, issue counts, history arrays, and uncompleted issues captured on close.

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
linearctl comment list --issue <id> --json
linearctl comment create --issue <id> --body <text> --json
linearctl comment update <id> --body <text> --json
linearctl comment delete <id> --json              # [destructive]
```

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

# Introspection
linearctl gql introspect --json
```

Output modes for `gql`: `--json`, `--json-envelope`, `--raw`.
