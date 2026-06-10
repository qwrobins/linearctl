# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-06-10

### Changed

- Friendly name resolution for teams, users, labels, states, and projects is case-insensitive. `issue list --state` now uses workflow state resolution when a team scope is available, and team-scoped label resolution includes workspace labels.
- `cycle delete` now explicitly reports that Linear archives cycles instead of deleting them, including dry-run and JSON output.
- File upload and download requests now use manual redirect handling and reject redirects to a different host before reusing signed upload headers or Linear authorization.
- OAuth token refresh tolerates concurrent credential rotation by re-reading credentials after `invalid_grant`, and token refresh errors no longer include raw response bodies.
- Autopagination defaults to the maximum page size for bounded `--all`/`--max` requests when `--page-size` is omitted.

### Fixed

- `gql --var key=value` preserves leading and trailing whitespace in `value`.
- Project name resolution now uses server-side `containsIgnoreCase` filtering before client-side exact/prefix/substring disambiguation.

## [0.7.0] - 2026-06-10

### Added

- Added `issue bulk-archive` for the previous bulk archiving behavior.
- Retry is now default-on for GraphQL rate limits, honors HTTP `Retry-After`, and applies to command execution, pagination, and name resolution.

### Changed

- **Breaking:** `issue bulk-close` now transitions issues to a completed workflow state, matching `issue close`; use `issue bulk-archive` to archive issues.
- **Breaking:** Bulk operations with any failed item now exit non-zero. `--json-envelope` responses use `ok: false`, populate `errors[]`, include per-item `data.succeeded`/`data.failed`, and set `meta.partial: true` when some items succeeded.
- **Breaking:** `issue list --search` composes with the same filters as `issue list` instead of silently discarding filters.
- **Breaking:** `--metadata curated` now requires `--json`, `--json --jsonl` is rejected, and `--jsonl` requires an explicit `--all` or `--max <n>` bound.

## [0.6.14] - 2026-06-09

### Added

- `project create` and `project create-with-issues` now apply `--start-date`, `--target-date`, `--status`/`--state`, `--lead`, and long-form `--content` fields to `ProjectCreateInput`.
- Curated command metadata is now derived from the command registry so agent discovery covers every curated subcommand, including destructive safety annotations.

### Fixed

- Parse-level validation failures now emit failure envelopes when `--json-envelope` is requested.
- Options placed before a command are validated against that command's option set instead of the global catalog.
- Pagination helpers preserve GraphQL transport error typing so list/streaming failures map to the documented error contract.
- Generated `api` commands use the shared command error mapper, including Linear `userPresentableMessage` details.
- Schema freshness checks run after command completion with a timeout, skip help and dry-run paths, and compare against pulled schema metadata when present.
- Schema fingerprints now include type signatures, not just type and field names.

## [0.6.13] - 2026-06-09

### Fixed

- `--help` on curated subcommands with additional positionals now prints help and exits before command dispatch, preventing discovery commands such as `issue delete <id> --help` from executing.
- CLI subprocess tests now pass explicit temp config and credentials paths so the suite does not read or update the user's Linear config.

## [0.6.12] - 2026-06-09

### Added

- `issue update` and `issue bulk-update` now support `--project-milestone <id>` and the `--milestone <id>` alias.
- `project create` and `project update` now support long-form project bodies with `--content <text>` and `--content-file <path|->`.
- Generated `api <resource> <operation> --help` now prints operation usage and input guidance before validating required arguments.

### Fixed

- `issue update` and `project update` missing-identifier usage now lists the full supported flag set.

## [0.6.11] - 2026-06-05

### Added

- `issue create`, `issue update`, `project create`, and `project update` now support `--description-file <path>` and `--description-file -` for explicit stdin-sourced descriptions.

### Fixed

- `issue create`, `issue update`, `project create`, and `project update` keep `--description` as a literal flag value and only read stdin when `--description-file -` is provided, avoiding accidental stdin consumption in shell loops.

## [0.6.10] - 2026-06-02

### Fixed

- `project create --lead` now maps the provided user ID, email, or `"me"` value to `ProjectCreateInput.leadId` so new projects are created with their lead set.

