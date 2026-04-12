# Auth and profiles

## Named profiles

The CLI uses named profiles to manage credentials for one or more Linear workspaces. Each profile stores an API key or OAuth token set. You must create a profile before running any data command.

Profiles are stored in the credentials file (`~/.config/linear/credentials`). Profile metadata (workspace name, default selection) is stored in the config file (`~/.config/linear/config`). See [File layout](#file-layout) below for the full INI structure.

## API key auth

Create an API key at [Linear API settings](https://linear.app/settings/api).

Store the key in an environment variable and pass the variable name (not the key itself):

```bash
export LINEAR_API_KEY=lin_api_...
linear-agent auth login --profile work --api-key-env LINEAR_API_KEY
```

Or pipe via stdin:

```bash
echo "$LINEAR_API_KEY" | linear-agent auth login --profile work --api-key-stdin
```

The CLI never accepts API keys as plain command-line arguments. This prevents secrets from appearing in shell history and process listings.

## OAuth auth

OAuth uses the PKCE authorization code flow with a local loopback callback server.

You need an OAuth application client ID. Create one at [Linear API applications](https://linear.app/settings/api/applications).

```bash
linear-agent auth login --profile work --oauth --oauth-client-id <client-id>
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

OAuth tokens expire. The CLI auto-refreshes expired tokens during profile resolution (within a 5-minute window before expiry). Refreshed tokens are written back to the credentials file.

## Setting the default profile

```bash
# During login
linear-agent auth login --profile work --api-key-env LINEAR_API_KEY --set-default

# After login
linear-agent auth switch work
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
linear-agent auth status --json

# Show current user and organization for the active profile
linear-agent auth whoami --json

# List workspaces accessible to the active profile
linear-agent workspace list --json
```

## Logout

```bash
# Remove credentials for a profile
linear-agent auth logout --profile work

# Also remove config metadata
linear-agent auth logout --profile work --remove-config
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

**`~/.config/linear/credentials`** — secrets (created with `0600` permissions):

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

Profile names must match across both files. The `[default]` section in config stores only the active profile name. Unknown keys are allowed and preserved.

## Config file overrides

For non-standard config locations:

```bash
linear-agent auth status --config-file /path/to/config --credentials-file /path/to/credentials
```

## Security

- Secrets are never accepted as CLI arguments
- The credentials file is created with `0600` permissions (owner read/write only)
- API keys are read from environment variables or stdin
- OAuth tokens are stored in the credentials file alongside API keys
- Profile names are validated against INI-breaking characters
