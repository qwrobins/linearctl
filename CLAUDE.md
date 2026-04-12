# CLAUDE.md

## Purpose

This repository is an agent-first `linear-agent` CLI. The primary consumer is AI agents, not only human operators. The CLI and the skill layer are a single product:

- The CLI is the execution layer
- The skills are the routing and decision layer

## Key Documents

- `docs/getting-started.md` — installation and first-time setup
- `docs/commands.md` — full command reference
- `docs/auth-and-profiles.md` — authentication and profile management
- `docs/output-modes.md` — JSON, JSONL, envelope, and raw output
- `docs/filtering-and-pagination.md` — filters, ordering, and pagination
- `docs/agent-usage.md` — how AI agents should use the CLI
- `docs/schema-and-generated.md` — schema management and generated API layer
- `docs/implementation-progress.md` — implementation status and history
- `skills/linear-agent-cli.md` — default agent skill (`linear-agent-cli`) with routing rules
- `skills/linear-agent-raw-gql.md` — raw GraphQL fallback skill (`linear-agent-raw-gql`)

## Stack

- Language: TypeScript
- Runtime/tooling: Bun
- Release artifact: standalone binaries (`~/.local/bin`)
- End users do not need Bun installed to use released binaries
- Do not introduce Bun-specific runtime APIs unless there is a clear payoff; keep core logic portable

## Architecture

Three command layers, kept separate — do not collapse them:

1. **Curated commands**: `linear-agent <resource> ...`
2. **Generated commands**: `linear-agent api ...`
3. **Raw GraphQL**: `linear-agent gql ...`

Routing prefers curated → generated → raw GraphQL.

### Architecture priorities

1. Agent-usable command contracts
2. Stable machine-readable output
3. Explicit fallback from curated → generated → raw GraphQL
4. Safe auth and profile behavior
5. Low-friction standalone distribution

## Agent-Facing Rules

- Help text is part of the agent interface.
- `--json` output shapes are stable contracts — do not weaken them for convenience.
- Keep stderr and stdout cleanly separated.
- Do not parse human-oriented output when machine-readable output is available.
- Mark destructive or confirmation-requiring commands explicitly in metadata and docs.
- Prefer deterministic command discovery over guessing.
- Use `--dry-run` to preview destructive operations before executing.

## Auth and Safety

- Support named profiles with API key and OAuth authentication.
- Never silently choose among multiple profiles.
- OAuth uses PKCE flow with local loopback callback; auto-refreshes expired tokens.
- Never accept secrets as plain CLI arguments when a safer input method exists.
- Credentials file uses restrictive permissions (0600).

## Editing Rules

- Keep changes minimal and local.
- If you change command behavior, update `docs/` in the same change.
- If you change output contracts or auth semantics, update the relevant docs before the task is complete.

## Review Gate

- Run a local CodeRabbit review before pushing or opening a PR.
- Treat CodeRabbit findings as blocking unless there is a documented reason not to.
- Fix issues, re-run, and repeat until the review passes cleanly.
- Only push/open a PR after CodeRabbit passes.

## When Code and Docs Disagree

Do not guess. Either:

- Align the implementation to the docs, or
- Update the docs explicitly in the same change with a clear rationale
