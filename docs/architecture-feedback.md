# Architecture Feedback

## Findings

### 1. The CLI contract has no single source of truth, so drift is built in

The same command knowledge is duplicated in at least four places:

- Option definitions in `src/cli/main.ts:23-473`
- Top-level help text in `src/cli/main.ts:475-555`
- Manual parse/dispatch logic in `src/cli/main.ts:637-732` and `src/cli/main.ts:966-1411`
- Curated metadata manifest loading in `src/commands/metadata/curated-taxonomy.ts:1-19`

The metadata is only printed via `--metadata curated`; it does not drive help, parsing, or dispatch (`src/cli/main.ts:558-560`). That means the agent-facing contract is descriptive, not authoritative. For an "agent-first" CLI, this is the biggest architectural weakness: the interface most worth stabilizing is also the most manually duplicated.

### 2. Retry is architected as a global concern, but it is not actually wired into command execution

The docs advertise global retry flags (`docs/commands.md:3-5`), and there is a dedicated retry transport wrapper in `src/core/transport/retry.ts:18-48`. But the actual command dispatch paths pass only `executeGraphQL`-style inputs and never thread retry settings through (`src/cli/main.ts:968-1411`). The command option types shown in representative handlers also omit retry fields entirely, for example:

- `src/commands/api.ts:14-32`
- `src/commands/issue.ts:23-69`
- `src/commands/project.ts:15-39`

`executeGraphQLWithRetry` appears to be used only in tests, not production code (`tests/core/transport/retry.test.ts:23-134`). Architecturally, this is a sign that cross-cutting concerns are not centralized enough; they can be added "on paper" without actually reaching runtime behavior.

### 3. Curated commands are implemented as large, repetitive vertical slices instead of sharing a common command runtime

The layering is conceptually clean, but each curated handler repeats the same lifecycle:

1. Resolve profile
2. Build/resolve inputs
3. Call GraphQL
4. Map errors
5. Emit JSON / envelope / human output

You can see the pattern repeated in:

- `src/commands/issue.ts:265-344`
- `src/commands/project.ts:184-264`
- `src/commands/project.ts:266-367`
- `src/commands/gql.ts:66-143`
- `src/commands/api.ts:219-390`

This works today, but it scales poorly. Any change to envelope behavior, profile handling, retry, logging, or rate-limit metadata has to be propagated across many handlers rather than updated in one command execution abstraction. The current structure optimizes for straightforward implementation, not long-term maintainability.

### 4. Multi-step workflows live directly in command handlers without an orchestration boundary or compensation strategy

`project create-with-issues` is the clearest example. It:

- Creates a project
- Then batch-creates issues against the new project
- Returns a general error if the second step fails, while explicitly noting the project already exists

See `src/commands/project.ts:651-724`.

That means the CLI exposes partially completed workflows, but the orchestration semantics are embedded ad hoc in the command rather than modeled as a reusable workflow layer with typed partial-success results or compensation hooks. That is survivable for one command, but it becomes messy if more agent-oriented workflows are added.

### 5. The generated layer is clever, but its command naming is heuristic-heavy and therefore brittle

The manifest generator derives resource and operation names from schema field names using suffix rules, pluralization heuristics, and collision resolution:

- Mutation naming: `src/generated/generate-manifest.ts:106-132`
- Query naming: `src/generated/generate-manifest.ts:134-166`
- Input-mode inference: `src/generated/generate-manifest.ts:211-223`
- Collision resolution: `src/generated/generate-manifest.ts:286-345`

That is a reasonable escape hatch, but it means generated command UX is only as stable as Linear's schema naming conventions. Since the generated layer is part of the product, not just an internal detail, this creates a maintenance burden whenever schema naming gets weird or shifts over time.

## What's Good

- **The three-layer model is strong.** Curated vs generated vs raw GraphQL is a good product architecture, and it is consistently reflected in docs and code (`docs/agent-usage.md:5-13`, `src/core/output/envelope.ts:3-35`).

- **The JSON envelope is clean and minimal.** `ok`/`data`/`pageInfo`/`errors`/`meta` is a solid machine contract (`src/core/output/envelope.ts:29-67`).

- **Auth/config separation is sensible.** Keeping config metadata separate from credentials and handling OAuth refresh in runtime resolution is a good boundary (`src/core/auth/runtime.ts:43-119`, `src/commands/auth.ts:215-224`).

- **Build-time manifest generation is the right idea for standalone binaries.** Shipping bundled manifests instead of depending on live introspection at runtime is a good fit for the repo's distribution goals (`src/commands/api.ts:38-60`, `src/generated/generate-manifest.ts:393-423`, `package.json:10-17`).

- **Test coverage is broad.** The project is not under-tested; the issue is more architectural shape than lack of verification.

## What I'd Change First

1. **Make command metadata authoritative.** Drive help text, option schemas, and dispatch from a typed command registry instead of manually maintaining them in `src/cli/main.ts`.

2. **Introduce a shared command runtime/context.** Something like:
   - Resolve profile once
   - Provide `graphql()` / `graphqlWithRetry()`
   - Standardize envelope/error emission
   - Standardize output selection

   This would remove a lot of repetition from curated handlers.

3. **Actually wire retry through the runtime.** Either remove `--no-retry` / `--max-retries` until implemented, or make every command go through the retry-capable transport path.

4. **Separate workflow orchestration from single-resource handlers.** Commands like `project create-with-issues` should go through a workflow abstraction with explicit partial-success modeling.

5. **Treat generated naming as a product surface.** Either annotate exceptions explicitly or maintain a small override table so generated command names are not entirely heuristic.

## Bottom Line

The repo has a solid product architecture and good foundational modules, but the implementation architecture is still too hand-wired. The biggest problem is not the GraphQL/auth/pagination core; it's that the CLI surface is maintained by duplication instead of composition. That will slow down future changes and make agent-facing contracts drift unless the registry/runtime becomes the real source of truth.
