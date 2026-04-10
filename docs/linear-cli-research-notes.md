# Linear CLI Research Notes

## Confirmed platform facts

### API shape

- Linear's public API is GraphQL at `https://api.linear.app/graphql`.
- The API supports introspection, which makes schema-driven generation feasible.
- The official TypeScript SDK is itself generated from the production schema and also exposes a raw GraphQL client.

Sources:

- `https://linear.app/developers/graphql`
- `https://linear.app/developers/sdk`
- `https://linear.app/developers/advanced-usage`
- `https://github.com/linear/linear`

### Auth

- Personal API keys are supported and are the easiest path for personal scripts.
- OAuth2 is supported for broader integrations.
- OAuth apps now use refresh tokens; access tokens are short-lived.
- OAuth authorization supports `actor=user` and `actor=app`.
- Agent/app installs can request scopes such as `app:assignable` and `app:mentionable`.

Sources:

- `https://linear.app/developers/graphql`
- `https://linear.app/developers/oauth-2-0-authentication`
- `https://linear.app/developers/agents`

### Pagination and filtering

- List responses use Relay-style cursor pagination with `first`/`after` and `last`/`before`.
- Default list size is 50.
- `orderBy` is commonly available and important for efficient incremental sync patterns.
- Filtering supports comparators like `eq`, `neq`, `in`, `nin`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`, `null`, plus logical `or`.
- Filtering across relationships is first-class.

Sources:

- `https://linear.app/developers/pagination`
- `https://linear.app/developers/filtering`
- `https://linear.app/developers/sdk-fetching-and-modifying-data`

### Rate limiting and query complexity

- Linear uses request-rate limits and query complexity limits.
- Relevant headers include request and complexity budgets.
- GraphQL rate limit errors are surfaced in the response body with `errors[*].extensions.code = RATELIMITED` and HTTP 400.
- The maximum complexity for a single query is 10,000.
- Avoiding over-fetching and default pagination blowups is explicitly recommended.

Sources:

- `https://linear.app/developers/rate-limiting`

### Files and attachments

- Uploaded files live under `https://uploads.linear.app` and require auth.
- Signed file URLs can be requested via the `public-file-urls-expire-in` header.
- Attachments are URL-centric and idempotent by URL + issue combination.
- Attachment metadata supports rich structured payloads.

Sources:

- `https://linear.app/developers/file-storage-authentication`
- `https://linear.app/developers/attachments`

### Webhooks and admin boundaries

- Webhooks exist both in UI configuration and via API.
- Reading or creating webhooks requires workspace admin or OAuth app `admin` scope.
- Webhook setup is organization-scoped with team-level targeting.

Sources:

- `https://linear.app/developers/webhooks`

### Deprecations and API evolution

- Linear does not version the GraphQL API in the REST sense.
- Deprecations are signaled in the schema with `@deprecated` and in the changelog.
- Any parity strategy must expect ongoing schema drift.

Sources:

- `https://linear.app/developers/deprecations`
- `https://linear.app/changelog`

### Agent-specific guidance relevant to skills

- Linear expects agents to disclose themselves and work natively in platform workflows.
- Agent sessions and activities are first-class primitives.
- Initial agent acknowledgement should happen within 10 seconds in Linear-native flows.
- Signals such as `stop`, `auth`, and `select` are part of the interaction model.
- Agent guidance strongly favors visible progress, structured elicitation, and reliable state transitions.

Sources:

- `https://linear.app/developers/aig`
- `https://linear.app/developers/agents`
- `https://linear.app/developers/agent-interaction`
- `https://linear.app/developers/agent-best-practices`
- `https://linear.app/developers/agent-signals`

## Implications for the CLI proposal

1. A parity-focused CLI should be schema-aware, not purely hand-written.
2. A raw GraphQL command is required for immediate coverage and future-proofing.
3. Multi-account auth is a first-order requirement, not a convenience feature.
4. Output contracts should preserve headers, page info, and error metadata in JSON mode.
5. Rate-limit and complexity observability should be exposed to users and skills.
6. File commands need first-class handling rather than being treated as normal GraphQL output.
7. The skill suite should prefer specific commands first, then fall back to raw GraphQL when coverage is missing.
