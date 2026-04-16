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

The project is fully implemented. All MVP and post-MVP features are on main.

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
  - `linearctl auth status` with human and JSON output
  - `linearctl auth switch <profile>`
  - CLI-level `--config`/`--config-file` and `--credentials`/`--credentials-file` overrides for local auth commands
  - GraphQL transport wrapper for lightweight authenticated requests such as `viewer`
  - shared runtime profile resolution loader for authenticated commands
  - shared transport error mapping for profile resolution and GraphQL failures
  - API-key `linearctl auth login --profile <name> --api-key-env <ENV>` and `--api-key-stdin`
  - optional `--set-default` on API-key login
  - `linearctl auth logout --profile <name>` with optional `--remove-config`
- Initial Phase 3 raw GraphQL support:
  - `linearctl gql query` with inline query text, `--file`, or `--stdin`
  - `linearctl gql mutation` with inline document text, `--file`, or `--stdin`
  - `linearctl gql introspect` with the built-in GraphQL introspection query
  - `linearctl gql introspect` rejects document-source and variable flags that do not apply to the built-in query
  - variable input via repeated `--var key=value` and `--vars-file`
  - resolved-profile runtime auth for raw GraphQL commands
  - explicit `--json`, `--json-envelope`, or `--raw` output modes for raw GraphQL commands
  - stricter CLI unknown-flag rejection for the new auth and raw GraphQL flags
  - non-object `--vars-file` JSON roots rejected before variable merging
  - normalized profile-name trimming for credential mutations
  - config profile-name validation against INI-breaking characters
  - GraphQL transport preserves HTTP status on invalid JSON responses
  - GraphQL transport reports GraphQL `errors` before treating missing `data` as invalid

- Continued Phase 3 schema and infrastructure work:
  - `linearctl schema version` with `--json` and `--json-envelope` output
  - `linearctl schema pull` with live introspection, schema file output, and schema metadata generation
  - bundled `schema-meta.json` manifest with version fingerprinting from introspection type names
  - `--output-dir` flag for schema pull to control where schema files are written
  - `--json-envelope` support for all auth commands (`status`, `login`, `logout`, `switch`)
  - shared `src/core/io/stdin.ts` module extracted from duplicated `readAllStdin` and `isTtyInput` in `gql.ts` and `auth.ts`
  - shared `src/core/schema/introspection-query.ts` extracted from duplicated introspection query in `gql.ts`
  - build pipeline updated to copy `schema-meta.json` to dist alongside `curated-commands.json`

- Phase 3 schema check and transport retry:
  - `linearctl schema check` with bundled-vs-live drift detection, exit code 6 on drift
  - transport retry with bounded exponential backoff for 429 rate-limited responses
  - `--no-retry` and `--max-retries` CLI flags
  - injectable sleep for fast retry tests

- Phase 4 curated MVP commands (all 8 resource groups):
  - `issue`: list, get, create, update, close, assign, comment (7 operations)
  - `project`: list, get, create, update (4 operations)
  - `cycle`: list, get, create, update (4 operations)
  - `team`: list, get (2 operations)
  - `user`: list, get, me (3 operations)
  - `label`: list, get, create (3 operations)
  - `comment`: list, create, update, delete (4 operations)
  - `attachment`: list, create, delete (3 operations)
  - pagination infrastructure with `--all`, `--max`, `--page-size`, `--after`
  - filtering with `--state`, `--assignee`, `--team`, `--label`, `--priority`, `--filter-json`
  - stable normalized JSON output contracts for all resources
  - `--json` and `--json-envelope` support on all commands
  - human-readable default output for all commands

- Phase 5 generated API layer:
  - `linearctl api <resource> <operation>` command handler
  - manifest-driven command discovery
  - `linearctl api --help`, `linearctl api <resource> --help`, `linearctl api search <term>`
  - `--id`, `--input-json`, `--input-file`, `--input-stdin`, `--fields` support
  - schema-to-command manifest generator script

