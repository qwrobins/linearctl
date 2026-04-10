# Linear CLI Testing Strategy

## Purpose

This document defines the testing strategy for the `linear` CLI implementation.

The goal is to protect:

- auth and profile correctness
- stable curated command behavior
- generated command correctness against the bundled schema
- output contracts used by scripts and AI skills
- retry, pagination, and error handling behavior
- file upload/download flows

## Testing Layers

Use four layers of testing:

1. unit tests
2. contract and golden tests
3. integration tests
4. CI schema-drift checks

## Recommended Tooling

Because the implementation recommendation is TypeScript:

- use `vitest` for unit and golden tests
- use snapshot or golden-file assertions for help text and JSON output
- use a small fixture library for config, credential, and API-response samples
- run integration tests separately from fast unit tests

## Unit Tests

Unit tests should cover logic that does not require live Linear API access.

### Auth and profile resolution

- `--profile` overrides environment and config
- `LINEAR_PROFILE` overrides configured default
- configured default is used when no explicit override exists
- error when multiple profiles exist and none is resolved
- credentials file lookup is the MVP runtime auth path
- if keychain fallback is added later, it is used only for OAuth and only when file credentials are absent
- invalid profile names fail clearly

### Config and credentials parsing

- AWS-style INI parsing for `config`
- AWS-style INI parsing for `credentials`
- shared profile names across files
- missing or malformed sections fail cleanly
- file permission checks for credentials file

### Output behavior

- `--json` returns data-only output
- `--json-envelope` returns the expected envelope shape
- human output never leaks into machine modes
- stderr/stdout separation stays clean

### Pagination and filtering

- default list behavior is bounded
- `--all` and `--max` interact correctly
- `--page-size` validation works
- named filter flags are mutually exclusive with `--filter-json`

### Error handling

- exit code mapping for auth, rate-limit, validation, not found, schema drift, generic failure
- partial-success behavior
- normalized stderr formatting for common error types

### Retry behavior

- rate-limit retries follow bounded exponential backoff
- complexity errors are not retried
- `--no-retry` disables retry logic

### Name resolution

- issue identifier resolution
- team/label/user/state name resolution
- ambiguity produces an error, never guessing
- `me` resolves to viewer in curated flows

## Contract And Golden Tests

Golden tests should protect user-visible and skill-visible behavior that must stay stable.

### Help output

- curated top-level help
- curated resource help
- generated resource help
- generated operation help
- `linear api search` output shape

### JSON output contracts

- curated single-resource `--json`
- curated list `--json`
- curated mutation result `--json`
- `--json-envelope` shape for curated commands
- generated command `--json` shape for representative operations

### Error text contracts

- auth failure message
- not found message
- ambiguity message
- schema drift message

Golden coverage matters because AI skills may depend on predictable command help and output structures.

## Integration Tests

Integration tests should run against a dedicated Linear test workspace and dedicated test credentials.

Do not run integration tests against a personal or production workspace.

### Required test environment

- one dedicated Linear test workspace
- one API-key-based test profile
- one OAuth-based test profile if OAuth flows are implemented in CI-capable form
- seeded data for teams, labels, projects, and issues

### Curated command flows

- list issues with filters
- get issue by identifier
- create issue
- update issue
- close issue
- add comment to issue
- create and remove attachment

### Generated command flows

- representative list operation
- representative get operation
- representative create/update operation using `--input-json`
- generated help and field metadata behavior

### Raw GraphQL flows

- inline query
- file-based query
- stdin-based query
- variables from file

### Schema commands

- `linear schema version`
- `linear schema pull`
- `linear schema check`

### File flows

- upload file
- fetch signed URL
- download uploaded file
- expired signed URL refresh behavior if feasible to simulate

### Error-path integration tests

- invalid credentials
- missing profile
- not found resource
- malformed input JSON
- rate-limit handling if feasible in controlled tests

## OAuth Testing

OAuth needs separate treatment because browser redirects and refresh behavior are harder to automate.

Recommended split:

- unit tests for token refresh logic and storage behavior
- integration tests for refresh behavior using seeded tokens or mocked OAuth callback flow
- limited manual verification for the full browser-based login flow if end-to-end automation is too expensive initially

## Generated Layer Testing

Because `linear api` is schema-driven, testing must validate both generator behavior and runtime behavior.

### Generator tests

- operation name to command-name conversion
- compound resource naming such as `project-milestone`
- help-text generation from schema descriptions
- required/optional field extraction
- `--fields` handling

### Runtime tests

- generated command execution using bundled schema
- schema mismatch produces exit code `6`
- generated commands do not expose field-exploded flags

## Fixtures

Create reusable fixtures for:

- config file contents
- credentials file contents
- parsed schema excerpts
- GraphQL success responses
- GraphQL partial-success responses
- GraphQL error responses
- rate-limit responses
- schema drift scenarios

Keep fixture data synthetic and non-secret.

## CI Strategy

Split CI into at least three jobs:

### Fast job

- lint
- typecheck
- unit tests

### Contract job

- golden tests
- generated help/output contract tests

### Integration job

- live API integration tests against a dedicated test workspace
- optional/manual gating for OAuth browser flow if needed

## Schema Drift Checks In CI

Add a maintenance-oriented CI check that:

- pulls the latest live schema
- compares it to the bundled schema snapshot
- reports added, removed, and deprecated fields/types
- warns when generated command coverage may need regeneration

This is not a substitute for runtime `linear schema check`; it protects maintainers before release.

## Release Gates

Recommended minimum release gates:

- all unit tests passing
- all golden tests passing
- core integration tests passing
- no unreviewed schema drift for the generated layer

## High-Priority Test Cases

If implementation time is tight, prioritize these first:

1. profile resolution precedence
2. credentials-file-first auth lookup
3. curated `--json` output stability
4. generated command naming and help generation
5. exit code correctness
6. default bounded pagination
7. rate-limit retry behavior
8. schema drift exit code `6`
9. file upload/download happy path

## Nice-To-Have Tests

- performance tests for large auto-paginated result sets
- fuzz tests for malformed `--filter-json`
- snapshot tests for `linear api search` ranking output
- end-to-end browser automation for OAuth login
