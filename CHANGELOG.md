# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Generated API layer** — `linear-agent api <resource> <operation>` with manifest-driven discovery, search, and help
- **Raw GraphQL** — `linear-agent gql query`, `linear-agent gql mutation`, `linear-agent gql introspect`
- **Schema management** — `linear-agent schema version`, `linear-agent schema pull`, `linear-agent schema check` with structural diff
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
- **Skills** — `linear-agent-cli` and `linear-agent-raw-gql` agent skills with routing rules and examples
- **CI/CD** — GitHub Actions for CI (typecheck, test, build) and releases (multi-platform binaries)
- **Install script** — `curl | sh` installer for Linux and macOS (x64, arm64)
