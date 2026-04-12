# Command reference

All commands support `--json` for machine-readable output and `--json-envelope` for metadata-enriched output. Mutating commands support `--dry-run` to preview without executing.

Global flags: `--profile <name>`, `--no-retry`, `--max-retries <n>`.

## Issue

```bash
# Get a single issue by identifier or UUID
linear-agent issue get <identifier> --json

# List issues with filters
linear-agent issue list [--team <name|key|id>] [--state <name|id>] [--assignee <email|"me"|id>] \
  [--label <name|id>] [--priority <0-4>] [--filter-json <json>] [--order-by <field>] \
  [--all] [--max <n>] [--page-size <n>] [--after <cursor>] --json

# Create an issue
linear-agent issue create --title <title> --team <name|key|id> \
  [--description <text>] [--priority <0-4>] [--assignee <email|"me"|id>] \
  [--label <name|id>] [--state <name|id>] --json

# Update an issue
linear-agent issue update <identifier> [--title <text>] [--description <text>] \
  [--priority <0-4>] [--assignee <email|"me"|id>] [--state <name|id>] --json

# Close (archive) an issue [destructive]
linear-agent issue close <identifier> --json

# Assign an issue
linear-agent issue assign <identifier> <assignee> --json

# Add a comment
linear-agent issue comment <identifier> --body <text> --json
```

### Bulk operations

```bash
# Bulk update fields on multiple issues
linear-agent issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] \
  [--priority <0-4>] [--label <id>] --json

# Bulk close multiple issues
linear-agent issue bulk-close --ids <id1,id2,...> --json

# Bulk assign multiple issues
linear-agent issue bulk-assign --ids <id1,id2,...> --assignee <id> --json
```

Bulk operations report partial success. Check the response for per-item results.

## Project

```bash
linear-agent project get <id> --json
linear-agent project list --json
linear-agent project create --name <name> [--description <text>] [--team <name|key|id>] --json
linear-agent project update <id> [--name <text>] [--description <text>] [--state <state>] --json
linear-agent project delete <id> --json              # [destructive]
```

## Cycle

```bash
linear-agent cycle get <id> --json
linear-agent cycle list [--team <name|key|id>] --json
linear-agent cycle create --team <name|key|id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json
linear-agent cycle update <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json
```

## Team

```bash
linear-agent team get <id-or-key> --json
linear-agent team list --json
```

## User

```bash
linear-agent user get <id> --json
linear-agent user me --json
linear-agent user list --json
```

## Label

```bash
linear-agent label get <id> --json
linear-agent label list [--team <name|key|id>] --json
linear-agent label create --name <name> [--description <text>] [--color <hex>] [--team <name|key|id>] --json
linear-agent label delete <id> --json                # [destructive]
```

## Workflow state

```bash
linear-agent state get <id> --json
linear-agent state list [--team <name|key|id>] [--everything] --json
linear-agent state create --name <name> --team <name|key|id> --state-type <type> \
  [--description <text>] [--color <hex>] [--position <n>] --json
```

`--state-type` must be one of: `backlog`, `unstarted`, `started`, `completed`, `canceled`.

## Project status

Project statuses are workspace-level (not team-scoped) and represent customizable statuses for projects.

```bash
linear-agent project-status list [--json]
linear-agent project-status get <id> [--json]
linear-agent project-status create --name <name> --status-type <type> \
  [--description <text>] [--color <hex>] [--position <n>] [--json]
linear-agent project-status delete <id> [--json]          # [destructive]
```

`--status-type` must be one of: `backlog`, `planned`, `started`, `paused`, `completed`, `canceled`.

## Comment

```bash
linear-agent comment list --issue <id> --json
linear-agent comment create --issue <id> --body <text> --json
linear-agent comment update <id> --body <text> --json
linear-agent comment delete <id> --json              # [destructive]
```

## Attachment

```bash
linear-agent attachment list --issue <id> --json
linear-agent attachment create --issue <id> --url <url> --title <title> --json
linear-agent attachment delete <id> --json            # [destructive]
```

## File

```bash
# Upload a file (optionally attach to an issue)
linear-agent file upload <path> [--issue <id>] --json

# Get a signed URL for an attachment
linear-agent file url <attachment-id> [--expires-in <seconds>] --json

# Download a file
linear-agent file download <url> [--output <path>] --json
```

## Auth

```bash
# API key login
linear-agent auth login --profile <name> --api-key-env <ENV_VAR> [--set-default]

# OAuth login
linear-agent auth login --profile <name> --oauth --oauth-client-id <id> \
  [--callback-port <port>] [--no-browser] [--set-default]

# Stdin API key
linear-agent auth login --profile <name> --api-key-stdin [--set-default]

# Show all profiles
linear-agent auth status --json

# Show current user and workspace
linear-agent auth whoami --json

# Switch default profile
linear-agent auth switch <profile>

# Remove a profile [destructive with --remove-config]
linear-agent auth logout --profile <name> [--remove-config]
```

See [auth-and-profiles.md](auth-and-profiles.md) for details.

## Workspace

```bash
linear-agent workspace list --json
```

## Schema

```bash
# Show bundled schema version
linear-agent schema version --json

# Pull latest schema from Linear API
linear-agent schema pull [--output-dir <path>] --json

# Check for schema drift between bundled and live
linear-agent schema check --json
```

See [schema-and-generated.md](schema-and-generated.md) for details.

## Skills

```bash
# Install agent skills to project (.claude/skills/)
linear-agent skills install [--json]

# List embedded skills
linear-agent skills list [--json]
```

Auto-discovers installed agents (Claude Code, Codex) at project and user level and installs skills to all found directories.

## Generated API

The generated layer covers any Linear API resource not handled by curated commands.

```bash
# List all available resources
linear-agent api --help

# List operations for a resource
linear-agent api <resource> --help

# Search for commands
linear-agent api search <term>

# Execute a generated command
linear-agent api <resource> <operation> [--id <id>] [--input-json <json>] \
  [--input-file <path>] [--input-stdin] [--fields <f1,f2>] --json
```

See [schema-and-generated.md](schema-and-generated.md) for details.

## Raw GraphQL

Fallback for operations not covered by curated or generated commands.

```bash
# Inline query
linear-agent gql query '{ viewer { id name } }' --json

# Query from file with variables
linear-agent gql query --file query.graphql --var "teamId=abc123" --json

# Mutation from file with variable file
linear-agent gql mutation --file mutation.graphql --vars-file vars.json --json

# Introspection
linear-agent gql introspect --json
```

Output modes for `gql`: `--json`, `--json-envelope`, `--raw`.
