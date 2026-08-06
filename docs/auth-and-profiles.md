# Auth and profiles

## Named profiles

The CLI uses named profiles to manage credentials for one or more Linear workspaces. Each profile stores an API key or OAuth token set. You must create a profile before running any data command.

Profiles are stored in the credentials file (`~/.config/linear/credentials`). Profile metadata (workspace name, default selection) is stored in the config file (`~/.config/linear/config`). See [File layout](#file-layout) below for the full INI structure.

On Windows these resolve to `%USERPROFILE%\.config\linear\credentials` and `%USERPROFILE%\.config\linear\config`.

## API key auth

Create an API key at [Linear API settings](https://linear.app/settings/api).

Store the key in an environment variable and pass the variable name (not the key itself):

```bash
export LINEAR_API_KEY=lin_api_...
linearctl auth login --profile work --api-key-env LINEAR_API_KEY
```

PowerShell:

```powershell
$env:LINEAR_API_KEY = "lin_api_..."
linearctl auth login --profile work --api-key-env LINEAR_API_KEY
```

Or pipe via stdin:

```bash
echo "$LINEAR_API_KEY" | linearctl auth login --profile work --api-key-stdin
```

The CLI never accepts API keys as plain command-line arguments. This prevents secrets from appearing in shell history and process listings.

## OAuth auth

OAuth uses the PKCE authorization code flow with a local loopback callback server.

You need an OAuth application client ID. Create one at [Linear API applications](https://linear.app/settings/api/applications), and register `http://127.0.0.1:8765/oauth/callback` as the redirect URI.

```bash
linearctl auth login --profile work --oauth --oauth-client-id <client-id>
```

This:
1. Starts a local HTTP server on `127.0.0.1:8765`
2. Opens your browser to the Linear authorization page
3. Receives the callback with the authorization code
4. Exchanges the code for access and refresh tokens

Options:
- `--callback-port <port>` -- override the default port (8765)
- `--no-browser` -- print the authorization URL instead of opening it

### Token refresh

OAuth tokens expire. The CLI auto-refreshes expired tokens during profile resolution (within a 5-minute window before expiry). Refreshed tokens are written back to the credentials file. Refresh, login, and logout updates are serialized across CLI processes so concurrent commands cannot overwrite one another's credential changes.

## Setting the default profile

```bash
# During login
linearctl auth login --profile work --api-key-env LINEAR_API_KEY --set-default

# After login
linearctl auth switch work
```

## Profile resolution order

When a command needs authentication, the CLI resolves the profile in this order:

1. `--profile <name>` flag on the command
2. `LINEAR_PROFILE` environment variable
3. Configured default profile (set via `--set-default` or `auth switch`)
4. Error with a list of available profiles

The CLI never silently chooses among multiple profiles. If resolution is ambiguous, it errors and lists available profiles with workspace context.

## Status and introspection

```bash
# List all profiles with auth type and workspace
linearctl auth status --json

# Show current user and organization for the active profile
linearctl auth whoami --json

# List workspaces accessible to the active profile
linearctl workspace list --json
```

## Logout

```bash
# Remove credentials for a profile
linearctl auth logout --profile work

# Also remove config metadata
linearctl auth logout --profile work --remove-config
```

## File layout

The CLI stores configuration in two AWS CLI-style INI files:

**`~/.config/linear/config`** — non-secret profile metadata:

```ini
[default]
profile = work

[profile work]
workspace = Acme Corp
workspace_id = 22222222-2222-2222-2222-222222222222
user_email = quentin@example.com

[profile personal]
workspace = Side Project
```

**`~/.config/linear/credentials`** — secrets (created with `0600` permissions on Unix and a private ACL on Windows):

```ini
[work]
type = api_key
api_key = lin_api_xxx

[personal]
type = oauth
access_token = lin_access_xxx
refresh_token = lin_refresh_xxx
expires_at = 2026-04-12T18:45:00Z
scopes = read write
oauth_client_id = abc123
```

On Windows, the credentials file uses a protected ACL with inheritance disabled and full control granted only to the current Windows account. linearctl validates that ACL before reading secrets and fails closed if another principal has access. The Windows ACL implementation uses the built-in `whoami.exe` and `icacls.exe` system tools; it does not weaken the Unix `0600` policy.

Profile names must match across both files. The `[default]` section in config stores only the active profile name. Unknown keys are allowed and preserved.

## Config file overrides

For non-standard config locations:

```bash
linearctl auth status --config-file /path/to/config --credentials-file /path/to/credentials
```

## Security

- Secrets are never accepted as CLI arguments
- On Unix, the credentials file is created with `0600` permissions (owner read/write only)
- On Windows, the credentials file ACL disables inheritance and grants full control only to the current user
- API keys are read from environment variables or stdin
- OAuth tokens are stored in the credentials file alongside API keys
- Profile names are validated against INI-breaking characters

If a Unix credentials file is too permissive, the error reports its absolute path, actual mode, the expected owner-only policy (`0600` recommended), and a copyable `chmod 600 '<path>'` remediation command.
