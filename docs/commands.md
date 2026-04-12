# Command reference

All commands support `--json` for machine-readable output and `--json-envelope` for metadata-enriched output. Mutating commands support `--dry-run` to preview without executing.

Global flags: `--profile <name>`, `--no-retry`, `--max-retries <n>`.

## Issue

```bash
# Get a single issue by identifier or UUID
linear issue get <identifier> --json

# List issues with filters
linear issue list [--team <name|key|id>] [--state <name|id>] [--assignee <email|"me"|id>] \
  [--label <name|id>] [--priority <0-4>] [--filter-json <json>] [--order-by <field>] \
  [--all] [--max <n>] [--page-size <n>] [--after <cursor>] --json

# Create an issue
linear issue create --title <title> --team <name|key|id> \
  [--description <text>] [--priority <0-4>] [--assignee <email|"me"|id>] \
  [--label <name|id>] [--state <name|id>] --json

# Update an issue
linear issue update <identifier> [--title <text>] [--description <text>] \
  [--priority <0-4>] [--assignee <email|"me"|id>] [--state <name|id>] --json

# Close (archive) an issue [destructive]
linear issue close <identifier> --json

# Assign an issue
linear issue assign <identifier> <assignee> --json

# Add a comment
linear issue comment <identifier> --body <text> --json
```

### Bulk operations

```bash
# Bulk update fields on multiple issues
linear issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] \
  [--priority <0-4>] [--label <id>] --json

# Bulk close multiple issues
linear issue bulk-close --ids <id1,id2,...> --json

# Bulk assign multiple issues
linear issue bulk-assign --ids <id1,id2,...> --assignee <id> --json
```

Bulk operations report partial success. Check the response for per-item results.

## Project

```bash
linear project get <id> --json
linear project list --json
linear project create --name <name> [--description <text>] [--team <name|key|id>] --json
linear project update <id> [--name <text>] [--description <text>] [--state <state>] --json
linear project delete <id> --json              # [destructive]
```

## Cycle

```bash
linear cycle get <id> --json
linear cycle list [--team <name|key|id>] --json
linear cycle create --team <name|key|id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json
linear cycle update <id> [--name <text>] [--starts-at <date>] [--ends-at <date>] --json
```

## Team

```bash
linear team get <id-or-key> --json
linear team list --json
```

## User

```bash
linear user get <id> --json
linear user me --json
linear user list --json
```

## Label

```bash
linear label get <id> --json
linear label list [--team <name|key|id>] --json
linear label create --name <name> [--description <text>] [--color <hex>] [--team <name|key|id>] --json
linear label delete <id> --json                # [destructive]
```

## Workflow state

```bash
linear state get <id> --json
linear state list [--team <name|key|id>] [--everything] --json
linear state create --name <name> --team <name|key|id> --state-type <type> \
  [--description <text>] [--color <hex>] [--position <n>] --json
```

`--state-type` must be one of: `backlog`, `unstarted`, `started`, `completed`, `canceled`.

## Project status

Project statuses are workspace-level (not team-scoped) and represent customizable statuses for projects.

```bash
linear project-status list [--json]
linear project-status get <id> [--json]
linear project-status create --name <name> --status-type <type> \
  [--description <text>] [--color <hex>] [--position <n>] [--json]
linear project-status delete <id> [--json]          # [destructive]
```

`--status-type` must be one of: `backlog`, `planned`, `started`, `paused`, `completed`, `canceled`.

## Comment

```bash
linear comment list --issue <id> --json
linear comment create --issue <id> --body <text> --json
linear comment update <id> --body <text> --json
linear comment delete <id> --json              # [destructive]
```

## Attachment

```bash
linear attachment list --issue <id> --json
linear attachment create --issue <id> --url <url> --title <title> --json
linear attachment delete <id> --json            # [destructive]
```

## File

```bash
# Upload a file (optionally attach to an issue)
linear file upload <path> [--issue <id>] --json

# Get a signed URL for an attachment
linear file url <attachment-id> [--expires-in <seconds>] --json

# Download a file
linear file download <url> [--output <path>] --json
```

## Auth

```bash
# API key login
linear auth login --profile <name> --api-key-env <ENV_VAR> [--set-default]

# OAuth login
linear auth login --profile <name> --oauth --oauth-client-id <id> \
  [--callback-port <port>] [--no-browser] [--set-default]

# Stdin API key
linear auth login --profile <name> --api-key-stdin [--set-default]

# Show all profiles
linear auth status --json

# Show current user and workspace
linear auth whoami --json

# Switch default profile
linear auth switch <profile>

# Remove a profile [destructive with --remove-config]
linear auth logout --profile <name> [--remove-config]
```

See [auth-and-profiles.md](auth-and-profiles.md) for details.

## Workspace

```bash
linear workspace list --json
```

## Schema

```bash
# Show bundled schema version
linear schema version --json

# Pull latest schema from Linear API
linear schema pull [--output-dir <path>] --json

# Check for schema drift between bundled and live
linear schema check --json
```

See [schema-and-generated.md](schema-and-generated.md) for details.

## Generated API

The generated layer covers any Linear API resource not handled by curated commands.

```bash
# List all available resources
linear api --help

# List operations for a resource
linear api <resource> --help

# Search for commands
linear api search <term>

# Execute a generated command
linear api <resource> <operation> [--id <id>] [--input-json <json>] \
  [--input-file <path>] [--input-stdin] [--fields <f1,f2>] --json
```

See [schema-and-generated.md](schema-and-generated.md) for details.

## Raw GraphQL

Fallback for operations not covered by curated or generated commands.

```bash
# Inline query
linear gql query '{ viewer { id name } }' --json

# Query from file with variables
linear gql query --file query.graphql --var "teamId=abc123" --json

# Mutation from file with variable file
linear gql mutation --file mutation.graphql --vars-file vars.json --json

# Introspection
linear gql introspect --json
```

Output modes for gql: `--json`, `--json-envelope`, `--raw`.
