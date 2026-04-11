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
- Current Phase 2 auth/config foundations:
  - atomic config and credentials writes with restrictive permissions
  - config default-profile update support
  - `linear auth status` with human and JSON output
  - `linear auth switch <profile>`
  - CLI-level `--config`/`--config-file` and `--credentials`/`--credentials-file` overrides for local auth commands
  - GraphQL transport wrapper for lightweight authenticated requests such as `viewer`
  - shared runtime profile resolution loader for authenticated commands
  - shared transport error mapping for profile resolution and GraphQL failures
  - API-key `linear auth login --profile <name> --api-key-env <ENV>` and `--api-key-stdin`
  - optional `--set-default` on API-key login
  - `linear auth logout --profile <name>` with optional `--remove-config`
- Initial Phase 3 raw GraphQL support:
  - `linear gql query` with inline query text, `--file`, or `--stdin`
  - `linear gql mutation` with inline document text, `--file`, or `--stdin`
  - variable input via repeated `--var key=value` and `--vars-file`
  - resolved-profile runtime auth for raw GraphQL commands
  - explicit `--json`, `--json-envelope`, or `--raw` output modes for raw GraphQL commands

## Recommended Next Slice

Continue Phase 3 raw GraphQL support and close the remaining auth/runtime gaps.

Suggested scope:

- `linear gql introspect`
- initial `linear schema version`
- initial `linear schema pull` scaffolding and bundled schema-version surface
- JSON envelope support for auth commands where useful
- decide whether `--api-url` remains a hidden test/development override or should be documented as `base_url` behavior
- factor shared command error/output helpers if raw GraphQL and curated commands start duplicating logic

Defer unless deliberately scoped:

- OAuth browser callback flow
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
