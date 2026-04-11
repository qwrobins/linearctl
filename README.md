# linear

Agent-first CLI for the Linear API.

Three command layers: curated commands, generated API, and raw GraphQL. Agents and humans use the same tool.

## Install

```bash
bun run build:binary
cp dist/linear ~/.local/bin/linear
```

Requires [Bun](https://bun.sh) to build. The compiled binary has no runtime dependencies.

## Quick start

```bash
# Authenticate with an API key (store the key in an env var, not as a CLI argument)
export LINEAR_API_KEY=lin_api_...
linear auth login --profile work --api-key-env LINEAR_API_KEY

# Verify auth
linear auth status --json

# List your issues
linear user me --json
linear issue list --team INF --state "In Progress" --json

# Create an issue
linear issue create --title "Fix pagination bug" --team INF --priority 2 --json
```

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
