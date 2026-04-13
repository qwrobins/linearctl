#!/usr/bin/env node
import { parseArgs } from "node:util";
import { handleAuthCommand } from "../commands/auth.js";
import { handleCycleCommand } from "../commands/cycle.js";
import { handleFileCommand } from "../commands/file.js";
import { handleGqlCommand } from "../commands/gql.js";
import { handleIssueCommand } from "../commands/issue.js";
import { handleCommentCommand } from "../commands/comment.js";
import { handleApiCommand } from "../commands/api.js";
import { handleAttachmentCommand } from "../commands/attachment.js";
import { handleLabelCommand } from "../commands/label.js";
import { handleProjectCommand } from "../commands/project.js";
import { handleSchemaCommand } from "../commands/schema.js";
import { handleTeamCommand } from "../commands/team.js";
import { handleUserCommand } from "../commands/user.js";
import { handleProjectStatusCommand } from "../commands/project-status.js";
import { handleStateCommand } from "../commands/state.js";
import { handleWorkspaceCommand } from "../commands/workspace.js";
import { handleSkillsCommand } from "../commands/skills.js";
import { curatedCommandMetadata, defaultLinearConfigPaths, ExitCode } from "../index.js";

const CLI_OPTION_DEFINITIONS = {
  help: { type: "boolean", short: "h" },
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
  "order-by": { type: "string" },
  "order-dir": { type: "string" },
  all: { type: "boolean" },
  max: { type: "string" },
  "page-size": { type: "string" },
  after: { type: "string" },
  name: { type: "string" },
  "starts-at": { type: "string" },
  "ends-at": { type: "string" },
  color: { type: "string" },
  "no-retry": { type: "boolean" },
  "max-retries": { type: "string" },
  everything: { type: "boolean" },
  issue: { type: "string" },
  url: { type: "string" },
  output: { type: "string" },
  "expires-in": { type: "string" },
  ids: { type: "string" },
  "oauth-client-id": { type: "string" },
  "callback-port": { type: "string" },
  "no-browser": { type: "boolean" },
  "dry-run": { type: "boolean" },
  "state-type": { type: "string" },
  "status-type": { type: "string" },
  position: { type: "string" },
  scope: { type: "string" }
} as const;

const AUTH_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,

  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-key-env": CLI_OPTION_DEFINITIONS["api-key-env"],
  "api-key-stdin": CLI_OPTION_DEFINITIONS["api-key-stdin"],
  oauth: CLI_OPTION_DEFINITIONS.oauth,
  "set-default": CLI_OPTION_DEFINITIONS["set-default"],
  "remove-config": CLI_OPTION_DEFINITIONS["remove-config"],
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "oauth-client-id": CLI_OPTION_DEFINITIONS["oauth-client-id"],
  "callback-port": CLI_OPTION_DEFINITIONS["callback-port"],
  "no-browser": CLI_OPTION_DEFINITIONS["no-browser"],
} as const;

