# Linear CLI Auth And Safety

## Auth Model

The CLI must support two credential types:

- personal API keys
- OAuth tokens with refresh-token support

Each named profile maps to one credential set.

## Profile Resolution

Resolution order:

1. `--profile <name>`
2. `LINEAR_PROFILE`
3. configured default profile
4. error

The CLI must never silently select the first available profile.

## Required Auth Commands

- `linear auth login --profile <name> --api-key-env <ENV>`
- `linear auth login --profile <name> --oauth`
- `linear auth logout --profile <name>`
- `linear auth status`
- `linear auth switch <name>`

If stdin-based secret input is supported, it must be explicit, such as `--api-key-stdin`.

## Secret Handling

- Never accept secret values as ordinary CLI arguments.
- Prefer an AWS-style credentials file as the primary storage model.
- Store credentials in a dedicated credentials file with profile sections and restrictive permissions.
- Keep non-secret profile metadata in a separate config file when practical.
- Allow env-based bootstrap at login time, but do not depend on env vars for normal command execution.
- Avoid logging secrets in stdout, stderr, shell history, or process listings.

## Credentials File Model

Recommended shape:

- config file for non-secret defaults and profile metadata
- credentials file for API keys, OAuth access tokens, and refresh tokens

Recommended layout:

- `~/.config/linear/config`
- `~/.config/linear/credentials`

AWS-style example:

```ini
[default]
type = api_key
api_key = lin_api_xxx

[work-oauth]
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

[secondary-oauth]
type = oauth
access_token = lin_access_secondary_xxx
refresh_token = lin_refresh_secondary_xxx
expires_at = 2026-04-08T09:15:00Z
```

Example config file:

```ini
[default]
profile = work-oauth

[profile work-oauth]
workspace = main

[profile reporting]
workspace = analytics
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

[profile secondary-oauth]
workspace = consulting
workspace_id = 33333333-3333-3333-3333-333333333333
user_email = quentin+consulting@example.com
```

Files must be created with restrictive permissions.

Formatting rules:

- use INI-style sections similar to AWS CLI
- credentials live in `credentials`
- non-secret defaults and profile metadata live in `config`
- section names are profile names shared across both files
- `default` is a normal profile name and may be used as the configured default

Recommended per-profile metadata fields in `config`:

- `workspace`
- `workspace_id`
- `user_email`
- `base_url` if ever needed for testing or future overrides

Recommended credential fields in `credentials`:

- `type`
- `api_key`
- `access_token`
- `refresh_token`
- `expires_at`

## Credential Precedence

Runtime credential lookup should follow this order for the resolved profile:

1. credentials file entry in `~/.config/linear/credentials`
2. error in MVP

If OAuth keychain support is added after MVP, it may be consulted only when no credentials-file entry exists for the resolved profile.

Additional rules:

- credentials file is the primary runtime source of truth
- keychain is allowed only as a post-MVP secondary storage backend for OAuth
- API keys are expected to come from the credentials file, not the keychain
- env vars are bootstrap inputs for login, not part of normal runtime precedence
- if both credentials-file and keychain OAuth credentials exist for the same profile, the credentials file wins

## OAuth Behavior

- Access tokens are short-lived.
- In MVP, refresh tokens are stored in the credentials file.
- If keychain support is added later, the credentials file still remains the first runtime lookup source.
- Expired access tokens should auto-refresh when possible.
- Failed refresh must produce a clear auth error.

If keychain is used for OAuth:

- it should be keyed by profile name
- it should only be consulted when the credentials file has no credential material for that profile
- refreshed OAuth tokens should update the active storage backend consistently

## Multi-Account Safety

- Multiple profiles are a first-class supported use case.
- The CLI must make the active profile inspectable.
- Commands should support explicit `--profile` override.
- Ambiguity around active profile must fail closed, not guess.

## Name Resolution Safety

Curated commands may resolve user-friendly values such as issue identifiers, team names, and labels.

Safety rules:

- if the value is ambiguous, error and show candidates
- do not guess the closest match
- suggest direct ID usage when resolution fails

Generated commands do not perform convenience name resolution.

## Output Safety

- Default human output is for people, not machines.
- `--json` is the primary machine-readable contract.
- `--json-envelope` should be used only when metadata is needed.
- Errors should go to stderr so stdout remains pipe-safe.

## Pagination Safety

- Default list operations must be bounded.
- Do not auto-paginate everything by default.
- Require explicit `--all` for full enumeration.
- Encourage `--max` and filtering for large data sets.

## Destructive Operations

Examples:

- delete
- archive
- bulk mutation flows

Safety expectations:

- require explicit user intent before destructive actions
- consider `--dry-run` support for curated destructive commands
- do not silently perform mass destructive changes

## Rate Limit Safety

- Retry rate-limited requests with bounded backoff
- Do not retry forever
- Surface exhaustion clearly to users and skills
- Encourage narrower queries after repeated broad enumerations

## Schema Drift Safety

- Generated commands depend on bundled schema freshness
- Drift should surface clearly
- Raw GraphQL remains the fallback path
- Schema mismatch should be distinguishable from ordinary validation failure
