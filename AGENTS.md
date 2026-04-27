# AGENTS.md

Guidance for coding agents working in `linearctl`.

## Repository state (current)

`linearctl` is an implemented TypeScript/Bun CLI (v0.5.1) with curated commands, generated API command support, authentication/profile handling, pagination/filtering, schema tooling, tests, and binary build support. Treat work as **maintenance and incremental enhancement** of an existing production-ready codebase, not a greenfield scaffold.

## Important documents (read first)

Start from the docs that match the area you are changing:

- `docs/commands.md` — command surface, global flags, and command groups.
- `docs/agent-usage.md` — agent-oriented execution patterns and safe operating guidance.
- `docs/auth-and-profiles.md` — auth flows, profile behavior, and precedence.
- `docs/schema-and-generated.md` — generated command pipeline, schema metadata, and regeneration flow.
- `docs/output-modes.md` — JSON/plain/envelope output contracts and expectations.
- `docs/implementation-progress.md` — delivered milestones, current architecture status, and verification baseline.

Supporting references as needed:

- `README.md` and `docs/getting-started.md` for setup/installation and user-facing workflows.
- `docs/filtering-and-pagination.md` for list query and pagination behavior.
- `docs/roadmap.md` for planned/future work (non-normative for current behavior).

## Maintenance workflow (when implementing)

Use this change workflow instead of phase-based greenfield planning:

1. **Read current contracts first**
   - Review the relevant docs above.
   - Identify whether behavior is curated (`src/commands/*`) or generated (`src/generated/*`, schema metadata).
2. **Locate the impacted contract area**
   - Command shape/options/help: `src/core/registry/*`, command handlers, and docs.
   - Execution/runtime behavior: `src/core/runtime/*`, `src/core/transport/*`, `src/core/output/*`.
   - Auth/profile behavior: `src/core/auth/*`, `src/core/config/*`.
3. **Make scoped, minimal changes**
   - Prefer targeted edits over broad refactors unless explicitly requested.
   - Keep command UX and output mode contracts stable unless scope requires a contract change.
4. **Update docs with code changes**
   - If behavior/options/output changed, update matching docs in `docs/` in the same PR.
   - Keep examples and verification instructions aligned with the implementation.
5. **Run verification before handoff**
   - Minimum expected checks:
     - `bun run typecheck`
     - `bun run test`
     - `rm -rf dist && bun run build`
     - `bun run build:binary`
   - If generated artifacts changed, run the relevant generation/regeneration commands and associated tests.

## CodeRabbit review gate

Before push/PR handoff, run a local CodeRabbit review:

- Preferred invocation: `coderabbit review --plain`

If CodeRabbit CLI is unavailable in the environment (missing binary, auth unavailable, or command fails for environment reasons):

1. Document the reason in your handoff/PR notes.
2. Complete the full local verification baseline (typecheck/test/build/binary build).
3. Proceed with PR and request CodeRabbit/GitHub review in CI/remote flow as fallback.

## Notes

- Keep changes backward-compatible unless the issue explicitly requests a breaking change.
- For generated code changes, prefer updating source generation inputs and regenerating, rather than editing generated outputs manually when avoidable.
