/**
 * Command registry types.
 * The registry is the single source of truth for CLI command structure,
 * driving help text, option parsing, dispatch, and agent-facing metadata.
 */

export interface SubcommandMeta {
  /** Usage line for help text, e.g. "linearctl issue get <identifier> [--json]" */
  usage: string;
}

export interface CommandRegistration {
  /** Top-level command name, e.g. "issue", "project", "auth" */
  name: string;
  /** Option names from the catalog that this command accepts */
  optionKeys: readonly string[];
  /** Subcommand metadata for help text and agent discovery */
  subcommands: Record<string, SubcommandMeta>;
  /** Handler function — receives subcommand positionals and the full parsed args */
  handler: CommandHandler;
  /** Build the handler-specific options from ParsedCliArguments */
  buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream) => unknown;
}

export type CommandHandler = (positionals: string[], options: any) => Promise<number>;

/**
 * The intermediate parsed CLI arguments type.
 * This is the normalized form after parseArgs processing.
 */
export interface ParsedCliArguments {
  help: boolean;
  version: boolean;
  json: boolean;
  jsonEnvelope: boolean;
  jsonl: boolean;
  metadata?: string;
  configFile: string;
  credentialsFile: string;
  profile?: string;
  apiKeyEnv?: string;
  apiKeyStdin: boolean;
  oauth: boolean;
  oauthClientId?: string;
  callbackPort?: string;
  noBrowser: boolean;
  setDefault: boolean;
  removeConfig: boolean;
  apiUrl?: string;
  raw: boolean;
  stdin: boolean;
  file?: string;
  varsFile?: string;
  vars: string[];
  outputDir?: string;
  title?: string;
  team?: string;
  description?: string;
  priority?: string;
  estimate?: string;
  assignee?: string;
  label?: string;
  state?: string;
  inputJson?: string;
  issuesJson?: string;
  ids?: string;
  inputFile?: string;
  inputStdin: boolean;
  id?: string;
  fields?: string;
  name?: string;
  color?: string;
  position?: string;
  stateType?: string;
  statusType?: string;
  targetDate?: string;
  startsAt?: string;
  endsAt?: string;
  body?: string;
  issue?: string;
  url?: string;
  output?: string;
  expiresIn?: string;
  query?: string;
  filterJson?: string;
  createdAfter?: string;
  updatedAfter?: string;
  completedAfter?: string;
  cycle?: string;
  project?: string;
  milestone?: string;
  projectMilestone?: string;
  orderBy?: string;
  orderDir?: string;
  all: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  sync: boolean;
  dryRun: boolean;
  quiet: boolean;
  allTeams: boolean;
  scope?: string;
  parent?: string;
  noRetry: boolean;
  maxRetries?: number;
  positionals: string[];
}
