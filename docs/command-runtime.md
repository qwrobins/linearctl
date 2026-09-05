# Command runtime

Command handlers extend `CommandOptions` from `src/core/runtime/options.ts` and add only operation-specific flags. Output-only commands can extend `CommandOutputOptions` instead.

- Use `createCommandContext(options)` for profile resolution, GraphQL, resolver dependencies, retry normalization, and standard success/failure output.
- `ctx.resolveProfile()` caches the selected profile. Selection remains explicit `profile`, then `env.LINEAR_PROFILE`, then the configured default. An explicit API URL overrides the profile's base URL.
- The same `fetchImpl` handles OAuth refresh, GraphQL, and name resolution. Do not resolve a profile through a separate uninjected transport.
- Use `commandIO(options)` or `ctx.stdout`/`ctx.stderr` for human-readable output and JSONL. Pass the options through to validation, dry-run, pagination, and retry helpers so diagnostics use the same streams.
- `stdout` and `stderr` are optional minimal writable objects. They default to the process streams, but no global runtime or stream replacement is installed. `main()` forwards its supplied streams to every registry handler and the advisory schema freshness check.

Use `tests/helpers/output.ts` to capture injected output in tests. Concurrent command invocations can use independent streams and transports.

## Issue commands

`src/commands/issue.ts` retains registry dispatch and the existing public exports. Implementation lives in `src/commands/issue/`:

| Module | Responsibility |
| --- | --- |
| `options.ts` | Issue-specific flags |
| `documents.ts` | Shared GraphQL fragments and documents |
| `model.ts` | Response types, normalization, human formatting |
| `input.ts` | Input validation, filters, and shared issue lookup |
| `read.ts` | Get, list, and search |
| `write.ts` | Create, update, and delete |
| `workflow.ts` | Close, assign, comment, and Slack attachment |
| `bulk.ts` | Bulk execution and partial-failure contracts |

Specialized envelopes remain in handlers where their contracts differ from standard context output, such as raw GraphQL partial data, bulk partial failures, and schema metadata. CLI flags, JSON shapes, and exit-code contracts are unchanged.
