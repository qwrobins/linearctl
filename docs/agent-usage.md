# Agent usage

This CLI is designed for AI agents as a primary consumer. This guide covers how agents should interact with it.

## Command routing

Use the three command layers in this order:

1. **Curated commands** (`linear <resource> ...`) -- preferred. Stable contracts, name resolution, pagination.
2. **Generated commands** (`linear api <resource> <operation>`) -- when no curated command exists. Discover with `linear api search <term>`.
3. **Raw GraphQL** (`linear gql ...`) -- last resort. Only when curated and generated layers cannot cover the operation.

Do not use raw GraphQL merely because it is possible.

## Always use --json

Agents must use `--json` or `--json-envelope` for all output parsing. The default human-readable output is not stable and must not be parsed.

```bash
linear issue list --team INF --json
```

Use `--json-envelope` when you need pagination metadata or error details alongside data.

## Profile handling

Agents should set the profile explicitly:

```bash
# Via flag
linear issue list --profile work --json

# Via environment variable
export LINEAR_PROFILE=work
linear issue list --json
```

Do not rely on the default profile in agent sessions. Do not guess profile names -- run `linear auth status --json` to discover available profiles.

## Pagination

- Add filters before paginating. Fetching all issues in a workspace is expensive.
- Use `--max` to cap results. Treat 200 as the soft cap for large enumerations.
- Do not use `--all` without `--max` unless the user explicitly asked for everything.
- Use `--jsonl` for streaming large result sets (auto-paginates, one object per line).

```bash
# Good: filtered and bounded
linear issue list --team INF --state "In Progress" --max 50 --json

# Bad: unbounded full scan
linear issue list --all --json
```

## Error handling

Check exit codes for structured error handling:

| Exit code | Meaning | Agent action |
|---|---|---|
| 0 | Success | Process the output |
| 1 | General error | Read stderr, report to user |
| 2 | Auth error | Run `linear auth status`, re-authenticate |
| 3 | Rate limit | Wait, reduce scope, add filters |
| 4 | Not found | Verify the identifier |
| 5 | Validation error | Check flags and input |
| 6 | Schema drift | Fall back to `linear gql`, suggest CLI update |

## Dry run

Preview destructive operations before executing:

```bash
linear issue create --title "Test" --team INF --dry-run --json
linear issue bulk-close --ids "id1,id2" --dry-run --json
```

`--dry-run` works on all mutating commands (create, update, close, assign, comment, delete, upload, bulk operations).

## Command discovery

Use these for programmatic discovery:

```bash
# Full curated command metadata
linear --metadata curated --json

# Generated API resource list
linear api --help

# Search generated commands
linear api search "webhook"

# Built-in help
linear --help
```

## Anti-patterns

- Do not use `linear gql` when curated or generated commands cover the task
- Do not use `--all` without `--max` unless explicitly asked for everything
- Do not parse human-mode output programmatically
- Do not guess profile names
- Do not pass secrets as CLI arguments
- Do not retry immediately after rate-limit exhaustion (exit code 3)
- Do not run destructive operations without explicit user confirmation