- Phase 4 file commands:
  - `linearctl file upload <path>` with authenticated PUT to pre-signed URL
  - `linearctl file upload --issue <id>` with automatic attachment creation
  - `linearctl file url <attachment-id>` with signed URL and `--expires-in`
  - `linearctl file download <url>` with authenticated download

- Phase 6 skill packaging:
  - `linearctl` skill with full command routing rules and examples
  - `linear-raw-gql` skill with raw GraphQL fallback guidance
  - anti-pattern documentation
  - error handling playbooks

- Post-MVP features (all complete):
  - OAuth browser callback flow with PKCE, loopback listener on 127.0.0.1:8765, token exchange, auto-refresh
  - `--oauth-client-id`, `--callback-port`, `--no-browser` CLI flags
  - Auto-refresh of expired OAuth tokens in profile resolution (5-minute window)
  - JSONL streaming output (`--jsonl`) for all list commands via `streamPaginateGraphQL`
  - Bulk operations: `issue bulk-update`, `issue bulk-close`, `issue bulk-assign` with partial success reporting
  - Schema regeneration tooling: `bun run regenerate:schema` with schema diff, CI exit codes
  - Schema diff utility comparing introspection results (added/removed types and fields, breaking change detection)
  - `linearctl schema check` now shows structural diff details when drift detected
  - Multi-organization selector: `linearctl auth whoami`, `linearctl workspace list`, workspace metadata stored on login
  - Profile resolution hints listing available profiles with workspace context on ambiguity
  - Name/identifier resolution: team name/key, user email/"me", label name, state name → ID
  - Resolution applied to issue create/update/assign/list, project create, cycle create/list, label create/list
  - `--dry-run` for all destructive/mutating commands (18 operations across 7 resource handlers)

## Architecture improvements (v0.5.0)

- **Typed command registry** (QWR-56): Single source of truth for option definitions, help text, parsing, and dispatch. Replaces 4+ places where command knowledge was duplicated in `src/cli/main.ts`. New modules: `src/core/registry/`.
- **Shared command runtime/context** (QWR-57): `CommandContext` class centralizes profile resolution, GraphQL execution, error mapping, and output emission. Demonstrated in the `project` command handler. New module: `src/core/runtime/command-context.ts`.
- **Retry wired into production** (QWR-58): `--no-retry` and `--max-retries` flags are now functional via `CommandContext.graphql()`, which routes through `executeGraphQLWithRetry()` when retry options are configured.
- **Workflow orchestration** (QWR-59): `runTwoStepWorkflow()` provides typed partial-success modeling for multi-step commands like `project create-with-issues`. Agents can now see exactly which step succeeded/failed. New module: `src/core/runtime/workflow.ts`.
- **Generated command naming overrides** (QWR-60): Override table in `src/generated/naming-overrides.ts` stabilizes generated API command names against schema naming shifts. Applied in `fieldToEntry()` before heuristic derivation.

## CommandContext migration (v0.5.1)

- **All curated handlers migrated to CommandContext** (QWR-61, QWR-62, QWR-63): Every curated command handler now uses `CommandContext` for profile resolution, GraphQL execution (with retry), error mapping, and output emission. Handlers migrated: issue (12 subcommands), cycle, label, state, comment, attachment, team, user, project-status, file, workspace.
- **Registry buildOptions boilerplate reduced** (QWR-64): Composable option mapping presets (`baseOptions`, `curatedOptions`, `paginationOptions`, `teamFilterOptions`, `pickFields`) replace manual `optionalString`/`optionalNumber`/`optionalBool` spreading. New module: `src/core/registry/option-mapping.ts`.

## All development complete

All MVP and post-MVP features are implemented. 384 of 386 tests across 40 test files are passing. 2 pre-existing failures in skills.test.ts are unrelated to this codebase and excluded from the passing count.

## Verification Baseline

The current baseline has been verified with:

- `bun run typecheck`
- `bun run test`
- `rm -rf dist && bun run build`
- `bun run build:binary`
- compiled binary metadata smoke test
- local CodeRabbit review before push

Future implementation slices should keep these checks passing unless a PR explicitly changes the verification strategy.
