# Linear CLI Auth UX

## Purpose

This document specifies the user-facing behavior of `linear auth` commands.

It covers:

- login with API key
- login with OAuth
- auth status
- profile switching
- logout
- expected prompts, outputs, and edge cases

## Storage Model

The auth UX assumes:

- non-secret profile metadata in `~/.config/linear/config`
- credentials in `~/.config/linear/credentials`
- credentials-file storage in MVP
- optional OAuth keychain fallback only as a post-MVP extension when file credentials do not exist for the resolved profile

## Commands

### `linear auth login`

Supports two modes:

- API key login
- OAuth login

### API key login

Preferred forms:

```bash
linear auth login --profile work --api-key-env LINEAR_API_KEY
linear auth login --profile work --api-key-stdin
```

Rules:

- `--profile` is required
- `--api-key-env <ENV>` reads the key from the named environment variable
- `--api-key-stdin` reads the key from stdin
- `--api-key-env` and `--api-key-stdin` are mutually exclusive
- plain `--api-key <value>` must not exist

Behavior:

1. Read the key from the requested source.
2. Validate it by making a lightweight authenticated request such as `viewer`.
3. On success, write the credential into the credentials file under the named profile.
4. If the profile does not exist in config, create a minimal matching config section if useful.
5. Optionally offer or support `--set-default` to make it the default profile.

Success example:

```text
Logged in to Linear as profile "work" using API key authentication.
Workspace: main
User: quentin@example.com
```

Failure example:

```text
Error: authentication failed (exit 2)
  The API key from LINEAR_API_KEY is invalid.
```

### OAuth login

Preferred form:

```bash
linear auth login --profile work-oauth --oauth
```

Optional forms may include:

```bash
linear auth login --profile work-oauth --oauth --set-default
linear auth login --profile work-oauth --oauth --no-browser
```

Rules:

- `--profile` is required
- `--oauth` is required for OAuth mode
- browser-based flow is the default
- a non-browser fallback may exist for manual code entry if needed

Recommended behavior:

1. Start OAuth flow.
2. Open browser to Linear authorization page.
3. Receive callback locally or accept pasted code in fallback mode.
4. Exchange code for access token and refresh token.
5. Validate token with `viewer`.
6. Store token material in the credentials file for MVP.
7. Record useful metadata such as workspace and user email in config.
8. Optionally set default profile.

Success example:

```text
Logged in to Linear as profile "work-oauth" using OAuth.
Workspace: main
User: quentin@example.com
Token expires: 2026-04-07T18:45:00Z
```

Failure example:

```text
Error: authentication failed (exit 2)
  OAuth authorization was cancelled before completion.
```

## `linear auth status`

Purpose:

- show configured profiles
- show which profile is default
- show auth type per profile
- show expiry state for OAuth profiles
- show whether credentials come from the credentials file in MVP
- if keychain fallback is added later, also show that source explicitly

Default output should be human-readable.

Example:

```text
Default profile: work-oauth

Profiles:
  default
    Type: api_key
    Workspace: personal
    Source: credentials file

  work
    Type: api_key
    Workspace: main
    Source: credentials file

  work-oauth
    Type: oauth
    Workspace: main
    User: quentin@example.com
    Expires: 2026-04-07T18:45:00Z
    Source: credentials file
```

JSON mode should also be supported:

```bash
linear auth status --json
```

Suggested JSON shape:

```json
{
  "defaultProfile": "work-oauth",
  "profiles": [
    {
      "name": "work-oauth",
      "type": "oauth",
      "workspace": "main",
      "userEmail": "quentin@example.com",
      "expiresAt": "2026-04-07T18:45:00Z",
      "source": "credentials-file"
    }
  ]
}
```

## `linear auth switch`

Purpose:

- set the default profile in config

Usage:

```bash
linear auth switch work
```

Behavior:

1. Verify the named profile exists.
2. Update the default profile in config.
3. Do not modify credentials.

Success example:

```text
Default Linear profile set to "work".
```

Failure example:

```text
Error: validation failed (exit 5)
  Profile "work" does not exist.
```

## `linear auth logout`

Purpose:

- remove stored credentials for a profile
- optionally remove matching profile metadata

Usage:

```bash
linear auth logout --profile work
linear auth logout --profile work --remove-config
```

Behavior:

1. Remove credential material for the named profile from the credentials file.
2. If post-MVP OAuth keychain storage exists for that profile, remove it too.
3. Leave config metadata in place by default.
4. If `--remove-config` is passed, remove matching config metadata too.
5. If the removed profile was the default, clear the default or require explicit reassignment.

Success example:

```text
Logged out profile "work".
Credentials removed.
```

## Edge Cases

### Missing profile on login

- login should create the credential entry for the requested profile
- config metadata may be created minimally if needed

### Existing profile on login

- re-login should overwrite credential material for that profile
- preserve non-secret config metadata unless explicitly changed

### Multiple profiles with no default

- normal runtime commands should error until the user picks one or passes `--profile`

### Expired OAuth token

- runtime commands should auto-refresh where possible
- `auth status` should still show expiry state clearly

### Invalid credentials file permissions

- CLI should warn or error and instruct the user to fix permissions

## UX Rules

- never echo secrets
- keep success output concise
- keep failure output actionable
- stderr for failures, stdout for successful structured output
- avoid interactive prompts unless explicitly in an interactive auth flow

## Future Optional Flags

- `--set-default` on login
- `--no-browser` for OAuth manual flow
- `--remove-config` on logout
- `--json` on all auth commands where structured output is useful
