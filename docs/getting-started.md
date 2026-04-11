# Getting started

## Install

Build the standalone binary:

```bash
bun run build:binary
```

This produces `dist/linear`. Copy it somewhere on your `PATH`:

```bash
cp dist/linear ~/.local/bin/linear
```

The binary is self-contained. End users do not need Bun installed.

## Authenticate

The CLI uses named profiles. You must create at least one before running commands.

### API key

Store your Linear API key in an environment variable. Create one at [Linear API settings](https://linear.app/settings/api).

```bash
export LINEAR_API_KEY=lin_api_...
linear auth login --profile work --api-key-env LINEAR_API_KEY
```

Or pipe it via stdin:

```bash
echo "$LINEAR_API_KEY" | linear auth login --profile work --api-key-stdin
```

To make this the default profile:

```bash
linear auth login --profile work --api-key-env LINEAR_API_KEY --set-default
```

### OAuth

Use OAuth for browser-based login with PKCE. You need an OAuth application client ID from [Linear API applications](https://linear.app/settings/api/applications).

```bash
linear auth login --profile work --oauth --oauth-client-id <client-id>
```

This opens your browser for authorization and listens on `127.0.0.1:8765` for the callback. Override the port with `--callback-port`. Use `--no-browser` to print the URL instead of opening it.

OAuth tokens auto-refresh when expired.

## Verify

```bash
linear auth status --json
```

This shows all configured profiles, their auth type, and which is the default.

To check the authenticated user and workspace:

```bash
linear auth whoami --json
```

## Switch profiles

If you have multiple profiles:

```bash
linear auth switch personal
```

Or set the profile per-command:

```bash
linear issue list --profile personal --json
```

Or via environment variable:

```bash
export LINEAR_PROFILE=personal
linear issue list --json
```

## First commands

```bash
# Current user
linear user me --json

# List teams
linear team list --json

# List issues for a team (by key or name)
linear issue list --team INF --json

# List your in-progress issues
linear issue list --assignee me --state "In Progress" --json

# Get a specific issue
linear issue get INF-42 --json

# Create an issue
linear issue create --title "Update docs" --team INF --priority 1 --json
```

All data commands support `--json` for machine-readable output. See [output modes](output-modes.md).
