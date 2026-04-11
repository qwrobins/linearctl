# CLAUDE.md

## Purpose

This repository builds an agent-first `linear` CLI. The primary consumer is AI agents, not only human operators. The CLI and the skill layer are a single product:

- The CLI is the execution layer
- The skills are the routing and decision layer

## Key Documents

Read these before making architectural or behavioral changes:

- `docs/linear-cli-spec.md`
- `docs/linear-cli-requirements.md`
- `docs/linear-cli-implementation-handoff.md`
- `docs/linear-cli-round-2-decisions.md`
- `docs/linear-skill-suite.md`
- `docs/implementation-progress.md` — durable handoff between sessions; update it when a PR lands, a phase boundary changes, or the next implementation slice changes

## Stack

- Language: TypeScript
- Runtime/tooling: Bun
- Release artifact: standalone binaries (`~/.local/bin`)
- End users do not need Bun installed to use released binaries
- Do not introduce Bun-specific runtime APIs unless there is a clear payoff; keep core logic portable

## Architecture

Three command layers, kept separate — do not collapse them:

1. **Curated commands**: `linear <resource> ...`
2. **Generated commands**: `linear api ...`
3. **Raw GraphQL**: `linear gql ...`

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

## Auth and Safety

- Support named profiles.
- Never silently choose among multiple profiles.
- MVP auth source is the credentials file.
- OAuth/keychain fallback is post-MVP only.
- Never accept secrets as plain CLI arguments when a safer input method exists.

## Editing Rules

- Keep changes minimal and local.
- If you change command behavior, update `docs/` in the same change.
- If you change routing, output contracts, auth semantics, or generated naming, update the relevant design docs before the task is complete.

## Review Gate

- Run a local CodeRabbit review before pushing or opening a PR.
- Treat CodeRabbit findings as blocking unless there is a documented reason not to.
- Fix issues, re-run, and repeat until the review passes cleanly.
- Only push/open a PR after CodeRabbit passes.

## Implementation Order

1. Agent contract and command metadata
2. Core execution layer
3. Raw GraphQL fallback
4. Curated high-value commands
5. Generated parity layer
6. Skill packaging and validation

## When Code and Docs Disagree

Do not guess. Either:

- Align the implementation to the docs, or
- Update the docs explicitly in the same change with a clear rationale
