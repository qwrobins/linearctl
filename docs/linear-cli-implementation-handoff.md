# Linear CLI Implementation Handoff

## Goal

Build a `linear` CLI with practical full parity to the Linear API and a companion skill suite optimized for AI agent usage.

The most important implementation constraint is that AI agents are the primary consumer of this CLI. The skills are therefore not documentation garnish or packaging work; they are the decision layer that determines how the CLI is actually used.

## Final Document Set

Produced artifacts:

- `linear-cli-requirements.md`
- `linear-cli-spec.md`
- `linear-cli-command-taxonomy.md`
- `linear-cli-auth-and-safety.md`
- `linear-cli-auth-ux.md`
- `linear-cli-round-2-decisions.md`
- `linear-skill-suite.md`
- `linear-cli-testing-strategy.md`

## Architecture Recommendation

### Language

Recommended default: TypeScript.

Reasoning:

- official Linear SDK ecosystem is TypeScript-first
- schema-driven generation aligns well with TypeScript tooling
- raw GraphQL and generated layers are easier to integrate around existing SDK and schema assets

Open alternative:

- Go remains attractive for single-binary distribution, but is not the leading recommendation from this exercise

### Core modules

Recommended structure:

- `src/cli/`
- `src/core/auth/`
- `src/core/config/`
- `src/core/transport/`
- `src/core/output/`
- `src/core/errors/`
- `src/core/pagination/`
- `src/core/schema/`
- `src/commands/`
- `src/generated/`
- `src/skills/`

### Agent-first architecture principle

Treat the system as two tightly coupled layers:

1. CLI execution layer
2. skill routing layer

Implications:

- command metadata is a product surface, not an internal convenience
- help text is part of the agent interface
- output contracts must be optimized for machine consumption first
- fallback from curated to generated to raw GraphQL must be explicit and machine-readable
- skills must be implemented and validated alongside commands, not after them

## Layered Build Plan

### Phase 1: Agent contract and command metadata

Implement:

- skill routing rules for curated, generated, and raw GraphQL paths
- command metadata schema shared by CLI and skills
- command safety classification
- machine-readable curated taxonomy format
- output contract rules for `--json` and `--json-envelope`
- exit-code and stderr/stdout contract
- fallback policy when curated or generated coverage is missing

Every command surface should be able to declare metadata such as:

- command path
- stability level
- preferred-for-agents status
- safe vs destructive classification
- input mode
- output shape
- fallback guidance

### Phase 2: Core platform and minimal execution layer

Implement:

- config loading
- credentials file loading
- profile resolution
- credentials file writing with restrictive permissions
- transport wrapper for GraphQL and file flows
- output modes
- retry/error handling
- schema metadata handling

OAuth keychain support is explicitly deferred until after MVP.

### Phase 3: Raw GraphQL and schema tooling

Implement:

- `linear gql query`
- `linear gql mutation`
- `linear gql introspect`
- `linear schema pull`
- `linear schema version`
- `linear schema check`

This phase provides the universal parity backstop that the skills depend on.

### Phase 4: Curated MVP commands and primary skill surface

Implement curated groups for:

- issues
- projects
- cycles
- teams
- users
- labels
- comments
- attachments
- files

At the same time, implement the primary skill-facing materials for these curated commands:

- stable JSON output normalization
- concise, machine-usable help text
- examples suitable for skill prompts
- safety and confirmation boundaries
- command metadata entries consumed by the default skill

Priority within curated commands should follow the most common agent workflows first:

1. issue get/list/create/update
2. comment create
3. project get/list
4. team get/list
5. user get/list
6. file upload/url/download

### Phase 5: Generated API layer and discovery surface

Implement:

- schema-to-command manifest generation
- `linear api <resource> <operation>` command generation
- generated help text
- `linear api search`
- `--fields` support

The generated layer is a secondary agent surface. It must be discoverable enough that the primary skill can decide whether a generated command exists before falling back to raw GraphQL.

### Phase 6: Skill packaging, validation, and release hardening

Implement:

- `linear-cli` skill
- `linear-raw-gql` skill
- machine-readable command taxonomy for skill embedding
- generated command manifest for skill embedding
- usage examples and failure-handling playbooks
- routing examples and anti-pattern guidance
- skill-focused contract tests

Do not treat this phase as the first time the skills are considered. It is only the packaging and hardening phase for skills that should already have shaped the earlier command work.

## Highest-Risk Areas

1. Skill routing ambiguity between curated, generated, and raw GraphQL
2. Generated namespace discoverability
3. Schema freshness and drift handling
4. Multi-profile auth clarity in agent-driven sessions
5. Keeping curated output stable while generated output stays schema-driven
6. File upload/download transport behavior
7. Preventing AI skills from overusing raw GraphQL

## Implementation Rules

- Keep curated and generated namespaces explicitly separate
- Do not generate per-field flags for generated commands
- Keep `--json` data-first
- Preserve stderr/stdout separation cleanly
- Keep list commands bounded by default
- Treat schema mismatch as a first-class error category
- Use AWS-style INI files for config and credentials
- Keep credentials-file runtime auth as the MVP implementation
- If keychain-backed OAuth is added later, only consult it when file credentials are absent for the resolved profile
- Design help output and examples as agent-consumable interfaces, not just human documentation
- Every curated and generated command should expose machine-readable metadata
- Prefer stable curated commands over generated commands, and generated commands over raw GraphQL, in all default skill routing
- Mark destructive and confirmation-requiring operations explicitly in command metadata

## Testing Plan

### Unit tests

- command metadata generation and validation
- safety classification behavior
- fallback routing primitives
- profile resolution order
- output mode selection and formatting
- exit code mapping
- retry strategy behavior
- name resolution ambiguity behavior

### Skill contract tests

- curated-first routing behavior
- generated fallback routing behavior
- raw GraphQL final fallback behavior
- confirmation-boundary behavior for destructive commands
- error-handling guidance for auth, not found, validation, rate limits, and schema drift
- machine-readable taxonomy and manifest shape validation

### Integration tests

- auth status/login/logout flows
- raw GraphQL commands against a test workspace
- curated issue lifecycle commands
- generated command invocation with JSON input
- schema drift detection behavior
- file upload and signed URL download flows
- skill-driven command discovery flow using curated help and `linear api search`

### Golden tests

- help output for curated commands
- help output for generated commands
- `--json` output shapes for curated commands
- `--json-envelope` shape
- curated taxonomy artifact
- generated manifest artifact

## Release Considerations

- bundle schema snapshot and version metadata into releases
- include changelog notes for generated-surface changes
- treat curated output contract changes as high-scrutiny breaking changes
- monitor Linear deprecations and schema updates regularly
- treat skill-routing contract changes as high-scrutiny changes even when command names do not change

## Open Decisions Remaining

- whether to ship `--jsonl` in MVP or shortly after
- whether to include `--dry-run` in initial destructive command support
- whether multi-organization selector UX is needed in MVP
- whether plugin or extension support exists at all

The previously open implementation gaps around OAuth callback behavior, config shape, generated command naming, file flows, partial-success handling, and implementation language are resolved in `linear-cli-round-2-decisions.md`.

## Recommendation

The best implementation path is:

1. define the agent contract and command metadata first
2. build the core execution layer second
3. build raw GraphQL and schema tooling early as the universal fallback
4. build curated high-value commands and validate them through the default skill
5. add generated parity coverage and discovery next
6. harden and package the two-skill model last

That sequence minimizes parity risk while keeping the actual primary consumer, AI agents, central to the implementation rather than downstream from it.
