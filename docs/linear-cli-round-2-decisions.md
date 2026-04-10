# Linear CLI Round 2 Decisions

## Purpose

This document closes the main implementation gaps left open by the requirements and spec documents.

These decisions are intended to be normative for implementation unless a later revision explicitly replaces them.

## Research Basis

These decisions are based on the current Linear developer docs plus standard OAuth native-app guidance.

Key upstream facts used here:

- Linear supports OAuth authorization code flow, refresh tokens, and PKCE.
- Linear redirects back with `code` and optional `state`.
- Access tokens are short-lived and refresh tokens rotate.
- Refresh-token replay has a 30-minute grace period.
- Files are uploaded through `fileUpload` followed by an authenticated `PUT` to a pre-signed URL.
- Files hosted on `https://uploads.linear.app` can be fetched with normal Linear auth headers.
- Signed file URLs can be requested by setting `public-file-urls-expire-in` on GraphQL requests.
- Linear's GraphQL API supports introspection and the official SDK is generated from the schema.
- GraphQL responses may partially succeed and still include `errors`.

## Decisions

### 1. OAuth Callback UX

Use the OAuth authorization-code flow with PKCE for CLI login.

Required behavior:

- `linear auth login --profile <name> --oauth` starts a temporary local loopback listener.
- The CLI opens the browser to Linear's authorize URL with:
  - `response_type=code`
  - `client_id`
  - `redirect_uri`
  - `scope`
  - `state`
  - `code_challenge`
  - `code_challenge_method=S256`
- The listener binds to `127.0.0.1`, not `0.0.0.0`.
- The listener handles exactly one callback request and then exits.
- The callback path should be fixed as `/oauth/callback`.

Port behavior:

- Default to a fixed callback port in MVP: `8765`.
- Allow `--callback-port <port>` as an override for development and custom app registrations.
- If the port is already in use, fail clearly and tell the user to retry with `--callback-port`.

Rationale:

- A fixed port avoids guessing about whether Linear app registrations support arbitrary localhost ports.
- PKCE is the right default for a local CLI and removes dependence on exposing the client secret to end users.

Fallback behavior:

- `--no-browser` prints the full authorize URL.
- In `--no-browser` mode, the CLI still starts the loopback listener and waits for the browser redirect.
- If the user cannot complete a local callback flow, the CLI may support manual paste of the full redirected callback URL later, but that is not required for MVP.

Validation rules:

- `state` must be checked and mismatches fail closed.
- The callback must include `code`; otherwise login fails.
- After token exchange, the CLI must call `viewer` before persisting credentials.

### 2. OAuth Storage And Refresh Rules

MVP decision:

- Store OAuth access tokens, refresh tokens, and expiry timestamps in the credentials file.
- Do not ship keychain-backed OAuth storage in MVP.

Why:

- The docs already establish the credentials file as the primary runtime source of truth.
- Deferring keychain support removes a large amount of platform-specific behavior and refresh-write ambiguity.

Refresh behavior:

- Refresh only when the access token is expired or about to expire within 5 minutes.
- Refresh requests must use the same OAuth app configuration as login.
- On successful refresh, write the new access token, new refresh token, and new expiry atomically to the credentials file.
- On refresh failure, preserve the existing stored credentials and surface an auth error.
- If the refresh HTTP request succeeds but the CLI fails before persisting the new refresh token, one replay attempt using the same original refresh request is allowed because Linear documents a 30-minute replay grace period.

Credentials fields for OAuth profiles:

- `type = oauth`
- `access_token`
- `refresh_token`
- `expires_at`
- `scopes`
- `oauth_client_id`

Config fields for OAuth profiles:

- `workspace`
- `workspace_id`
- `user_email`
- `oauth_redirect_uri`

### 3. Config And Credentials Shape

Adopt the AWS-style file model already proposed in the other docs and make the examples normative.

Paths:

- config: `~/.config/linear/config`
- credentials: `~/.config/linear/credentials`

Required sections:

- `[default]` in config stores only `profile = <name>`
- `[profile <name>]` in config stores non-secret metadata
- `[<name>]` in credentials stores secrets and auth material

Rules:

- Profile names must match exactly across files.
- Unknown config keys are allowed and ignored.
- Unknown credential keys are allowed but must never be emitted back to stdout.
- Credentials writes must be atomic and file permissions must be restrictive.

