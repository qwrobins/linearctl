# AGENTS.md

## Purpose

This repository is for building an agent-first `linear` CLI.

The primary consumer is AI agents, not only human operators. The CLI and the skill layer should be treated as a single product:

- the CLI is the execution layer
- the skills are the routing and decision layer

## Current State

The repository currently contains design and requirements docs under `docs/`.

Important documents:

- `docs/linear-cli-implementation-handoff.md`
- `docs/linear-cli-spec.md`
- `docs/linear-cli-requirements.md`
- `docs/linear-cli-round-2-decisions.md`
- `docs/linear-skill-suite.md`

Before making architectural or behavioral changes, read those files and keep them aligned.

## Core Product Direction

- Implementation language: TypeScript
- Default runtime/tooling: Bun
- Default release artifact: standalone binaries
- Expected install model: users place the built binary somewhere like `~/.local/bin`
- End users should not need Bun installed to use released binaries

## Architecture Priorities

Preserve these priorities:

1. agent-usable command contracts
2. stable machine-readable output
3. explicit fallback from curated commands to generated commands to raw GraphQL
4. safe auth and profile behavior
5. low-friction standalone distribution

## Command Model

The CLI has three layers:

1. Curated commands: `linear <resource> ...`
2. Generated commands: `linear api ...`
3. Raw GraphQL: `linear gql ...`

Default routing should prefer:

1. curated
2. generated
3. raw GraphQL

Do not collapse these layers together.

## Agent-Facing Rules

- Treat help text as part of the agent interface.
- Treat `--json` output shapes as stable contracts.
- Keep stderr and stdout cleanly separated.
- Do not parse human-oriented output when machine-readable output is available.
- Mark destructive or confirmation-requiring commands explicitly in metadata and docs.
- Prefer deterministic command discovery over guessing.

## Auth And Safety

- Support named profiles.
- Never silently choose among multiple profiles.
- MVP runtime auth source is the credentials file.
- OAuth keychain fallback is post-MVP only unless the docs are intentionally changed.
- Never accept secrets as normal plain CLI arguments when a safer input method exists.

## Editing Rules

- Keep changes minimal and local when possible.
- Do not introduce Bun-specific runtime APIs unless there is a clear payoff.
- Keep core logic portable even if Bun is the main tooling and packaging choice.
- Do not weaken the curated `--json` contract for convenience.
- If you change command behavior, update the docs in `docs/` in the same change.
- If you change routing, output contracts, auth semantics, or generated naming, update the relevant design docs before considering the task complete.

## Repo Hygiene

- Use `apply_patch` for manual file edits.
- Keep `.gitignore` up to date for new tooling output.
- Avoid committing local secrets, env files, or generated noise.

## Review Gate

- Run a local CodeRabbit review with the CodeRabbit CLI before pushing changes and before opening a PR.
- Treat CodeRabbit findings as blocking unless there is a documented reason not to.
- Fix the issues CodeRabbit reports, then re-run the CodeRabbit review.
- Repeat that fix-and-review loop until CodeRabbit reports no issues.
- Only push changes and open a PR after the local CodeRabbit review passes cleanly.

## When Implementing

Start from the docs, then turn decisions into code.

Implementation order should generally follow:

1. agent contract and command metadata
2. core execution layer
3. raw GraphQL fallback
4. curated high-value commands
5. generated parity layer
6. skill packaging and validation

## When Unsure

If the code and docs disagree, do not guess.

Either:

- align the implementation to the docs, or
- update the docs explicitly as part of the same change with a clear rationale