const GQL_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  raw: CLI_OPTION_DEFINITIONS.raw,
  stdin: CLI_OPTION_DEFINITIONS.stdin,
  file: CLI_OPTION_DEFINITIONS.file,
  "vars-file": CLI_OPTION_DEFINITIONS["vars-file"],
  var: CLI_OPTION_DEFINITIONS.var,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const SCHEMA_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "output-dir": CLI_OPTION_DEFINITIONS["output-dir"],
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const ISSUE_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  everything: CLI_OPTION_DEFINITIONS.everything,
  title: CLI_OPTION_DEFINITIONS.title,
  team: CLI_OPTION_DEFINITIONS.team,
  description: CLI_OPTION_DEFINITIONS.description,
  priority: CLI_OPTION_DEFINITIONS.priority,
  assignee: CLI_OPTION_DEFINITIONS.assignee,
  label: CLI_OPTION_DEFINITIONS.label,
  state: CLI_OPTION_DEFINITIONS.state,
  "input-json": CLI_OPTION_DEFINITIONS["input-json"],
  ids: CLI_OPTION_DEFINITIONS.ids,
  body: CLI_OPTION_DEFINITIONS.body,
  "filter-json": CLI_OPTION_DEFINITIONS["filter-json"],
  "order-by": CLI_OPTION_DEFINITIONS["order-by"],
  "order-dir": CLI_OPTION_DEFINITIONS["order-dir"],
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const PROJECT_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  everything: CLI_OPTION_DEFINITIONS.everything,
  name: CLI_OPTION_DEFINITIONS.name,
  description: CLI_OPTION_DEFINITIONS.description,
  team: CLI_OPTION_DEFINITIONS.team,
  state: CLI_OPTION_DEFINITIONS.state,
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const CYCLE_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  everything: CLI_OPTION_DEFINITIONS.everything,
  name: CLI_OPTION_DEFINITIONS.name,
  description: CLI_OPTION_DEFINITIONS.description,
  team: CLI_OPTION_DEFINITIONS.team,
  "starts-at": CLI_OPTION_DEFINITIONS["starts-at"],
  "ends-at": CLI_OPTION_DEFINITIONS["ends-at"],
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const TEAM_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "set-default": CLI_OPTION_DEFINITIONS["set-default"],
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const USER_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const LABEL_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  everything: CLI_OPTION_DEFINITIONS.everything,
  name: CLI_OPTION_DEFINITIONS.name,
  description: CLI_OPTION_DEFINITIONS.description,
  color: CLI_OPTION_DEFINITIONS.color,
  team: CLI_OPTION_DEFINITIONS.team,
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const STATE_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  everything: CLI_OPTION_DEFINITIONS.everything,
  name: CLI_OPTION_DEFINITIONS.name,
  "state-type": CLI_OPTION_DEFINITIONS["state-type"],
  description: CLI_OPTION_DEFINITIONS.description,
  color: CLI_OPTION_DEFINITIONS.color,
  position: CLI_OPTION_DEFINITIONS.position,
  team: CLI_OPTION_DEFINITIONS.team,
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const PROJECT_STATUS_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  name: CLI_OPTION_DEFINITIONS.name,
  "status-type": CLI_OPTION_DEFINITIONS["status-type"],
  description: CLI_OPTION_DEFINITIONS.description,
  color: CLI_OPTION_DEFINITIONS.color,
  position: CLI_OPTION_DEFINITIONS.position,
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const COMMENT_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  issue: CLI_OPTION_DEFINITIONS.issue,
  body: CLI_OPTION_DEFINITIONS.body,
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const ATTACHMENT_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  jsonl: CLI_OPTION_DEFINITIONS.jsonl,
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  issue: CLI_OPTION_DEFINITIONS.issue,
  url: CLI_OPTION_DEFINITIONS.url,
  title: CLI_OPTION_DEFINITIONS.title,
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const FILE_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "dry-run": CLI_OPTION_DEFINITIONS["dry-run"],
  issue: CLI_OPTION_DEFINITIONS.issue,
  output: CLI_OPTION_DEFINITIONS.output,
  "expires-in": CLI_OPTION_DEFINITIONS["expires-in"],
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

const WORKSPACE_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
} as const;

const SKILLS_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  scope: CLI_OPTION_DEFINITIONS.scope,
} as const;

const API_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  id: CLI_OPTION_DEFINITIONS.id,
  "input-json": CLI_OPTION_DEFINITIONS["input-json"],
  "input-file": CLI_OPTION_DEFINITIONS["input-file"],
  "input-stdin": CLI_OPTION_DEFINITIONS["input-stdin"],
  fields: CLI_OPTION_DEFINITIONS.fields,
  raw: CLI_OPTION_DEFINITIONS.raw,
  "no-retry": CLI_OPTION_DEFINITIONS["no-retry"],
  "max-retries": CLI_OPTION_DEFINITIONS["max-retries"],
} as const;

