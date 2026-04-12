# Getting started

## Install

Build the standalone binary:

```bash
bun run build:binary
```

This produces `dist/linearctl`. Copy it somewhere on your `PATH`:

```bash
cp dist/linearctl ~/.local/bin/linearctl
```

The binary is self-contained. End users do not need Bun installed.

## Install agent skills

If you're using an LLM agent (Claude Code, Codex, etc.), install the bundled skills so the agent knows how to use the CLI:

```bash
linearctl skills install
```

This auto-detects which agents you have installed (Claude Code, Codex) and writes the skills to the right directories. If no agents are detected, it defaults to Claude Code's project-level config.

## Authenticate

The CLI uses named profiles. You must create at least one before running commands.

### API key

Store your Linear API key in an environment variable. Create one at [Linear API settings](https://linear.app/settings/api).

```bash
export LINEAR_API_KEY=lin_api_...
linearctl auth login --profile work --api-key-env LINEAR_API_KEY
```

Or pipe it via stdin:

```bash
echo "$LINEAR_API_KEY" | linearctl auth login --profile work --api-key-stdin
```

To make this the default profile:

```bash
linearctl auth login --profile work --api-key-env LINEAR_API_KEY --set-default
```

### OAuth

Use OAuth for browser-based login with PKCE. You need an OAuth application client ID from [Linear API applications](https://linear.app/settings/api/applications).

```bash
linearctl auth login --profile work --oauth --oauth-client-id <client-id>
```

This opens your browser for authorization and listens on `127.0.0.1:8765` for the callback. Override the port with `--callback-port`. Use `--no-browser` to print the URL instead of opening it.

OAuth tokens auto-refresh when expired.

## Verify

```bash
linearctl auth status --json
```

This shows all configured profiles, their auth type, and which is the default.

To check the authenticated user and workspace:

```bash
linearctl auth whoami --json
```

## Switch profiles

If you have multiple profiles:

```bash
linearctl auth switch personal
```

Or set the profile per-command:

```bash
linearctl issue list --profile personal --json
```

Or via environment variable:

```bash
export LINEAR_PROFILE=personal
linearctl issue list --json
```

## Set a default team

Most workspaces have one primary team. Setting a default team scopes list commands automatically so you don't need `--team` on every call.

```bash
# Find your team key
linearctl team list --json

# Set it as the default for your profile
linearctl team get <team-key> --set-default
```

Now `linearctl issue list --json` returns only issues from that team. Override with `--team <other>` or bypass with `--everything`. Note that `--team` and `--everything` cannot be used together.

## First commands

```bash
# Current user
linearctl user me --json

# List issues (scoped to default team if set)
linearctl issue list --json

# List your in-progress issues
linearctl issue list --assignee me --state "In Progress" --json

# Get a specific issue
linearctl issue get INF-42 --json

# Create an issue (uses default team if set, or specify --team)
linearctl issue create --title "Update docs" --priority 1 --json

# See all projects across teams
linearctl project list --everything --json
```

All data commands support `--json` for machine-readable output. See [output modes](output-modes.md).