## [0.6.9] - 2026-05-23

### Added

- Normal commands now perform a best-effort schema freshness check at most once per day when the bundled schema is older than the configured threshold.
- Added `[schema]` config support for `stale_after_days` and opt-in `auto_update`.
- GraphQL field/type lookup failures now include a hint to run `linearctl schema check`.

## [0.6.8] - 2026-05-22

### Fixed

- `team members <name>` now resolves team names before fetching members.
- Issue JSON includes parent issue details alongside `estimate`.
- `issue update --project <name>` falls back to workspace-wide project name resolution when team-scoped lookup misses.
- `file upload` includes a `Content-Type` header for the storage PUT request when Linear does not return one.

## [0.6.7] - 2026-05-22

### Added

- `cycle archive/delete` and `state archive/delete` provide curated cleanup commands without raw GraphQL.

### Fixed

- Curated issue JSON now includes `estimate`, and `issue update --project` plus `issue bulk-update --state` resolve friendly names consistently.
- `team get/members`, `user get`, `label get`, and `state get` now accept friendly names where Linear supports resolution.
- `cycle list`, `file upload`, and `attachment list --issue` use current Linear GraphQL shapes.
- `project create-with-issues` now defaults missing issue `teamId` values from the command-level `--team`.
- `workspace list` refreshes missing workspace/user metadata from each configured profile.
- Unknown top-level commands now report a clear unknown-command error.

## [0.6.6] - 2026-05-22

### Added

- `issue delete <identifier>` and `issue bulk-delete --ids <ids> --yes` provide curated issue deletion without raw GraphQL.
- `gql mutation` now accepts bare mutation selection sets such as `{ issueDelete(...) { success } }` and sends them as mutation operations.

### Fixed

- `issue close --state <name>` now accepts canceled workflow states as terminal states in addition to completed states.

## [0.6.5] - 2026-05-22

### Added

- `issue view <identifier>` is now an alias for `issue get <identifier>`.
- `issue search` now accepts the query as a positional argument, and `issue list --search/--query <text>` routes to full-text issue search.
- `project list` now supports `--query`, `--search`, and `--name` for project-name filtering.
- `--limit <n>` is accepted as an alias for `--max <n>` on paginated commands.

### Fixed

- Team-scoped project name resolution now uses Linear's `accessibleTeams` project filter instead of invalid `ProjectFilter.teams`, fixing project lookups and `issue list --project` workflows that previously failed with GraphQL 400 errors.
- `issue list --status <name>` is accepted as an alias for `--state <name>`.

## [0.6.4] - 2026-05-18

### Added

- `cycle get` and `cycle current` JSON now include progress and scope metrics from Linear, including `progress`, derived `scopeCount`, `completedScopeCount`, `inProgressScopeCount`, `startedScopeCount`, issue counts, history arrays, and uncompleted issues captured on close.
- `team members <id-or-key>` now includes the member `name` field alongside `displayName`, `email`, and `active`.

### Fixed

- `issue list --assignee <value>` now resolves Linear `displayName` values in addition to `name`, `email`, UUID, and `me`.
- `issue list --state` and `project list --state` now support repeated flags as union filters instead of silently using only the last value.
- `project get <name>` and `issue list --project <name>` now resolve unique prefix or substring project-name matches, with ambiguity errors when multiple projects match.

## [0.6.3] - 2026-05-16

### Added

- `project list` JSON milestones now include `progress` and `status`, and human output surfaces progress, health, updated time, description, and milestone summaries for portfolio reviews.
- `project update` now supports `--status <name|type|id>`, `--lead <user-id|email|"me">`, and `--start-date <YYYY-MM-DD>` alongside existing name, description, state alias, and target date updates.

## [0.6.2] - 2026-05-14

### Added

- `team members <id-or-key>` lists team members with `id`, `displayName`, `email`, and `active` fields.

### Fixed

- `issue search` now uses Linear's supported `searchIssues` API instead of the deprecated `issueSearch` field.
- Generated `api team-membership` commands include useful membership, user, and team fields by default instead of returning bare IDs.

