# linearctl

Agent-first CLI for the Linear API. Built to be used by LLM coding agents like Claude Code and Codex, but works just as well for humans at the terminal.

Three command layers: curated commands for common workflows, a generated API layer for full schema coverage, and raw GraphQL as a fallback. All output is machine-readable by default (`--json`), with stable contracts that agents can rely on.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/qwrobins/linearctl/main/install.sh | sh
```

Or install a specific version:

```bash
LINEAR_VERSION=v0.1.0 curl -fsSL https://raw.githubusercontent.com/qwrobins/linearctl/main/install.sh | sh
```

On Debian/Ubuntu, the installer automatically uses the `.deb` package. To skip deb and install the raw binary instead:

```bash
LINEAR_NO_DEB=1 curl -fsSL https://raw.githubusercontent.com/qwrobins/linearctl/main/install.sh | sh
```

Or build from source:

```bash
bun run build:binary
cp dist/linearctl ~/.local/bin/linearctl
```

The compiled binary has no runtime dependencies. Building from source requires [Bun](https://bun.sh).

## Quick start

```bash
# Authenticate with an API key (create one at https://linear.app/settings/api)
export LINEAR_API_KEY=lin_api_...
linearctl auth login --profile work --api-key-env LINEAR_API_KEY --set-default

# Set a default team so list commands are scoped automatically
linearctl team list --json
linearctl team get <team-key> --set-default

# Verify setup
linearctl auth whoami --json

# Use it
linearctl issue list --json
linearctl issue create --title "Fix pagination bug" --priority 2 --json
```

LLM agents can bootstrap this setup for you — install the agent skills with `linearctl skills install` and the [linearctl skill](skills/linearctl/SKILL.md) includes first-time setup instructions for agents.

## Commands

| Group | Operations |
|---|---|
| [issue](docs/commands.md#issue) | get, list, create, update, close, assign, comment, bulk-update, bulk-close, bulk-assign |
| [project](docs/commands.md#project) | get, list, create, update |
| [cycle](docs/commands.md#cycle) | get, list, create, update |
| [team](docs/commands.md#team) | get, list |
| [user](docs/commands.md#user) | get, me, list |
| [label](docs/commands.md#label) | get, list, create |
| [comment](docs/commands.md#comment) | list, create, update, delete |
| [attachment](docs/commands.md#attachment) | list, create, delete |
| [file](docs/commands.md#file) | upload, url, download |
| [auth](docs/commands.md#auth) | login, logout, status, switch, whoami |
| [workspace](docs/commands.md#workspace) | list |
| [schema](docs/commands.md#schema) | version, pull, check |
| [api](docs/commands.md#generated-api) | Generated commands for any Linear API resource |
| [gql](docs/commands.md#raw-graphql) | Raw GraphQL queries and mutations |

## Profiles

Credentials are stored in AWS CLI-style INI files at `~/.config/linear/`:

```
~/.config/linear/
  config          # default profile, workspace metadata
  credentials     # API keys and OAuth tokens (0600 permissions)
```

Each profile is a named section. Resolution order: `--profile` flag > `LINEAR_PROFILE` env var > configured default. See [auth and profiles](docs/auth-and-profiles.md) for the full file layout and OAuth setup.

## Output modes

| Flag | Description |
|---|---|
| *(none)* | Human-readable (not stable, not for parsing) |
| `--json` | Data-only JSON (stable contract) |
| `--json-envelope` | Envelope with `ok`, `data`, `pageInfo`, `errors`, `meta` |
| `--jsonl` | Streaming, one JSON object per line, auto-paginates |
| `--raw` | Exact GraphQL response (gql only) |

See [docs/output-modes.md](docs/output-modes.md).

## Docs

- [Getting started](docs/getting-started.md)
- [Command reference](docs/commands.md)
- [Auth and profiles](docs/auth-and-profiles.md)
- [Output modes](docs/output-modes.md)
- [Filtering and pagination](docs/filtering-and-pagination.md)
- [Agent usage](docs/agent-usage.md)
- [Schema and generated API](docs/schema-and-generated.md)

## License

Private.
