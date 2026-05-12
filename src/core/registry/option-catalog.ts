/**
 * Master catalog of all CLI option specifications.
 * This is the single source of truth for what options exist and their types.
 * Individual commands reference option names from this catalog.
 */

export interface OptionSpec {
  type: "boolean" | "string";
  short?: string;
  multiple?: true;
}

export const OPTION_CATALOG: Record<string, OptionSpec> = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  json: { type: "boolean" },
  "json-envelope": { type: "boolean" },
  jsonl: { type: "boolean" },
  metadata: { type: "string" },
  config: { type: "string" },
  "config-file": { type: "string" },
  credentials: { type: "string" },
  "credentials-file": { type: "string" },
  profile: { type: "string" },
  "api-key-env": { type: "string" },
  "api-key-stdin": { type: "boolean" },
  oauth: { type: "boolean" },
  "set-default": { type: "boolean" },
  "remove-config": { type: "boolean" },
  "api-url": { type: "string" },
  raw: { type: "boolean" },
  stdin: { type: "boolean" },
  file: { type: "string" },
  "vars-file": { type: "string" },
  var: { type: "string", multiple: true },
  "output-dir": { type: "string" },
  title: { type: "string" },
  team: { type: "string" },
  description: { type: "string" },
  priority: { type: "string" },
  estimate: { type: "string" },
  assignee: { type: "string" },
  label: { type: "string" },
  state: { type: "string" },
  "input-json": { type: "string" },
  "input-file": { type: "string" },
  "input-stdin": { type: "boolean" },
  id: { type: "string" },
  fields: { type: "string" },
  body: { type: "string" },
  "filter-json": { type: "string" },
  "created-after": { type: "string" },
  "updated-after": { type: "string" },
  "completed-after": { type: "string" },
  cycle: { type: "string" },
  project: { type: "string" },
  "order-by": { type: "string" },
  "order-dir": { type: "string" },
  all: { type: "boolean" },
  max: { type: "string" },
  "page-size": { type: "string" },
  after: { type: "string" },
  name: { type: "string" },
  "target-date": { type: "string" },
  "starts-at": { type: "string" },
  "ends-at": { type: "string" },
  color: { type: "string" },
  "no-retry": { type: "boolean" },
  "max-retries": { type: "string" },
  "all-teams": { type: "boolean" },
  issue: { type: "string" },
  url: { type: "string" },
  output: { type: "string" },
  "expires-in": { type: "string" },
  ids: { type: "string" },
  "oauth-client-id": { type: "string" },
  "callback-port": { type: "string" },
  "no-browser": { type: "boolean" },
  query: { type: "string" },
  quiet: { type: "boolean", short: "q" },
  "dry-run": { type: "boolean" },
  sync: { type: "boolean" },
  "issues-json": { type: "string" },
  "state-type": { type: "string" },
  "status-type": { type: "string" },
  position: { type: "string" },
  scope: { type: "string" },
  parent: { type: "string" },
};

/** Reusable option groups that commands compose from */
export const OPTION_GROUPS = {
  global: ["help", "json", "json-envelope", "config", "config-file", "credentials", "credentials-file", "profile", "api-url"] as const,
  retry: ["no-retry", "max-retries"] as const,
  pagination: ["all", "max", "page-size", "after"] as const,
  streaming: ["jsonl", "quiet"] as const,
  dryRun: ["dry-run"] as const,
  allTeams: ["all-teams"] as const,
} as const;

/**
 * Build a parseArgs-compatible option definitions object from a list of option names.
 */
export function buildOptionDefinitions(keys: readonly string[]): Record<string, OptionSpec> {
  const result: Record<string, OptionSpec> = {};
  for (const key of keys) {
    const spec = OPTION_CATALOG[key];
    if (spec === undefined) {
      throw new Error(`Unknown option "${key}" in option catalog`);
    }
    result[key] = spec;
  }
  return result;
}
