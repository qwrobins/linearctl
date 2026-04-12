# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
