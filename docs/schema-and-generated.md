# Schema and generated API

## Schema management

The CLI bundles a snapshot of the Linear GraphQL schema. Schema commands let you check for drift and update the local snapshot.

### Check bundled version

```bash
linear schema version --json
```

Returns the bundled schema version fingerprint.

### Pull latest schema

```bash
linear schema pull --json
```

Runs a live introspection query against the Linear API, writes the schema files, and updates the schema metadata manifest. Defaults to writing to `src/generated/manifest/`. Override with:

```bash
linear schema pull --output-dir /path/to/output --json
```

### Check for drift

```bash
linear schema check --json
```

Compares the bundled schema against the live API. Reports added/removed types and fields. Exits with code 6 if drift is detected.

### Regenerate for CI

```bash
bun run regenerate:schema
```

Pulls the latest schema, diffs against the bundled version, detects breaking changes, and exits non-zero if breaking changes are found. Use this in CI to catch schema drift early.

The diff reports:
- Added and removed types
- Added and removed fields
- Whether changes are breaking (removals)

## Generated API layer

The generated layer provides commands for Linear API resources not covered by curated commands. Commands are driven by a manifest generated from the schema.

### Discover resources

```bash
# List all available resources
linear api --help

# List operations for a specific resource
linear api <resource> --help

# Search across all generated commands
linear api search <term>
```

### Execute commands

```bash
# Simple read with ID
linear api <resource> <operation> --id <id> --json

# Operation with JSON input
linear api <resource> <operation> --input-json '{"name":"test"}' --json

# Input from file
linear api <resource> <operation> --input-file input.json --json

# Input from stdin
echo '{"name":"test"}' | linear api <resource> <operation> --input-stdin --json

# Select specific fields
linear api <resource> <operation> --id <id> --fields "id,name,description" --json
```

### When to use generated vs curated

Use curated commands when they exist. They provide:
- Name resolution (team names, user emails, state names)
- Pagination helpers (`--all`, `--max`)
- Structured filter flags
- Normalized output contracts

Use generated commands when no curated command covers the operation. Generated commands cover the full API surface but without the convenience features.

### Regenerate the manifest

After pulling a new schema, regenerate the API command manifest:

```bash
bun run generate:api-manifest
```

This reads the schema and produces the manifest file that drives `linear api` commands.
