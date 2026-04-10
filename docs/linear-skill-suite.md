# Linear Skill Suite

## Recommended Skill Set

Use two skills:

1. `linear-cli`
2. `linear-raw-gql`

Do not split auth into a separate skill. Do not create a separate agent-specific skill in v1.

## `linear-cli`

### Purpose

Default skill for all Linear CLI usage.

Covers:

- curated commands
- generated `linear api` commands
- auth/profile checks
- file commands
- schema commands

### Trigger

Use this skill for any request involving Linear data unless raw GraphQL is explicitly required or the curated/generated layers cannot cover the operation.

## `linear-raw-gql`

### Purpose

Fallback skill for `linear gql` usage.

Covers:

- `linear gql query`
- `linear gql mutation`
- `linear gql introspect`

### Trigger

Use only when:

- no curated command exists
- no generated command exists
- or the user explicitly asks for raw GraphQL

## Decision Rules

### Command routing

1. Check whether a curated command covers the requested operation.
2. If yes, use the curated command.
3. Otherwise check whether a generated command exists under `linear api`.
4. If yes, use the generated command.
5. Otherwise use `linear-raw-gql`.

### How to verify coverage

- Use curated taxonomy or `linear <resource> --help` for curated commands.
- Use `linear api search <term>` for generated command discovery.
- Use `linear api <resource> --help` to inspect available operations.
- Do not guess whether a command exists.

### Profile selection

1. If an explicit profile is already specified by context, use `--profile <name>`.
2. Otherwise rely on `LINEAR_PROFILE` only if it is already configured.
3. Otherwise run `linear auth status`.
4. If there is a single default profile, proceed.
5. If there are multiple profiles with no default, ask the user.
6. If there is no profile, instruct the user to log in.

Do not silently choose among multiple profiles.

### Output mode selection

- Use default human output when the result only needs to be summarized to the user.
- Use `--json` when parsing output programmatically.
- Use `--json-envelope` only when metadata such as pagination, rate limits, or complexity is needed.
- Do not parse default human output.

### Pagination rules

- Default list behavior is exploratory and bounded.
- Use `--max` whenever requesting many results.
- Do not use `--all` without `--max` unless the user explicitly asks for everything.
- Add filters before broad pagination whenever possible.
- Default skill guidance should treat `200` as the default soft cap for large enumerations unless the user specifies otherwise.

### Filtering rules

- Prefer named flags for common cases.
- Use `--filter-json` only for complex filters.
- Do not mix named filter flags and `--filter-json` in one command.
- Do not invent filter syntax.

## Failure Handling Rules

### Auth error: exit code 2

- Run `linear auth status`.
- If OAuth token is expired, instruct the user to re-run OAuth login.
- If API key is invalid, instruct the user to update the key and log in again.
- Do not automatically retry after re-auth without user confirmation.
- Do not switch profiles automatically.

### Rate-limit exhaustion: exit code 3

- Do not retry immediately.
- Tell the user the rate limit was hit.
- Suggest reducing result count or adding filters if the command was broad.

### Not found: exit code 4

- Verify the identifier or ID.
- If a name was used, prefer retrying with an exact ID.
- If using generated commands, consider confirming existence through a list command.

### Validation error: exit code 5

- Read stderr.
- Fix the command input.
- For generated commands, inspect `linear api <resource> <operation> --help`.

### Schema drift: exit code 6

- Do not retry the same generated command.
- Fall back to `linear gql` for that operation.
- Inform the user the CLI may need updating.

### Name ambiguity

- Ask the user to choose among returned matches.
- Do not guess.

## Examples The Skills Must Include

### Curated command examples

- `linear issue list --team "Infrastructure" --state "In Progress"`
- `linear issue get INF-2975 --json`
- `linear issue create --title "Fix Vault staging access" --team "Infrastructure"`
- `linear file upload ./screenshot.png --issue INF-2975`

### Generated command examples

- `linear api search "milestone"`
- `linear api project-milestone list --input-json '{"filter":{"project":{"name":{"contains":"Q2"}}}}' --json`

### Raw GraphQL examples

- `linear gql query '{ viewer { id name email } }' --json`
- `cat query.graphql | linear gql query --stdin --vars-file vars.json`

## Anti-Patterns The Skills Must Prohibit

- Using `linear gql` when curated or generated commands already cover the task
- Running broad `--all` listings without filters or caps
- Parsing human-mode output programmatically
- Guessing profile names
- Passing secrets as CLI arguments
- Retrying immediately after rate-limit exhaustion
- Guessing among ambiguous name matches
- Inventing filter syntax instead of using documented JSON structure
- Using `--raw` unless explicitly debugging raw GraphQL responses
- Running destructive operations without explicit confirmation from the user

## MCP Migration Guidance

Models migrating from MCP usage must assume:

- CLI commands replace MCP tool calls
- CLI returns text/JSON that must be parsed
- CLI relies on exit codes instead of tool-level typed responses
- pagination is explicit, not automatic
- profile selection is explicit, not inherited from MCP server context

Recommended mapping guidance:

- search issues -> `linear issue list --filter-json ... --json`
- get issue -> `linear issue get <identifier> --json`
- create issue -> `linear issue create ... --json`
- create comment -> `linear issue comment <identifier> --body ...`
- unsupported MCP-style operation -> generated command first, raw GraphQL last

## Skill-Driven Doc Requirements

The CLI docs should also provide:

- `linear api search` in MVP
- concise help text for curated commands
- a machine-readable curated taxonomy artifact
- stable error wording for common categories such as not found and auth failure
- optional `--dry-run` support for destructive curated commands