## [0.6.1] - 2026-05-13

### Added

- `issue create` now accepts `--project-milestone <id>` and `--milestone <id>` to set the project milestone at creation time.

### Fixed

- `project get <name>` now resolves project names through GraphQL variables, including names with special characters such as `&`.
- `issue list --project <name>` now resolves project names before filtering instead of passing names to Linear as IDs.
- `project list --json` keeps machine-readable output on stdout, with regression coverage for clean stderr/stdout separation.

## [0.5.9] - 2026-05-10

### Fixed

- Generated API commands now handle optional `id` arguments, scalar returns, and payloads without assuming invalid GraphQL field selections
- Retry option normalization is shared and validates programmatic `maxRetries` values before executing GraphQL requests
- Packaged builds now include the bundled schema file for structural schema drift checks
- Vitest no longer discovers copied agent worktree test suites

## [0.5.8] - 2026-05-07

### Changed

- Top-level help now shows a grouped overview of curated resources instead of one long flat command list; full curated usage lines moved to `linearctl <resource> --help`

## [0.5.7] - 2026-04-29

### Fixed

- `issue update --project <id>` now assigns an issue to a project instead of being parsed but ignored, which previously caused `issue update requires at least one field to update` when `--project` was the only update field
- `issue update` help, docs, and bundled skill text now show the supported `--label <name|id>` option

## [0.5.6] - 2026-04-28

### Fixed

- `linearctl gql query` (and all curated/generated commands) now surfaces GraphQL error details in human-readable output instead of only showing a generic "HTTP 400" message; field-level validation errors, paths, and extension codes are printed as indented bullet lines below the main error
- Resolution error candidates (e.g., from ambiguous state/team/label names) no longer print `[object Object]`; the formatter now extracts the `display` field with `id` fallback from candidate objects
- GraphQL errors returned with HTTP 200 (partial success) now render their `path` and `extensions.code` in human output; previously these details were silently dropped

## [0.5.5] - 2026-04-28

### Fixed

- `project update` help text now includes `[--description ...]` (handler already supported it, but agents and humans could not discover the flag from help output)
- Linear API validation errors (e.g., "description must be shorter than or equal to 255 characters") now surface the specific constraint message instead of the generic "Argument Validation Error"

## [0.5.4] - 2026-04-28

### Added

- `project update --target-date <YYYY-MM-DD>` to set or change a project's target date
- `project update --state` now resolves status names (e.g. "Paused", "Active Development") and state types (e.g. "completed", "backlog") to status IDs automatically; UUIDs are passed through directly

### Fixed

- `project update --state` sending a raw state type string instead of resolving to a `statusId`, causing "status not found" errors on every state change
- `project update --target-date` now validates YYYY-MM-DD format and rejects impossible dates (e.g. 2026-02-30) before making the API call
- Project status resolution now paginates the `projectStatuses` connection to fetch all pages instead of only the first 100
- Project status fetch errors now preserve and return the original GraphQL error details instead of a generic message

## [0.5.3] - 2026-04-28

### Added

- `project list` and `project get` JSON output now includes `progress` (float), `health` (enum), `currentProgress`, and a normalized `milestones` array with truncation metadata (`milestonesPageInfo`, `milestonesTruncated`)
- `project get` detail payload includes richer milestone fields: `description`, `sortOrder`, `createdAt`, `updatedAt`
- `project list --state <status-type>` filters by project state type (`backlog`, `planned`, `started`, `paused`, `completed`, `canceled`)

### Fixed

- All project commands (`list`, `get`, `create`, `update`, `delete`) returning HTTP 400 due to `totalCount` field not existing on `ProjectMilestoneConnection` and `issues` connection requiring a `first` argument
- `project list` exceeding Linear's query complexity limit (12165 vs 10000 ceiling) when fetching milestones; reduced milestone page size from 50 to 10
- `skills install --scope user` ignoring `HOME` env var override because `os.homedir()` caches the native value in Bun

### Removed

- `issueCounts` field from `project get` JSON output (Linear API does not expose issue count on the project connection)

## [0.5.2] - 2026-04-27

### Changed

