---
name: linear-agent-raw-gql
description: Raw GraphQL fallback for the Linear API — direct queries, mutations, and introspection when curated/generated commands don't cover the operation
---

# linear-agent-raw-gql

Fallback skill for direct GraphQL access to the Linear API. Use only when no curated command and no generated command exists for the operation, or the user explicitly asks for raw GraphQL.

## When to use

- No curated command covers the operation
- No generated command covers the operation (check with `linear-agent api search <term>`)
- The user explicitly asks for raw GraphQL
- The curated/generated layers lag behind a new Linear API feature

## Commands

### Query
```bash
linear-agent gql query '{ viewer { id name email } }' --json
linear-agent gql query --file query.graphql --vars-file vars.json --json
cat query.graphql | linear-agent gql query --stdin --json
```

### Mutation
```bash
linear-agent gql mutation 'mutation { issueCreate(input: {...}) { success } }' --json
linear-agent gql mutation --file mutation.graphql --vars-file vars.json --json-envelope
```

### Introspect
```bash
linear-agent gql introspect --json
```

## Output modes

Raw GraphQL commands require exactly one output mode:
- `--json` — returns the `data` payload only (no partial data on errors)
- `--json-envelope` — includes `ok`, `data`, `errors`, `pageInfo`, `meta`
- `--raw` — exact GraphQL response body, including partial data and errors

## Variable input

- `--var key=value` — repeated for multiple variables, values auto-parsed as JSON when possible
- `--vars-file <path>` — JSON file with variable object
- Inline vars override file vars

## Error handling

- Exit code 0 on success, 1 on GraphQL errors
- In `--json` mode, no stdout on error (errors to stderr)
- In `--json-envelope`, errors included in envelope
- In `--raw`, exact response body always emitted

## Anti-patterns

- Do not use raw GraphQL when curated or generated commands exist
- Do not use `--raw` unless explicitly debugging
- Do not construct complex queries when `linear-agent api` or curated commands handle the use case
- Always prefer deterministic command discovery over ad-hoc GraphQL construction
