# Output modes

## Default (human-readable)

Without any output flag, commands print human-readable text to stdout. This format is not stable and must not be parsed programmatically.

## --json

Data-only JSON. This is the primary machine-readable format.

```bash
linearctl issue get INF-42 --json
```

```json
{
  "id": "abc123",
  "identifier": "INF-42",
  "title": "Fix pagination bug",
  "state": { "name": "In Progress" },
  "priority": 2,
  "assignee": { "name": "Alice" }
}
```

The shape of `--json` output is a stable contract. Fields are not removed or renamed without a major version change. Issue output includes `projectMilestone` when an issue is attached to a project milestone.

For list commands, `--json` outputs a JSON array.
For some resources, single-item `get` commands intentionally return a richer object than each item in `list`; for example, `linearctl project get --json` includes detail fields like `progress`, `health`, `currentProgress`, and `milestones` (with description, sortOrder, createdAt, updatedAt).

For example, `linearctl project list --json` includes stable portfolio fields (`progress`, `health`, `currentProgress`), a normalized `milestones` array, and milestone connection metadata (`milestonesPageInfo`, `milestonesTruncated`) to indicate potential milestone truncation.

## --json-envelope

Wraps the response in an envelope with metadata:

```bash
linearctl issue list --team INF --json-envelope
```

```json
{
  "ok": true,
  "data": [ ... ],
  "pageInfo": {
    "hasNextPage": true,
    "endCursor": "abc123"
  },
  "errors": [],
  "meta": {
    "profile": "work",
    "sourceLayer": "curated"
  }
}
```

Use `--json-envelope` when you need:
- Pagination cursors (`pageInfo`)
- Error details alongside partial data
- Request metadata

Failures also emit a single envelope on stdout, including argument parsing, top-level validation, unknown or missing commands, and unexpected dispatch errors:

```json
{
  "ok": false,
  "data": null,
  "pageInfo": null,
  "errors": [{ "category": "validation", "message": "--team cannot be used with --all-teams" }],
  "meta": { "sourceLayer": "curated" }
}
```

`meta.sourceLayer` is `generated` for `api`, `raw-graphql` for `gql`, and `curated` otherwise (including unknown or missing commands). Validation failures exit with code 5; unexpected failures use the mapped error category and exit code, defaulting to `general` and code 1. The envelope flag may precede or follow the command, including an unknown command. Help, version, and curated metadata early-exit output remain unchanged.

## --jsonl

Streaming output. One JSON object per line. Requires an explicit pagination bound with `--all` or `--max <n>`.

```bash
linearctl issue list --team INF --max 100 --jsonl
```

```json
{"id":"abc","identifier":"INF-1","title":"First issue",...}
{"id":"def","identifier":"INF-2","title":"Second issue",...}
```

Use `--jsonl --max <n>` for bounded streams, or `--jsonl --all` only when you intentionally want every result.

## --raw

Available only for `linearctl gql` commands. Returns the exact GraphQL response body without normalization.

```bash
linearctl gql query '{ viewer { id name } }' --raw
```

```json
{
  "data": {
    "viewer": {
      "id": "abc123",
      "name": "Alice"
    }
  }
}
```

## Exit codes

| Code | Meaning | Typical action |
|---|---|---|
| 0 | Success | -- |
| 1 | General error | Read `errors[]` in envelope mode, otherwise stderr |
| 2 | Authentication error | Run `linearctl auth status`, re-authenticate |
| 3 | Rate limit exhausted | Wait, reduce result count, add filters |
| 4 | Not found | Verify identifier or ID |
| 5 | Validation error | Check flags and input |
| 6 | Schema drift | Update CLI, fall back to `linearctl gql` |

## Stderr

Without `--json-envelope`, errors are written as human-readable text to stderr (including in `--json` mode). With `--json-envelope`, failures are written to stdout as an envelope, without a duplicate error on stderr. Warnings may still appear on stderr. This separation is reliable for piping and redirection.