- Release refresh for the current `main` branch, including `issue update --cycle` support.

## [0.4.0] - 2026-04-14

### Added

- `issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>]` — link a Slack thread to an issue with optional bidirectional comment sync
- `project create-with-issues --name <name> --team <id> --issues-json <json>` — atomically create a project and batch-create linked issues
- Completes MCP server parity — all composite operations from `lp-linear-mcp` now have curated CLI equivalents

## [0.3.2] - 2026-04-14

### Fixed

- Generated API mutations returning HTTP 400 — Payload types now use `success` as default field selection instead of `id`
- Generated API list commands no longer require `--input-json` when all args are optional
- Generated API commands with required scalar args (e.g. `api application info`) correctly require `--input-json`
- `linearctl gql` help text now shows `--var`, `--vars-file`, `--file`, `--stdin` options

## [0.3.1] - 2026-04-14

### Added

- `--version` / `-V` flag — print the CLI version
- `--estimate <n>` on `issue create`, `issue update`, and `issue bulk-update` — set story points without raw GraphQL
- `--cycle <id>` on `issue bulk-update` — assign cycle in bulk operations

## [0.3.0] - 2026-04-14

### Added

- `issue search --query <text>` — full-text search across issues using Linear's issueSearch API
- `cycle current [--team <id>]` — get the currently active cycle for a team
- `--quiet` / `-q` flag on all list commands — suppress truncation warnings when piping JSON
- `issue close --state <name>` — specify which completed state to transition to (validated as completed-type)
- `issue create --cycle <id>` and `--project <id>` — set cycle and project on issue creation
- `project list --state <name>` — filter projects by status
- `--created-after`, `--updated-after`, `--completed-after` date filters on `issue list`
- Truncation warning on stderr when list results are silently capped (the silent 50-item cap was the most dangerous agent usability issue)
- `gql` without subcommand now shows usage help with valid examples

### Changed

- **Breaking:** `--everything` renamed to `--all-teams` for clarity (agents read "everything" as "all statuses" when it means "all teams")
- `issue close` now transitions to a completed workflow state (prefers "Done") instead of calling `issueArchive` which silently hid issues without changing their state
- Help text now shows complete flag lists — `issue create` was showing 2 of 9 flags, `issue list` was missing `--label`, `--priority`, `--order-by`
- Skill doc updated with all new commands and complete signatures
- API manifest now bundled via JSON import (works in compiled binaries)
- Schema pull defaults to `~/.config/linear/schema/` in compiled binaries

### Fixed

- Compiled binary couldn't load API manifest (`import.meta.dirname` resolves to `/$bunfs` in Bun)
- `comment list --issue <id>` and `attachment list --issue <id>` failed with GraphQL type error (`String!` → `ID!`)
- Manifest generator produced scalar types for list args (`IssueSortInput` instead of `[IssueSortInput!]`)
- API list commands used `id` as default field selection on connection types (now uses `nodes { id }`)
- `issue close` defaulted to "WontFix" when team had multiple completed states (now prefers "Done", then lowest position)
- Truncation warning suggested `--all` even when `--after` was in use (mutually exclusive)
- `issue close --state` with a UUID showed the raw ID in output (now shows friendly name from API response)
- `issue close --state` accepted non-completed states silently (now validates type)
- `issue close` returned generic error code for not-found issues (now returns exit code 4 / `not-found` category)
- Pre-existing `schema.test.ts` CI failure (case-sensitive assertion)

## [0.2.6] - 2026-04-13

### Added

- `--cycle` and `--project` filters added to linearctl skill reference
- MIT license

## [0.2.5] - 2026-04-13

### Added

- `--cycle <id>` filter on `linearctl issue list`
- `--project <id>` filter on `linearctl issue list`

## [0.2.4] - 2026-04-13

### Fixed

- Remove `url` field from cycle GraphQL fragment (caused 400 errors on all cycle commands)

## [0.2.3] - 2026-04-13

### Added

