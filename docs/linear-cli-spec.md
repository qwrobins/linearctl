# Linear CLI Spec

## Overview

The `linear` CLI is organized into three explicit layers:

1. Curated commands: `linear <resource> ...`
2. Generated API commands: `linear api ...`
3. Raw GraphQL commands: `linear gql ...`

These layers share auth, transport, pagination, retry, and output infrastructure.

The implementation details that were intentionally left open in the first spec pass are resolved in `linear-cli-round-2-decisions.md`. That document is normative for OAuth callback behavior, generated command naming, generated manifest shape, partial-success handling, file flows, and curated output normalization.

## CLI Layers

### Curated commands

Purpose:

- ergonomic, stable workflows
- human-friendly flags
- name/identifier resolution where practical
- stable machine-facing output contracts

Examples:

- `linear issue list --team "Infrastructure" --state "In Progress"`
- `linear issue get INF-2975 --json`
- `linear issue create --title "Fix login" --team "Infrastructure"`

### Generated API commands

Purpose:

- broad schema-backed API coverage
- explicit parity namespace
- less ergonomic but highly discoverable and systematic

Namespace shape:

- `linear api <resource> <operation>`

Examples:

- `linear api issue create --input-json '{"title":"Fix login","teamId":"abc"}'`
- `linear api project-milestone list --input-json '{"filter":{"name":{"contains":"Beta"}}}'`

Design rules:

- resource names are kebab-case GraphQL resource names
- operations are derived action verbs such as `list`, `get`, `create`, `update`, `delete`, `archive`
- compound GraphQL resources become compound kebab-case resources, such as `project-milestone`
- generated commands do not silently merge into curated namespaces

### Raw GraphQL commands

Purpose:

- total control
- immediate parity backstop
- lowest-level escape hatch

Examples:

- `linear gql query '{ viewer { id name } }' --json`
- `linear gql mutation --file issue-create.graphql --vars-file vars.json --json-envelope`

## Generated Command Interface

### Primary input model

Generated commands are JSON-primary.

Supported command-specific inputs:

- `--id <id>` for single-resource target operations where applicable
- `--input-json '<json>'`
- `--input-file <path>`
- `--input-stdin`
- `--fields <comma-separated>`

Generated commands must not generate arbitrary field-level flags for every schema field.

Rationale:

- prevents flag explosion
- avoids collision across many input types
- keeps maintenance bounded as schema changes
- matches the native shape of GraphQL input objects

## Curated Command Interface

Curated commands are flag-first and ergonomic.

Rules:

- common fields get explicit flags
- curated commands may also support `--input-json` as an escape hatch for advanced inputs
- if the same field appears both in flags and `--input-json`, explicit flags win
- curated commands may resolve friendly names or identifiers to IDs internally

Examples:

- `linear issue create --title "Bug" --team "Infra" --priority high`
- `linear issue update INF-2975 --state "Done"`

## Config And Credentials Layout

Recommended layout:

- `~/.config/linear/config`
- `~/.config/linear/credentials`

Rules:

- config stores defaults and non-secret profile metadata
- credentials stores API keys and OAuth token material
- credentials format is INI-style with AWS-like profile sections
- profile names are shared across both files
- runtime command execution uses the resolved stored profile credentials by default
- env vars are primarily for login/bootstrap, not the primary runtime credential source
- runtime lookup in MVP uses the credentials file for the resolved profile
- a post-MVP OAuth keychain fallback may be added later, but only if no file credentials exist for that profile

Example credentials file:

```ini
[default]
type = api_key
api_key = lin_api_xxx

[work]
type = oauth
access_token = lin_access_xxx
refresh_token = lin_refresh_xxx
expires_at = 2026-04-07T18:45:00Z
```

Expanded credentials examples:

```ini
[default]
type = api_key
api_key = lin_api_default_xxx

[work]
type = api_key
api_key = lin_api_work_xxx

[work-oauth]
type = oauth
access_token = lin_access_work_xxx
refresh_token = lin_refresh_work_xxx
expires_at = 2026-04-07T18:45:00Z
```

Example config file:

```ini
[default]
profile = work

[profile work]
workspace = main
```

Expanded config examples:

```ini
[default]
profile = work-oauth

[profile default]
workspace = personal
workspace_id = 11111111-1111-1111-1111-111111111111

[profile work]
workspace = main
workspace_id = 22222222-2222-2222-2222-222222222222

[profile work-oauth]
workspace = main
workspace_id = 22222222-2222-2222-2222-222222222222
user_email = quentin@example.com
```

Recommended profile metadata fields in `config`:

- `workspace`
- `workspace_id`
- `user_email`

Recommended credential fields in `credentials`:

- `type`
- `api_key`
- `access_token`
- `refresh_token`
- `expires_at`

## Discoverability

Generated-layer discoverability must support all of the following:

