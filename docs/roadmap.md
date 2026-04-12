# Roadmap

## Completed

- All curated commands (issue, project, cycle, team, user, label, comment, attachment, state, project-status)
- Generated API layer with manifest-driven discovery
- Raw GraphQL fallback
- File operations (upload, download, signed URL)
- API key and OAuth PKCE authentication
- Named profiles with AWS CLI-style INI files
- Default team per profile
- Name resolution (team name, user email, "me", state name, label name)
- Pagination, filtering, ordering
- JSONL streaming output
- Bulk issue operations
- --dry-run for destructive commands
- Transport retry with exponential backoff
- Schema management (version, pull, check, diff, regeneration)
- Agent skills (linear-agent-cli, linear-raw-gql)
- CI/CD with GitHub Actions, semver releases, auto-tagging
- Curl installer for Linux and macOS
- User-facing documentation

## Planned

### Distribution

- AUR package (`linear-agent-cli-bin`) for Arch Linux
- Homebrew formula for macOS
- Nix package
- Scoop manifest for Windows
- Windows binary builds (pending Bun Windows compile support)
- npm global install (`npm install -g @qwrobins/linear-agent-cli`)

### CLI improvements

- Bundle a default OAuth client ID so `--oauth` works without `--oauth-client-id`
- Add Linear docs link to OAuth setup error message
- `--verbose` flag for debugging transport and resolution
- `linear-agent config get/set` commands for managing profile settings
- `linear-agent init` interactive setup wizard
- Shell completions (bash, zsh, fish)
- `--output-format table` for human-readable tabular output
- `linear-agent issue move <identifier> --state <name>` as alias for update
- Additional curated resources: initiatives, milestones, documents, webhooks

### Output and integration

- JSONL streaming for generated API commands
- `--fields` selection for curated commands (return subset of fields)
- Markdown output mode for pasting into docs/PRs
- Pipe-friendly exit behavior (suppress broken pipe errors)
- `--quiet` flag to suppress all non-data output

### Performance and reliability

- Connection pooling for bulk operations
- Parallel execution for bulk commands
- Request complexity estimation before execution
- Offline mode with cached schema for help/discovery

### Testing and quality

- Integration tests against a live Linear workspace
- Golden file tests for all output formats
- Binary smoke tests on all target platforms in CI
- Fuzz testing for CLI argument parsing

### Documentation

- Man pages
- Hosted documentation site
- Video walkthrough for agent setup
- Migration guide from Linear MCP server