- **Skills install prompt** — interactive scope selection (project vs user level)
- **`--scope` flag** — skip prompt with `--scope project` or `--scope user`
- **Codex SKILL.md structure** — both Claude Code and Codex get `<name>/SKILL.md` directories
- **Stable JSON output** — `agent`, `scope`, `displayName` fields in install results
- **Non-interactive detection** — piped/CI runs default to project scope
- **INSTALL.md** — single URL for agent-driven setup

### Fixed

- Skills install now creates `<name>/SKILL.md` directories (was writing flat `.md` files)
- Invalid `--scope` values rejected with clear error
- Prompt re-asks on invalid input instead of defaulting

## [0.2.1] - 2026-04-12

### Added

- `.deb` packages for Debian/Ubuntu (amd64 and arm64) in GitHub Releases
- Install script auto-detects dpkg and uses `.deb` on Debian/Ubuntu
- Auto-tag workflow now triggers release builds via workflow_dispatch

## [0.2.0] - 2026-04-12

### Added

- **Renamed to `linearctl`** — binary is now `linearctl`, package is `linearctl`
- **Workflow state commands** — `linearctl state list/get/create` for managing issue workflow states
- **Project status commands** — `linearctl project-status list/get/create/delete` for workspace-level statuses
- **Label delete** — `linearctl label delete <id>`
- **Project delete** — `linearctl project delete <id>`
- **Skills install command** — `linearctl skills install` embeds skills in the binary and writes to agent config directories
- **Multi-agent auto-discovery** — skills install auto-detects Claude Code and Codex at project and user level
- **skills.sh compatibility** — skills restructured as `skills/<name>/SKILL.md` with YAML frontmatter
- **CI/CD** — GitHub Actions for CI, semver releases with auto-tagging, curl installer
- **Changelog** — Keep a Changelog format

## [0.1.0] - 2026-04-12

### Added

- **Curated commands** for 10 resource groups:
  - `issue` — get, list, create, update, close, assign, comment, bulk-update, bulk-close, bulk-assign
  - `project` — get, list, create, update, delete
  - `cycle` — get, list, create, update
  - `team` — get (with --set-default), list
  - `user` — get, me, list
  - `label` — get, list, create, delete
  - `comment` — list, create, update, delete
  - `attachment` — list, create, delete
  - `state` — list, get, create (workflow states)
  - `project-status` — list, get, create, delete
- **File operations** — upload (with optional attachment), download, signed URL
- **Generated API layer** — `linearctl api <resource> <operation>` with manifest-driven discovery, search, and help
- **Raw GraphQL** — `linearctl gql query`, `linearctl gql mutation`, `linearctl gql introspect`
- **Schema management** — `linearctl schema version`, `linearctl schema pull`, `linearctl schema check` with structural diff
- **Authentication** — API key auth (`--api-key-env`, `--api-key-stdin`), OAuth PKCE browser flow with auto-refresh
- **Named profiles** — AWS CLI-style INI config/credentials files at `~/.config/linear/`
- **Profile management** — `auth status`, `auth login`, `auth logout`, `auth switch`, `auth whoami`
- **Workspace management** — `workspace list` with multi-profile overview
- **Default team** — per-profile default team with `team get --set-default`, automatic filtering on list commands
- **Name resolution** — team name/key, user email/"me", label name, state name resolve to IDs automatically
- **Output modes** — `--json` (stable contract), `--json-envelope`, `--jsonl` (streaming), `--raw` (gql only)
- **Pagination** — `--all`, `--max`, `--page-size`, `--after` with autopagination and 10k safety cap
- **Filtering** — `--state`, `--assignee`, `--team`, `--label`, `--priority`, `--filter-json`, `--order-by`
- **`--everything`** flag to bypass default team filter on list commands
- **`--dry-run`** for all destructive/mutating commands
- **Transport retry** — bounded exponential backoff for 429 rate limits, `--no-retry`, `--max-retries`
- **Schema regeneration** — `bun run regenerate:schema` for CI with diff detection
- **Skills** — `linearctl` and `linearctl-raw-gql` agent skills with routing rules and examples
- **CI/CD** — GitHub Actions for CI (typecheck, test, build) and releases (multi-platform binaries)
- **Install script** — `curl | sh` installer for Linux and macOS (x64, arm64)
