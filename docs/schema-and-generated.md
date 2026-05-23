# Schema and generated API

## Schema management

The CLI bundles a snapshot of the Linear GraphQL schema. Schema commands let you check for drift and update the local snapshot.

### Check bundled version

```bash
linearctl schema version --json
```

Returns the bundled schema version fingerprint.

### Pull latest schema

```bash
linearctl schema pull --json
```

Runs a live introspection query against the Linear API, writes the schema files, and updates the schema metadata manifest. Defaults to writing to `src/generated/manifest/`. Override with:

```bash
linearctl schema pull --output-dir /path/to/output --json
```

### Check for drift

```bash
linearctl schema check --json
```

Compares the bundled schema against the live API. Reports added/removed types and fields. Exits with code 6 if drift is detected.

### Startup freshness warning

For normal commands, `linearctl` checks schema freshness at most once per day when the bundled schema is older than the configured threshold. The default threshold is 14 days. If the live Linear API schema has drifted, the command continues and a warning is printed to stderr:

```text
Warning: linearctl schema is 38 days old. Run `linearctl schema pull` to update, or `linearctl schema check` for details.
```

Configure the threshold and optional automatic updates in `~/.config/linear/config`. The config-file spelling for the `schema.autoUpdate` option is `auto_update` inside the `[schema]` section:

```ini
[schema]
stale_after_days = 14
auto_update = false
```

When `auto_update = true`, `linearctl` automatically pulls and writes the refreshed schema under `~/.config/linear/schema/` after drift is detected. The default is `false`, so users get warn-only behavior unless they opt in. Startup checks are advisory and never block command execution if the freshness check cannot run.

GraphQL HTTP 400 errors that look like missing fields or types also include a stale-schema hint so drift is diagnosable even when the startup check has not run.

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
linearctl api --help

# List operations for a specific resource
linearctl api <resource> --help

# Search across all generated commands
linearctl api search <term>
```

### Execute commands

```bash
# Simple read with ID
linearctl api <resource> <operation> --id <id> --json

# Operation with JSON input
linearctl api <resource> <operation> --input-json '{"name":"test"}' --json

# Input from file
linearctl api <resource> <operation> --input-file input.json --json

# Input from stdin
echo '{"name":"test"}' | linearctl api <resource> <operation> --input-stdin --json

# Select specific fields
linearctl api <resource> <operation> --id <id> --fields "id,name,description" --json
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

This reads the schema and produces the manifest file that drives `linearctl api` commands.
