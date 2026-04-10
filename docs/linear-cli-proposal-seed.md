# Linear CLI Proposal Seed

> Status: Historical background. This seed proposal is non-normative and was superseded by the requirements, spec, Round 2 decisions, implementation handoff, and skill-suite documents.

## Working proposal

Build a `linear` CLI around a shared transport/auth core with three usage layers:

1. Resource-oriented commands for common operations
2. Schema-backed generated coverage for broad parity
3. Raw GraphQL commands for escape-hatch completeness

This is a seed proposal for the exercise, not a final decision.

## Command model

### Human-oriented command groups

- `linear auth ...`
- `linear account ...`
- `linear issue ...`
- `linear project ...`
- `linear cycle ...`
- `linear team ...`
- `linear user ...`
- `linear label ...`
- `linear comment ...`
- `linear attachment ...`
- `linear webhook ...`
- `linear agent ...`
- `linear file ...`

### Parity-preserving escape hatches

- `linear gql query --file query.graphql --var id=...`
- `linear gql mutation --file mutation.graphql --json-vars vars.json`
- `linear gql introspect`
- `linear schema pull`
- `linear schema diff`

### Suggested output modes

- default human-readable table or summary output
- `--json` for stable machine output
- `--jsonl` where streaming lists are useful
- `--raw` for exact GraphQL payloads when needed

## Parity definition candidate

"Full parity" should mean:

- every production Linear GraphQL query and mutation can be executed through the CLI
- common high-value resources have ergonomic first-class commands
- unsupported high-level commands never block access to the underlying API because raw GraphQL remains available
- auth, file access, and headers needed for real API usage are exposed
- schema changes can be detected and regenerated with bounded manual work

It should not mean:

- every GraphQL field gets a lovingly hand-crafted subcommand
- the human-friendly interface must perfectly mirror internal schema naming

## Auth proposal

- Support named profiles with explicit selection.
- Support both API keys and OAuth accounts.
- Store profile metadata separately from secrets where practical.
- Make active profile selection explicit and scriptable.
- Support per-command `--profile` override.
- Preserve room for multiple accounts from the same user and multiple workspaces.

Example shape:

```text
linear auth login --profile work-main --api-key-env LINEAR_API_KEY
linear auth oauth login --profile linear-app
linear account use work-main
linear issue list --profile secondary
```

## Output contract proposal

In `--json`, return a stable envelope:

```json
{
  "ok": true,
  "data": {},
  "pageInfo": null,
  "errors": [],
  "meta": {
    "profile": "work-main",
    "rateLimit": {},
    "complexity": {},
    "source": "resource-command"
  }
}
```

This should be pressure-tested against whether it is too opinionated versus just returning raw GraphQL.

## Implementation architecture proposal

### Repo layout

```text
linear-cli/
  package.json
  src/
    cli/
      main.ts
      command-registry.ts
    core/
      config/
      auth/
      transport/
      output/
      errors/
      pagination/
      schema/
    commands/
      auth/
      account/
      issue/
      project/
      cycle/
      team/
      user/
      label/
      comment/
      attachment/
      webhook/
      agent/
      file/
      gql/
      schema/
    generated/
      operations/
      types/
      manifest/
    skills/
      linear-cli/
      linear-raw-gql/
      linear-auth/
      linear-agent/
    templates/
      queries/
      mutations/
    tests/
      unit/
      integration/
      fixtures/
  docs/
    architecture/
    commands/
    skills/
```

## Skill suite seed

- `linear-cli`: default skill for routine Linear work through first-class commands
- `linear-raw-gql`: fallback skill for unsupported or highly custom API operations
- `linear-auth`: account/profile selection, OAuth flows, and secret handling
- `linear-agent`: guidance for Linear-native agent/session operations if those are included in CLI scope

## MVP suggestion

Phase 1 should likely ship:

- auth profiles
- raw GraphQL query/mutation command
- schema pull/introspect support
- first-class list/get/create/update flows for core resources
- stable JSON output
- pagination/filter/order flags
- rate-limit and complexity reporting

## Highest-risk design areas

1. Preventing generated parity commands from becoming unusable or noisy
2. Preserving stable JSON contracts while the schema evolves
3. Making multi-account auth obvious and safe
4. Handling files and uploads without awkward one-off flows
5. Deciding how much of agent-specific APIs belong in the main CLI