function printTopLevelHelp(): void {
  process.stdout.write(`linearctl

Agent-first Linear CLI.

Layers:
  curated       linearctl <resource> ...
  generated     linearctl api ...
  raw GraphQL   linearctl gql ...

Commands:
  linearctl issue get <identifier> [--json]
  linearctl issue create --title <title> --team <id> [--json]
  linearctl issue list [--state <name>] [--assignee <id>] [--team <id>] [--everything] [--json]
  linearctl issue update <identifier> [--title ...] [--state ...] [--json]
  linearctl issue close <identifier> [--json]
  linearctl issue assign <identifier> <assignee-id> [--json]
  linearctl issue comment <identifier> --body <text> [--json]
  linearctl issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] [--priority <0-4>] [--label <id>] [--json]
  linearctl issue bulk-close --ids <id1,id2,...> [--json]
  linearctl issue bulk-assign --ids <id1,id2,...> --assignee <id> [--json]
  linearctl project get <id> [--json]
  linearctl project list [--team <id>] [--everything] [--json]
  linearctl project create --name <name> [--description ...] [--team <id>] [--json]
  linearctl project update <id> [--name ...] [--state ...] [--json]
  linearctl project delete <id> [--json]
  linearctl cycle get <id> [--json]
  linearctl cycle list [--team <id>] [--everything] [--json]
  linearctl cycle create --team <id> [--name ...] [--starts-at ...] [--ends-at ...] [--json]
  linearctl cycle update <id> [--name ...] [--starts-at ...] [--ends-at ...] [--json]
  linearctl team get <id-or-key> [--set-default] [--json]
  linearctl team list [--json]
  linearctl user get <id> [--json]
  linearctl user me [--json]
  linearctl user list [--json]
  linearctl label get <id> [--json]
  linearctl label list [--team <id>] [--everything] [--json]
  linearctl label create --name <name> [--description ...] [--color ...] [--team <id>] [--json]
  linearctl label delete <id> [--json]
  linearctl state get <id> [--json]
  linearctl state list [--team <id>] [--everything] [--json]
  linearctl state create --name <name> --team <id> --state-type <type> [--json]
  linearctl project-status list [--json]
  linearctl project-status get <id> [--json]
  linearctl project-status create --name <name> --status-type <type> [--json]
  linearctl project-status delete <id> [--json]
  linearctl comment list --issue <id> [--json]
  linearctl comment create --issue <id> --body <text> [--json]
  linearctl comment update <id> --body <text> [--json]
  linearctl comment delete <id> [--json]
  linearctl attachment list --issue <id> [--json]
  linearctl attachment create --issue <id> --url <url> --title <title> [--json]
  linearctl attachment delete <id> [--json]
  linearctl file upload <path> [--issue <id>] [--json]
  linearctl file url <attachment-id> [--expires-in <seconds>] [--json]
  linearctl file download <url> [--output <path>] [--json]
  linearctl api <resource> <operation> [--id <id>] [--input-json <json>] [--fields <f1,f2>] [--json]
  linearctl api --help                 (list resources)
  linearctl api <resource> --help      (list operations)
  linearctl api search <term>          (search commands)
  linearctl auth login --profile <name> --api-key-env <ENV>
  linearctl auth logout --profile <name>
  linearctl auth status [--json]
  linearctl auth switch <profile>
  linearctl auth whoami [--json]
  linearctl workspace list [--json]
  linearctl gql introspect --json
  linearctl gql query '{ viewer { id } }' --json
  linearctl gql mutation --file m.graphql --vars-file v.json --json
  linearctl skills install [--scope project|user] [--json]
  linearctl skills list [--json]
  linearctl schema version [--json]
  linearctl schema pull [--json] [--output-dir <path>]  (default: project src/generated/manifest)
  linearctl schema check [--json]
  linearctl --metadata curated --json
  linearctl --help
`);
}

function printCuratedMetadata(): void {
  process.stdout.write(`${JSON.stringify(curatedCommandMetadata, null, 2)}\n`);
}