### 4. Generated Command Naming Rules

Generated commands are derived from root GraphQL fields from the bundled schema snapshot.

Resource naming:

- Start from the root field name.
- Convert camelCase to kebab-case.
- Remove action prefixes and suffixes to isolate the resource stem.
- Compound stems remain compound kebab-case.

Operation naming:

- query fields:
  - singular lookup by `id` or identifier-like arg -> `get`
  - plural connection/list field -> `list`
  - singular non-id lookup that is clearly a search helper -> preserve the field name as the operation name
- mutation fields:
  - `*Create` -> `create`
  - `*Update` -> `update`
  - `*Delete` -> `delete`
  - `*Archive` -> `archive`
  - `*Unarchive` -> `unarchive`
  - other verbs keep their explicit verb, in kebab-case if needed

Examples:

- `issue` query -> `linear api issue get`
- `issues` query -> `linear api issue list`
- `projectMilestoneCreate` mutation -> `linear api project-milestone create`
- `attachmentDelete` mutation -> `linear api attachment delete`
- `attachmentsForURL` query -> `linear api attachment for-url`

Collision rule:

- If multiple root fields would map to the same `<resource> <operation>`, keep the most canonical one on the short name and assign the others explicit operation names derived from the original field name.

Canonicality order:

1. exact singular/plural resource field
2. plain CRUD mutation
3. helper or specialized lookup field

### 5. Generated Command Manifest

Generation must emit a machine-readable manifest alongside generated command code.

Recommended file:

- `src/generated/manifest/commands.json`

Each manifest entry must include:

- `commandPath`: `"linear api issue create"`
- `resource`: `"issue"`
- `operation`: `"create"`
- `graphqlField`: original root field name
- `graphqlOperationType`: `query` or `mutation`
- `description`
- `inputMode`: one of `id`, `json`, `id-plus-json`, `none`
- `requiredArgs`
- `optionalArgs`
- `inputTypeName` when applicable
- `returnTypeName`
- `supportsFields`: boolean
- `deprecation`: null or structured deprecation info

The CLI should use this manifest for:

- help generation
- `linear api --help`
- `linear api <resource> --help`
- `linear api search <term>`

### 6. Input Mapping For Generated Commands

Generated commands remain JSON-primary.

Normative mapping:

- single-target queries and mutations with a top-level `id` argument use `--id`
- input-object arguments use `--input-json`, `--input-file`, or `--input-stdin`
- commands with both an `id` and an input object use both `--id` and one JSON input source
- generated commands do not emit field-level flags for schema fields

This resolves the flags-vs-JSON decision in favor of bounded JSON input blobs.

### 7. Curated Output Contract

Curated commands must have stable, normalized output.

Normative rules:

- `get` commands return one object
- `list` commands return an array of objects
- `create`, `update`, `close`, `assign`, and similar single-resource mutations return the resulting resource object, not the raw GraphQL payload wrapper
- `delete` commands return a minimal object with the target ID and mutation outcome fields only when there is no surviving resource to normalize
- file commands return small explicit objects described below

Curated object shape rules:

- include stable high-value fields only
- do not mirror every GraphQL field by default
- prefer IDs, human identifiers, names, state, timestamps, and key related references
- nested related objects must stay shallow and stable

Example stable issue object:

```json
{
  "id": "2f2d...",
  "identifier": "INF-2975",
  "title": "Fix login",
  "description": "...",
  "priority": 2,
  "state": { "id": "...", "name": "In Progress", "type": "started" },
  "team": { "id": "...", "key": "INF", "name": "Infrastructure" },
  "assignee": { "id": "...", "name": "Quentin", "email": "quentin@example.com" },
  "creator": { "id": "...", "name": "Quentin", "email": "quentin@example.com" },
  "project": { "id": "...", "name": "Auth hardening" },
  "labels": [{ "id": "...", "name": "bug" }],
  "url": "https://linear.app/...",
  "createdAt": "2026-04-09T10:00:00Z",
  "updatedAt": "2026-04-09T11:00:00Z"
}
```

### 8. Partial Success Semantics

Treat partial success differently by layer.

Curated commands:

- Fail closed if the GraphQL response includes `errors`.
- In `--json`, write nothing to stdout on failure.
- In `--json-envelope`, return `ok: false`, `data: null`, and structured `errors`.
- Exit with the most specific mapped exit code.

