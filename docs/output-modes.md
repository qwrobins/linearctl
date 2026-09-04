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
    "timestamp": "2025-01-15T10:30:00Z"
  }
}
```

Use `--json-envelope` when you need:
- Pagination cursors (`pageInfo`)
- Error details alongside partial data
- Request metadata

## Composite workflow failures

`file upload --issue` and `project create-with-issues` do not roll back completed resources. Once their workflow starts, failures return an `ok: false` envelope on stdout in **both** `--json` and `--json-envelope` modes (successful output is unchanged). Preflight errors still use the command's normal error output.

The failure envelope keeps `data: null` and reports:

- `meta.partial`: whether an earlier step completed successfully.
- `errors[].category`, `message`, and optional `code`: the mapped failure, not a generic replacement. Original structured details are retained in `errors[].details.cause`.
- `errors[].details.workflow`: `ok`, `partialSuccess`, `exitCode`, original `errors`, `steps`, and `completed`.
- `workflow.steps.first` / `second`: each has a `name` and `status` (`success`, `failed`, or `skipped`), with a `result`, structured `errors`, or a skip `reason`, respectively.
- `workflow.completed.first`: confirmed upload metadata or the created project. A failed first step leaves `completed` empty and skips the second step. Failure while constructing the second step also preserves the first result.
- `errors[].details.recovery`: guidance for reusing completed resources. For convenience, details also include upload fields (`assetUrl`, `fileName`, `contentType`, `size`) or `project` directly.

An upload is marked completed only after the storage PUT succeeds; signed upload URLs and headers are not included. Authentication, rate-limit, not-found, and validation failures retain their meaningful nonzero exit codes, even after partial success. Human output reports completed resources and recovery guidance on stderr.

### Recover without recreating resources

Capture failure output even when the command exits nonzero (avoid chaining recovery with `&&`):

```bash
linearctl file upload screenshot.png --issue INF-42 --json-envelope > upload-result.json
# If errors[0].details.workflow.partialSuccess is true:
asset_url=$(jq -r '.errors[0].details.assetUrl' upload-result.json)
linearctl attachment list --issue INF-42 --json
# If the attachment does not already exist, reuse the uploaded asset:
linearctl attachment create --issue INF-42 --url "$asset_url" --title screenshot.png --json-envelope
```

For project creation, reuse the reported project ID rather than rerunning `create-with-issues`:

```bash
project_id=$(jq -r '.errors[0].details.project.id' project-result.json)
linearctl issue list --project "$project_id" --all --json
# Create only missing issues, retaining their original fields:
linearctl issue create --project "$project_id" --team INF --title 'Missing task' --json-envelope
```

Fix authentication or wait for the rate limit before retrying the failed operation. A transport failure can mean the server committed the second mutation but its response was lost: `failed` means success was not confirmed, not that no write occurred. Inspect existing attachments/issues before retrying to avoid duplicates. Neither workflow automatically retries the whole command or deletes completed resources.

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
| 1 | General error | Read stderr for details |
| 2 | Authentication error | Run `linearctl auth status`, re-authenticate |
| 3 | Rate limit exhausted | Wait, reduce result count, add filters |
| 4 | Not found | Verify identifier or ID |
| 5 | Validation error | Check flags and input |
| 6 | Schema drift | Update CLI, fall back to `linearctl gql` |

## Stderr

Human-readable errors and warnings are written to stderr. Structured failures in `--json-envelope` (and the composite `--json` failures described above) are written to stdout. Stdout contains only the requested output, so it can be redirected or piped separately from warnings.
