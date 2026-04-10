# Implementation Progress

## Purpose

This file is the durable handoff for implementation sessions. Keep it current when a PR lands, a phase boundary changes, or the recommended next implementation slice changes.

The normative product docs remain:

- `docs/linear-cli-implementation-handoff.md`
- `docs/linear-cli-spec.md`
- `docs/linear-cli-requirements.md`
- `docs/linear-cli-round-2-decisions.md`
- `docs/linear-skill-suite.md`

## Current Status

The project has started implementation and `main` includes the first two foundational slices.

Completed:

- PR #1, Phase 1 scaffold and contracts:
  - Bun and TypeScript project setup
  - minimal CLI entrypoint
  - command metadata contract types
  - exit code mapping
  - JSON envelope helpers
  - curated command taxonomy manifest
  - tests for CLI metadata output, taxonomy validation, exit codes, and envelopes
- PR #2, Phase 2 core config and profile resolution:
  - AWS-style INI parser and stringifier
  - documented config path helpers
  - config file parsing and loading
  - credentials file parsing and loading
  - credentials-file permission checks
  - API key and OAuth credential profile types
  - profile resolution precedence: explicit profile, `LINEAR_PROFILE`, configured default, then error
  - hardening for null-prototype dictionaries, reserved INI keys, normalized credential profile-name collisions, and same-handle credentials permission checks

## Recommended Next Slice

Continue Phase 2 with credential writing and initial auth command foundations.

Suggested scope:

- atomic credentials/config writes with restrictive permissions
- config default-profile update support
- `linear auth status`
- `linear auth switch`
- CLI-level wiring for profile/config path options if needed by those commands

Defer unless deliberately scoped:

- OAuth browser callback flow
- live Linear API token validation
- GraphQL transport wrapper
- raw GraphQL commands
- generated API layer

## Verification Baseline

The current baseline has been verified with:

- `bun run typecheck`
- `bun run test`
- `rm -rf dist && bun run build`
- `bun run build:binary`
- compiled binary metadata smoke test
- local CodeRabbit review before push

Future implementation slices should keep these checks passing unless a PR explicitly changes the verification strategy.