### Top-level help

- `linear api --help` lists available generated resource groups

### Resource help

- `linear api <resource> --help` lists available operations for that resource

### Operation help

- `linear api <resource> <operation> --help` shows:
  - mapped GraphQL operation name
  - required fields
  - optional fields
  - field descriptions from schema docs
  - usage examples

### Search

- `linear api search <term>` performs fuzzy search across generated resources and operations

## IDs, Names, and Identifiers

### Curated layer

Curated commands should accept human-friendly values where practical.

Examples:

- issue identifier such as `INF-2975`
- team name such as `Infrastructure`
- label name such as `bug`
- assignee special value `me`

Resolution rules:

- resolve friendly values to IDs internally
- do not guess when ambiguous
- on ambiguity, error and show matches
- on failure, suggest direct ID usage

### Generated layer

Generated commands should be strict and ID-oriented unless the underlying GraphQL operation naturally accepts non-ID scalar values.

Generated commands do not implement convenience name resolution.

## Stdin and Pipe Behavior

### Supported stdin patterns

Raw GraphQL:

- `linear gql query --stdin`
- `linear gql mutation --stdin`

Curated and generated JSON input:

- `--input-stdin`

Rules:

- `--stdin` and `--input-stdin` require piped input, not interactive TTY input
- stdout is reserved for command data output
- stderr is reserved for warnings and errors
- this separation must make piping to tools like `jq` reliable

### Auth stdin behavior

Auth commands must never read secrets from stdin implicitly.

If stdin support exists for secrets, it must be explicit, such as `--api-key-stdin`.

## Output Modes

### Human mode

- default mode
- readable tables and summaries
- not a stable contract

### `--json`

- data-first output
- no transport envelope by default
- suitable for scripts and skill consumption

Output expectations:

- single-resource curated commands return a single object
- list curated commands return an array
- generated commands return normalized data output for the selected operation
- raw GraphQL commands in normal `--json` mode return the parsed GraphQL `data` payload only
- raw GraphQL commands require an explicit output mode: `--json`, `--json-envelope`, or `--raw`

### `--json-envelope`

Includes:

- `ok`
- `data`
- `pageInfo`
- `errors`
- `meta`

Possible meta fields:

- profile
- rate-limit status
- complexity usage
- schema version
- command source layer

### `--raw`

- only for `linear gql`
- returns exact GraphQL response body
- bypasses normalization

## Output Stability Contract

- curated command output is a stable contract and the preferred target for AI skills
- generated command output is schema-dependent and may evolve with schema changes
- raw GraphQL output is only stable if the caller controls the query

## Pagination

Defaults:

- first page only
- safe bounded behavior

Flags:

- `--all`
- `--max <n>`
- `--page-size <n>`
- `--after <cursor>`

Rules:

- default list commands must not enumerate entire workspaces implicitly
- `--all` enables autopagination
- `--max` caps total items across pages
- in `--json`, autopaginated list output is one flattened array
- in `--json-envelope`, `pageInfo` reflects the final fetched page

## Filtering and Ordering

Curated commands support common flags for common cases.

Examples:

- `--state`
- `--assignee`
- `--team`
- `--label`
- `--priority`
- `--creator`

Full coverage is available through:

- `--filter-json '<json>'`

Ordering:

- `--order-by <field>`
- `--order-dir asc|desc`

## Rate Limits and Complexity

Default behavior:

- retry rate-limited requests with bounded exponential backoff and jitter
- do not retry complexity-limit failures automatically

Controls:

- `--no-retry`
- `--max-retries <n>`

Observability:

- show rate-limit and complexity information in `--json-envelope`
- optionally emit retry/warning details in verbose mode

## Error Handling and Exit Codes

Exit codes:

- `0`: success
- `1`: general error
- `2`: authentication error
- `3`: rate-limit exhaustion after retries
- `4`: not found
- `5`: validation/input error
- `6`: schema drift or generated-command schema mismatch

Rules:

- human-readable errors go to stderr
- `--json` keeps stdout data-only
- `--json-envelope` may include structured errors
- partial success must be handled explicitly and documented

## File Operations

Required commands:

- `linear file upload <path> [--issue <id-or-identifier>]`
- `linear file download <url> [--output <path>]`
- `linear file url <attachment-id>`

Rules:

- upload flow must handle authenticated file upload and any necessary attachment linkage
- download flow must handle signed URL retrieval and expiry refresh logic
- file transfer behavior is transport-special and not treated as ordinary GraphQL output only

## Schema Freshness

Required commands:

- `linear schema pull`
- `linear schema version`
- `linear schema check`

Rules:

- CLI bundles a schema snapshot at build time
- generated commands are guaranteed against that snapshot, not arbitrarily newer live schemas
- schema drift should be surfaced clearly
- users must have a fallback path through `linear gql`