interface ParsedCliArguments {
  help: boolean;
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
  assignee?: string;
  label?: string;
  state?: string;
  inputJson?: string;
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
  startsAt?: string;
  endsAt?: string;
  body?: string;
  issue?: string;
  url?: string;
  output?: string;
  expiresIn?: string;
  filterJson?: string;
  orderBy?: string;
  orderDir?: string;
  all: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  dryRun: boolean;
  everything: boolean;
  scope?: string;
  noRetry: boolean;
  maxRetries?: number;
  positionals: string[];
}

function parseCliArguments(argv: string[]): ParsedCliArguments {
  const [leadingOptionArgs, commandAndArgs] = splitArgvAtFirstPositional(argv);
  const topLevel = parseCliOptionSet(leadingOptionArgs, CLI_OPTION_DEFINITIONS);

  if (commandAndArgs.length === 0) {
    return toParsedCliArguments(topLevel.values, topLevel.positionals);
  }

  const [command, ...subcommandArgv] = commandAndArgs;

  if (command === "auth") {
    const commandParse = parseCliOptionSet(subcommandArgv, AUTH_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "gql") {
    const commandParse = parseCliOptionSet(subcommandArgv, GQL_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "api") {
    const commandParse = parseCliOptionSet(subcommandArgv, API_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "schema") {
    const commandParse = parseCliOptionSet(subcommandArgv, SCHEMA_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "issue") {
    const commandParse = parseCliOptionSet(subcommandArgv, ISSUE_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "project") {
    const commandParse = parseCliOptionSet(subcommandArgv, PROJECT_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "cycle") {
    const commandParse = parseCliOptionSet(subcommandArgv, CYCLE_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "team") {
    const commandParse = parseCliOptionSet(subcommandArgv, TEAM_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "user") {
    const commandParse = parseCliOptionSet(subcommandArgv, USER_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "label") {
    const commandParse = parseCliOptionSet(subcommandArgv, LABEL_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "state") {
    const commandParse = parseCliOptionSet(subcommandArgv, STATE_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "project-status") {
    const commandParse = parseCliOptionSet(subcommandArgv, PROJECT_STATUS_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "comment") {
    const commandParse = parseCliOptionSet(subcommandArgv, COMMENT_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "attachment") {
    const commandParse = parseCliOptionSet(subcommandArgv, ATTACHMENT_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "file") {
    const commandParse = parseCliOptionSet(subcommandArgv, FILE_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "workspace") {
    const commandParse = parseCliOptionSet(subcommandArgv, WORKSPACE_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "skills") {
    const commandParse = parseCliOptionSet(subcommandArgv, SKILLS_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  return toParsedCliArguments(topLevel.values, commandAndArgs);
}

function parseCliOptionSet(
  argv: string[],
  options: Record<string, { type: "boolean"; short?: string; multiple?: true } | { type: "string"; short?: string; multiple?: true }>
): { values: Record<string, unknown>; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true
  });

  return {
    values: values as Record<string, unknown>,
    positionals
  };
}

function splitArgvAtFirstPositional(argv: string[]): [string[], string[]] {
  let index = 0;

  while (index < argv.length) {
    const token = argv[index];

    if (token === undefined) {
      break;
    }

    if (token === "--") {
      return [argv.slice(0, index), argv.slice(index + 1)];
    }

    if (!token.startsWith("-") || token === "-") {
      return [argv.slice(0, index), argv.slice(index)];
    }

    if (token.startsWith("--")) {
      const [optionName] = token.slice(2).split("=", 1);
      const optionDefinition = CLI_OPTION_DEFINITIONS[optionName as keyof typeof CLI_OPTION_DEFINITIONS];

      if (optionDefinition === undefined) {
        return [argv.slice(), []];
      }

      if (optionDefinition.type === "string" && !token.includes("=")) {
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (token === "-h") {
      index += 1;
      continue;
    }

    return [argv.slice(), []];
  }

  return [argv.slice(), []];
}

function mergeParsedCliArguments(
  topLevelValues: Record<string, unknown>,
  commandValues: Record<string, unknown>,
  positionals: string[]
): ParsedCliArguments {
  return toParsedCliArguments(
    {
      ...topLevelValues,
      ...commandValues,
      var: mergeStringArrays(topLevelValues.var, commandValues.var)
    },
    positionals
  );
}

function mergeStringArrays(left: unknown, right: unknown): string[] | undefined {
  const merged = [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : [])
  ].filter((value): value is string => typeof value === "string");

  return merged.length > 0 ? merged : undefined;
}

function parsePositiveInt(value: string, flagName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`--${flagName} must be a positive integer`);
  }
  return parseInt(value, 10);
}

function toParsedCliArguments(values: Record<string, unknown>, positionals: string[]): ParsedCliArguments {
  let help = false;
  let json = false;
  let metadata: string | undefined;
  let configFile = defaultLinearConfigPaths().configFile;
  let credentialsFile = defaultLinearConfigPaths().credentialsFile;

  help = values.help === true;
  json = values.json === true;
  metadata = typeof values.metadata === "string" ? values.metadata : undefined;
  if (typeof values.config === "string") {
    configFile = values.config;
  }
  if (typeof values["config-file"] === "string") {
    configFile = values["config-file"];
  }
  if (typeof values.credentials === "string") {
    credentialsFile = values.credentials;
  }
  if (typeof values["credentials-file"] === "string") {
    credentialsFile = values["credentials-file"];
  }

  const jsonl = values.jsonl === true;
  const jsonEnvelope = values["json-envelope"] === true;

  if (jsonl && jsonEnvelope) {
    throw new Error("--jsonl and --json-envelope are mutually exclusive");
  }

  return {
    help,
    json,
    jsonEnvelope,
    jsonl,
    ...(metadata === undefined ? {} : { metadata }),
    configFile,
    credentialsFile,
    ...(typeof values.profile === "string" ? { profile: values.profile } : {}),
    ...(typeof values["api-key-env"] === "string" ? { apiKeyEnv: values["api-key-env"] } : {}),
    apiKeyStdin: values["api-key-stdin"] === true,
    oauth: values.oauth === true,
    ...(typeof values["oauth-client-id"] === "string" ? { oauthClientId: values["oauth-client-id"] } : {}),
    ...(typeof values["callback-port"] === "string" ? { callbackPort: values["callback-port"] } : {}),
    noBrowser: values["no-browser"] === true,
    setDefault: values["set-default"] === true,
    removeConfig: values["remove-config"] === true,
    ...(typeof values["api-url"] === "string" ? { apiUrl: values["api-url"] } : {}),
    raw: values.raw === true,
    stdin: values.stdin === true,
    ...(typeof values.file === "string" ? { file: values.file } : {}),
    ...(typeof values["vars-file"] === "string" ? { varsFile: values["vars-file"] } : {}),
    vars: Array.isArray(values.var) ? values.var.filter((value): value is string => typeof value === "string") : [],
    ...(typeof values["output-dir"] === "string" ? { outputDir: values["output-dir"] } : {}),
    ...(typeof values.title === "string" ? { title: values.title } : {}),
    ...(typeof values.team === "string" ? { team: values.team } : {}),
    ...(typeof values.description === "string" ? { description: values.description } : {}),
    ...(typeof values.priority === "string" ? { priority: values.priority } : {}),
    ...(typeof values.assignee === "string" ? { assignee: values.assignee } : {}),
    ...(typeof values.ids === "string" ? { ids: values.ids } : {}),
    ...(typeof values.label === "string" ? { label: values.label } : {}),
    ...(typeof values.state === "string" ? { state: values.state } : {}),
    ...(typeof values["input-json"] === "string" ? { inputJson: values["input-json"] } : {}),
    ...(typeof values["input-file"] === "string" ? { inputFile: values["input-file"] } : {}),
    inputStdin: values["input-stdin"] === true,
    ...(typeof values.id === "string" ? { id: values.id } : {}),
    ...(typeof values.fields === "string" ? { fields: values.fields } : {}),
    ...(typeof values.name === "string" ? { name: values.name } : {}),
    ...(typeof values.color === "string" ? { color: values.color } : {}),
    ...(typeof values.position === "string" ? { position: values.position } : {}),
    ...(typeof values["state-type"] === "string" ? { stateType: values["state-type"] } : {}),
    ...(typeof values["status-type"] === "string" ? { statusType: values["status-type"] } : {}),
    ...(typeof values["starts-at"] === "string" ? { startsAt: values["starts-at"] } : {}),
    ...(typeof values["ends-at"] === "string" ? { endsAt: values["ends-at"] } : {}),
    ...(typeof values.body === "string" ? { body: values.body } : {}),
    ...(typeof values.issue === "string" ? { issue: values.issue } : {}),
    ...(typeof values.url === "string" ? { url: values.url } : {}),
    ...(typeof values.output === "string" ? { output: values.output } : {}),
    ...(typeof values["expires-in"] === "string" ? { expiresIn: values["expires-in"] } : {}),
    ...(typeof values["filter-json"] === "string" ? { filterJson: values["filter-json"] } : {}),
    ...(typeof values["order-by"] === "string" ? { orderBy: values["order-by"] } : {}),
    ...(typeof values["order-dir"] === "string" ? { orderDir: values["order-dir"] } : {}),
    all: values.all === true,
    ...(typeof values.max === "string" ? { max: parsePositiveInt(values.max, "max") } : {}),
    ...(typeof values["page-size"] === "string" ? { pageSize: parsePositiveInt(values["page-size"], "page-size") } : {}),
    ...(typeof values.after === "string" ? { after: values.after } : {}),
    dryRun: values["dry-run"] === true,
    everything: values.everything === true,
    ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
    noRetry: values["no-retry"] === true,
    ...(typeof values["max-retries"] === "string" ? { maxRetries: parsePositiveInt(values["max-retries"], "max-retries") } : {}),
    positionals
  };
}

async function main(argv: string[]): Promise<number> {
  let args: ParsedCliArguments;

  try {
    args = parseCliArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    process.stderr.write(`Error: ${message}\n`);
    return ExitCode.ValidationError;
  }

  if (argv.length === 0 || args.help) {
    printTopLevelHelp();
    return ExitCode.Success;
  }

  if (args.team !== undefined && args.everything) {
    process.stderr.write("Error: --team cannot be used with --everything\n");
    return ExitCode.ValidationError;
  }

  if (args.metadata === "curated" && args.json) {
    printCuratedMetadata();
    return ExitCode.Success;
  }

  if (args.positionals[0] === "api") {
    try {
      return await handleApiCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        raw: args.raw,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.id === undefined ? {} : { id: args.id }),
        ...(args.inputJson === undefined ? {} : { inputJson: args.inputJson }),
        ...(args.inputFile === undefined ? {} : { inputFile: args.inputFile }),
        inputStdin: args.inputStdin,
        ...(args.fields === undefined ? {} : { fields: args.fields }),
        env: process.env,
        stdinStream: process.stdin
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "auth") {
    try {
      return await handleAuthCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        ...(args.apiKeyEnv === undefined ? {} : { apiKeyEnv: args.apiKeyEnv }),
        apiKeyStdin: args.apiKeyStdin,
        oauth: args.oauth,
        ...(args.oauthClientId === undefined ? {} : { oauthClientId: args.oauthClientId }),
        ...(args.callbackPort === undefined ? {} : { callbackPort: args.callbackPort }),
        noBrowser: args.noBrowser,
        setDefault: args.setDefault,
        removeConfig: args.removeConfig,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        env: process.env,
        stdin: process.stdin
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "gql") {
    try {
      return await handleGqlCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        raw: args.raw,
        stdin: args.stdin,
        ...(args.file === undefined ? {} : { file: args.file }),
        ...(args.varsFile === undefined ? {} : { varsFile: args.varsFile }),
        vars: args.vars,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        env: process.env,
        stdinStream: process.stdin
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "issue") {
    try {
      return await handleIssueCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        everything: args.everything,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.team === undefined ? {} : { team: args.team }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.assignee === undefined ? {} : { assignee: args.assignee }),
        ...(args.label === undefined ? {} : { label: args.label }),
        ...(args.state === undefined ? {} : { state: args.state }),
        ...(args.inputJson === undefined ? {} : { inputJson: args.inputJson }),
        ...(args.ids === undefined ? {} : { ids: args.ids }),
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.filterJson === undefined ? {} : { filterJson: args.filterJson }),
        ...(args.orderBy === undefined ? {} : { orderBy: args.orderBy }),
        ...(args.orderDir === undefined ? {} : { orderDir: args.orderDir }),
        ...(args.all ? { all: true } : {}),
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "project") {
    try {
      return await handleProjectCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        everything: args.everything,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.team === undefined ? {} : { team: args.team }),
        ...(args.state === undefined ? {} : { state: args.state }),
        all: args.all,
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "cycle") {
    try {
      return await handleCycleCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        everything: args.everything,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.team === undefined ? {} : { team: args.team }),
        ...(args.startsAt === undefined ? {} : { startsAt: args.startsAt }),
        ...(args.endsAt === undefined ? {} : { endsAt: args.endsAt }),
        all: args.all,
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "team") {
    try {
      return await handleTeamCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        setDefault: args.setDefault,
        ...(args.all ? { all: true } : {}),
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "user") {
    try {
      return await handleUserCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.all ? { all: true } : {}),
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "label") {
    try {
      return await handleLabelCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        everything: args.everything,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.color === undefined ? {} : { color: args.color }),
        ...(args.team === undefined ? {} : { team: args.team }),
        ...(args.all ? { all: true } : {}),
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "state") {
    try {
      return await handleStateCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        everything: args.everything,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.stateType === undefined ? {} : { stateType: args.stateType }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.color === undefined ? {} : { color: args.color }),
        ...(args.position === undefined ? {} : { position: args.position }),
        ...(args.team === undefined ? {} : { team: args.team }),
        ...(args.all ? { all: true } : {}),
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "project-status") {
    try {
      return await handleProjectStatusCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.statusType === undefined ? {} : { statusType: args.statusType }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.color === undefined ? {} : { color: args.color }),
        ...(args.position === undefined ? {} : { position: args.position }),
        ...(args.all ? { all: true } : {}),
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "comment") {
    try {
      return await handleCommentCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.issue === undefined ? {} : { issue: args.issue }),
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.all ? { all: true } : {}),
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "attachment") {
    try {
      return await handleAttachmentCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        jsonEnvelope: args.jsonEnvelope,
        jsonl: args.jsonl,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.issue === undefined ? {} : { issue: args.issue }),
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.all ? { all: true } : {}),
        ...(args.max === undefined ? {} : { max: args.max }),
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        ...(args.after === undefined ? {} : { after: args.after }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "file") {
    try {
      return await handleFileCommand(args.positionals.slice(1), {
        json: args.json,
        dryRun: args.dryRun,
        jsonEnvelope: args.jsonEnvelope,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.issue === undefined ? {} : { issue: args.issue }),
        ...(args.output === undefined ? {} : { output: args.output }),
        ...(args.expiresIn === undefined ? {} : { expiresIn: args.expiresIn }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "schema") {
    try {
      return await handleSchemaCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.outputDir === undefined ? {} : { outputDir: args.outputDir }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "workspace") {
    try {
      return await handleWorkspaceCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "skills") {
    try {
      return await handleSkillsCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        stdinStream: process.stdin,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  process.stderr.write("Error: command execution is not implemented yet in this scaffold.\n");
  return ExitCode.ValidationError;
}

process.exitCode = await main(process.argv.slice(2));
