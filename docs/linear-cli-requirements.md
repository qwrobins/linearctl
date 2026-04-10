# Linear CLI Requirements

## Purpose

This document defines the requirements for a `linear` command line tool designed to provide practical full parity with the Linear API while also serving as a strong foundation for AI skill-driven usage.

## Parity Definition

"Full parity" means every production Linear GraphQL query and mutation is executable through the CLI through one of three layers:

1. Curated commands: `linear <resource> ...`
2. Generated API commands: `linear api ...`
3. Raw GraphQL commands: `linear gql ...`

The curated layer is optimized for ergonomics and stable workflows. The generated layer is optimized for breadth of coverage. The raw GraphQL layer is the compatibility backstop.

Parity does not require every GraphQL field or mutation to receive a hand-authored command.

## Layer Model

### Curated layer

- Namespace: `linear <resource> ...`
- Hand-authored, human-oriented commands for high-value workflows
- Stable UX and stable machine-usable output contracts

### Generated layer

- Namespace: `linear api ...`
- Generated from a bundled schema snapshot
- Explicitly separate from curated namespaces to avoid collision and ambiguity
- Covers broad API access beyond curated commands

### Raw GraphQL layer

- Namespace: `linear gql ...`
- Supports direct execution of arbitrary queries and mutations
- Provides immediate coverage when curated or generated commands lag the live schema

## Required for MVP

### Runtime and distribution

- Use TypeScript as the implementation language
- Use Bun as the default development runtime and package manager
- Support standalone binary builds as the primary release artifact
- End users should not need Bun installed to use released binaries
- Avoid unnecessary Bun-specific runtime APIs in core business logic unless they provide clear value
- Validate packaged binary behavior in CI for supported platforms

### Auth and profiles

- Support named profiles
- Support both personal API keys and OAuth token-based profiles
- Never accept secret values as plain CLI arguments
- Support API key input via stdin or environment reference
- Support OAuth login flow with stored refresh token support
- Support `linear auth status`, `linear auth logout`, and default profile switching
- Resolve active profile by: `--profile` > `LINEAR_PROFILE` > configured default > error
- Never fall back implicitly to the first configured profile
- Auto-refresh expired OAuth access tokens when possible
- Fail explicitly on invalid API keys or failed refreshes
- Store credentials in an AWS-style credentials file with restrictive permissions
- Keep non-secret profile metadata in a separate config file
- Use INI-style profile sections similar to AWS CLI
- Runtime auth in MVP uses the credentials file as the sole source of truth. OAuth keychain fallback is an allowed post-MVP extension, and if implemented later it must only apply when file credentials do not exist for the resolved profile.

### Curated command coverage

MVP curated resource groups:

- `issue`: `list`, `get`, `create`, `update`, `close`, `assign`, `comment`
- `project`: `list`, `get`, `create`, `update`
- `cycle`: `list`, `get`, `create`, `update`
- `team`: `list`, `get`
- `user`: `list`, `get`, `me`
- `label`: `list`, `get`, `create`
- `comment`: `list`, `create`, `update`, `delete`
- `attachment`: `list`, `create`, `delete`

All curated commands must support:

- `--profile`
- human-readable default output
- `--json`
- `--json-envelope`

### Raw GraphQL coverage

- Support inline and file-based queries
- Support inline and file-based mutations
- Support variables via repeated key/value flags and JSON file input
- Support schema introspection via CLI
- Support exact raw GraphQL response output on raw GraphQL commands

### Schema handling

- Bundle a schema snapshot at build time
- Expose bundled schema version metadata
- Support live schema pull
- Support live-vs-bundled schema drift check
- Treat drift as warning-level behavior, not hard failure
- Preserve `linear gql` as the fallback when generated coverage is stale

### Generated layer requirements

- Live under `linear api ...`
- Be generated from the bundled schema snapshot
- Remain discoverable via CLI help and generated command documentation
- Preserve consistent auth, transport, and output semantics with curated commands
- Coexist with curated commands without namespace collision

### Output contracts

`--json`:

- Returns primary data only
- Returns object output for single-resource operations
- Returns array output for list operations
- Avoids transport/debug metadata by default

`--json-envelope`:

- Returns structured envelope with:
  - `ok`
  - `data`
  - `pageInfo`
  - `errors`
  - `meta`
- `meta` may include:
  - active profile
  - rate-limit information
  - complexity information
  - schema version
  - command source layer

Default human output:

- Optimized for readability
- Not a stable machine contract

### Pagination

- Default list behavior must be bounded and safe
- Default to first page only
- Support `--all` for autopagination
- Support `--max <n>` to cap total returned records
- Support `--page-size <n>`
- Support manual cursor continuation via `--after`
- Avoid unbounded workspace-wide enumeration by default

### Filtering and ordering

- Support common curated filter flags such as:
  - `--state`
  - `--assignee`
  - `--team`
  - `--label`
  - `--priority`
  - `--creator`
- Support full filter object passthrough via `--filter-json`
- Avoid inventing a custom filter DSL
- Support ordering controls via `--order-by` and direction flag

### Rate limits and retries

- Expose rate-limit and complexity information in envelope/debug modes
- Retry rate-limited requests with bounded exponential backoff by default
- Support retry opt-out
- Do not retry complexity-limit failures automatically

### Error handling

- Define categorized exit codes
- Distinguish at minimum:
  - auth failure
  - validation failure
  - not found
  - rate-limit exhaustion
  - generic failure
- Write human-readable errors to stderr
- In `--json`, keep stdout data-only
- In `--json-envelope`, include structured errors in the envelope
- Define partial-success handling explicitly

### File operations

- Treat file operations as explicit first-class workflows
- Support authenticated upload flow
- Support signed URL retrieval and download flow
- Handle signed URL expiration behavior explicitly
- Do not model file transfer as ordinary GraphQL output only

### Skill routing contract

AI skills must follow this execution order:

1. Use curated commands when they cover the operation well.
2. Otherwise use generated `linear api` commands.
3. Otherwise use `linear gql`.

Raw GraphQL should not be used merely because it is possible. It is the fallback for gaps or materially awkward unsupported cases.

## Required for parity but can be post-MVP

- Additional curated resources such as initiatives, milestones, documents, workflow states, webhooks, and agent/session surfaces
- JSONL streaming for large paginated outputs
- Bulk-operation commands
- Schema regeneration tooling intended for maintainers or CI
- Explicit organization/workspace selection UX for credentials spanning multiple orgs

## Explicit non-goals

- Building a TUI or GUI
- Local sync database or offline mode
- Long-running notification streaming or embedded webhook receiver process
- IDE integration
- GraphQL subscription support as a primary CLI model
- A custom filtering DSL
- Recreating the MCP server inside the CLI

## Open decisions for Round 2

The main Round 2 implementation gaps are resolved in `linear-cli-round-2-decisions.md`.

Residual product-scope decisions:

- Whether plugin/extension support exists at all
- Whether to ship `--jsonl` in MVP or shortly after
- Whether destructive curated commands should include `--dry-run` in MVP
- Whether multi-organization selector UX needs dedicated MVP treatment