Generated commands:

- Follow the same fail-closed behavior as curated commands.
- Do not emit partial GraphQL `data` in normal `--json` mode.

Raw GraphQL commands:

- `--raw` returns the exact GraphQL body, including partial `data` and `errors`.
- `--json` returns only the `data` payload on success.
- If `errors` are present, `--json` exits non-zero and does not emit partial data.
- `--json-envelope` may include both `data` and `errors` for raw GraphQL commands.

This keeps curated and generated commands script-safe while preserving a debugging and parity escape hatch in `linear gql`.

### 9. File Upload Flow

`linear file upload <path>` is a transport-special command with this sequence:

1. Read local file metadata: name, byte size, content type.
2. Call the GraphQL `fileUpload` mutation to obtain:
   - `uploadUrl`
   - `assetUrl`
   - required upload headers
3. `PUT` the file bytes to `uploadUrl` with the exact returned headers plus the file content.
4. On success, return the `assetUrl`.

If `--issue <id-or-identifier>` is passed:

5. Resolve the issue target.
6. Call `attachmentCreate` using the uploaded `assetUrl` as the attachment URL and the basename as the default title unless overridden.
7. Return both the uploaded asset information and the created attachment summary.

Why this design:

- It follows Linear's documented upload flow.
- It gives the CLI a first-class file command while still integrating with issue workflows.

Default `--json` output without `--issue`:

```json
{
  "assetUrl": "https://uploads.linear.app/...",
  "contentType": "image/png",
  "fileName": "screenshot.png",
  "size": 182044
}
```

Default `--json` output with `--issue`:

```json
{
  "assetUrl": "https://uploads.linear.app/...",
  "contentType": "image/png",
  "fileName": "screenshot.png",
  "size": 182044,
  "attachment": {
    "id": "...",
    "title": "screenshot.png",
    "url": "https://uploads.linear.app/..."
  },
  "issue": {
    "id": "...",
    "identifier": "INF-2975"
  }
}
```

### 10. File URL And Download Flow

`linear file url <attachment-id>`:

- Fetches the attachment using a GraphQL request that includes `public-file-urls-expire-in`.
- Default signed URL lifetime in MVP: 60 seconds.
- Allow `--expires-in <seconds>` override with a bounded max of 3600 seconds.

`linear file download <url>`:

- If the URL is an `uploads.linear.app` URL, download it directly with the active profile's auth header.
- If the URL already includes a valid signature, plain unauthenticated GET is allowed first.
- If a signed URL fails due to expiry and the original unsigned storage URL can be recovered safely, retry with authenticated GET against the unsigned `uploads.linear.app` URL.
- Non-Linear URLs are out of scope and should fail validation.

This means the CLI does not need a separate signed-URL refresh mutation just to download a known Linear storage URL.

### 11. Complexity And Deprecation Policy

Complexity warnings:

- Do not introduce a separate warning mode in MVP.
- Surface complexity metadata only in verbose or `--json-envelope` modes.
- Fail only when Linear itself rejects the request.

Deprecations:

- Generated help should show schema deprecation notices when present.
- Curated commands must avoid deprecated fields when a stable alternative exists.
- Deprecations are release-review items, not runtime hard failures.

### 12. Implementation Language

Implementation language is now definitively TypeScript.

This is no longer an open decision.

### 13. Runtime, Tooling, And Distribution

Use Bun as the default runtime and packaging tool for the project.

Normative decisions:

- Bun is the default package manager, task runner, and local development runtime.
- Released builds should be packaged as standalone binaries for supported target platforms.
- End users of release artifacts should not need Bun installed.
- The source code should stay largely standard TypeScript and standard runtime APIs unless Bun-specific functionality provides a clear implementation or distribution advantage.
- Packaged binary behavior must be validated in CI with at least smoke-level coverage.

This keeps Bun's strong packaging story while reducing lock-in inside the business logic of the CLI.

## Remaining Open Items After These Decisions

These items remain intentionally open because they are product-scope choices rather than blocking specification gaps:

- whether to ship `--jsonl` in the first public release or immediately after
- whether destructive curated commands should include `--dry-run` in MVP
- whether multi-organization selection needs dedicated UX in MVP
- whether plugin or extension support exists at all
