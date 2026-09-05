/**
 * Command registry — the single source of truth for all CLI commands.
 * Drives help text, option parsing, dispatch, and curated metadata.
 */

import { handleAuthCommand } from "../../commands/auth.js";
import { handleCycleCommand } from "../../commands/cycle.js";
import { handleFileCommand } from "../../commands/file.js";
import { handleGqlCommand } from "../../commands/gql.js";
import { handleIssueCommand } from "../../commands/issue.js";
import { handleRelationCommand } from "../../commands/relation.js";
import { handleCommentCommand } from "../../commands/comment.js";
import { handleApiCommand } from "../../commands/api.js";
import { handleAttachmentCommand } from "../../commands/attachment.js";
import { handleLabelCommand } from "../../commands/label.js";
import { handleProjectCommand } from "../../commands/project.js";
import { handleSchemaCommand } from "../../commands/schema.js";
import { handleTeamCommand } from "../../commands/team.js";
import { handleUserCommand } from "../../commands/user.js";
import { handleProjectStatusCommand } from "../../commands/project-status.js";
import { handleStateCommand } from "../../commands/state.js";
import { handleWorkspaceCommand } from "../../commands/workspace.js";
import { handleSkillsCommand } from "../../commands/skills.js";
import { OPTION_GROUPS } from "./option-catalog.js";
import { baseOptions, curatedOptions, paginationOptions, teamFilterOptions, pickFields } from "./option-mapping.js";
import type { CommandRegistration, ParsedCliArguments } from "./types.js";

// Common option key sets composed from groups
const CURATED_BASE = [
  ...OPTION_GROUPS.global,
  ...OPTION_GROUPS.streaming,
  ...OPTION_GROUPS.dryRun,
  ...OPTION_GROUPS.retry,
  ...OPTION_GROUPS.pagination,
] as const;

export const COMMAND_REGISTRY: readonly CommandRegistration[] = [
  // ── Issue ──────────────────────────────────────────────────────────────
  {
    name: "issue",
    optionKeys: [
      ...CURATED_BASE,
      ...OPTION_GROUPS.confirmation,
      ...OPTION_GROUPS.allTeams,
      "title", "team", "description", "description-file", "priority", "estimate", "due-date", "assignee",
      "label", "state", "status", "input-json", "ids", "body", "body-file", "url", "sync", "query", "search",
      "filter-json", "created-after", "updated-after", "completed-after",
      "cycle", "project", "milestone", "project-milestone", "order-by", "order-dir", "parent",
    ],
    subcommands: {
      get:            { usage: "linearctl issue get <identifier> [--json]" },
      view:           { usage: "linearctl issue view <identifier> [--json] (alias: get)" },
      create:         { usage: "linearctl issue create --title <title> --team <id> [--description <text>|--description-file <path|->] [--priority <0-4>] [--estimate <n>] [--due-date <YYYY-MM-DD>] [--assignee <id>] [--label <id>] [--state <id>] [--cycle <id>] [--project <id|name>] [--project-milestone <id>|--milestone <id>] [--parent <identifier>] [--json]" },
      list:           { usage: "linearctl issue list [--search <text>|--query <text>] [--state <name>[,<name>...] ...] [--status <name>] [--assignee <id|none>] [--team <id>] [--label <name|id>] [--priority <0-4>] [--due-date <YYYY-MM-DD|none>] [--cycle <id>] [--project <id|name>] [--created-after <date>] [--updated-after <date>] [--completed-after <date>] [--order-by <field>] [--all-teams] [--all] [--json]" },
      search:         { usage: "linearctl issue search [<text>|--query <text>|--search <text>] [--team <id>] [--all] [--json]" },
      update:         { usage: "linearctl issue update <identifier> [--title <text>] [--description <text>|--description-file <path|->] [--priority <0-4>] [--estimate <n>] [--due-date <YYYY-MM-DD|none>] [--assignee <id|none>] [--label <name|id>] [--state <name|id>] [--cycle <id|none>] [--project <name|id|none>] [--project-milestone <id|none>|--milestone <id|none>] [--parent <identifier|none>] [--json]" },
      close:          { usage: "linearctl issue close <identifier> [--state <name>] [--json]" },
      delete:         { usage: "linearctl issue delete <identifier> [--json]" },
      assign:         { usage: "linearctl issue assign <identifier> <assignee-id> [--json]" },
      comment:        { usage: "linearctl issue comment <identifier> (--body <text>|--body-file <path|->) [--json]" },
      "attach-slack": { usage: "linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>] [--json]" },
      "bulk-update":  { usage: "linearctl issue bulk-update --ids <id1,id2,...> [--state <name|id>] [--assignee <id|none>] [--priority <0-4>] [--estimate <n>] [--due-date <YYYY-MM-DD|none>] [--label <id>] [--cycle <id|none>] [--project-milestone <id|none>|--milestone <id|none>] [--json]" },
      "bulk-close":   { usage: "linearctl issue bulk-close --ids <id1,id2,...> [--state <name|id>] [--json]" },
      "bulk-archive": { usage: "linearctl issue bulk-archive --ids <id1,id2,...> [--json]" },
      "bulk-delete":  { usage: "linearctl issue bulk-delete --ids <id1,id2,...> (--yes|--confirm) [--json]" },
      "bulk-assign":  { usage: "linearctl issue bulk-assign --ids <id1,id2,...> --assignee <id> [--json]" },
    },
    handler: handleIssueCommand,
    buildOptions: (args, env, stdin) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...teamFilterOptions(args),
      sync: args.sync,
      stdinStream: stdin,
      ...pickFields(args, "title", "description", "descriptionFile", "priority", "estimate", "dueDate", "assignee",
        "label", "state", "states", "status", "inputJson", "ids", "body", "bodyFile", "url", "query", "search",
        "filterJson", "createdAfter", "updatedAfter", "completedAfter",
        "cycle", "project", "milestone", "projectMilestone", "orderBy", "orderDir", "parent"),
    }),
  },

  // ── Issue Relation ─────────────────────────────────────────────────────
  {
    name: "relation",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.streaming,
      ...OPTION_GROUPS.dryRun,
      ...OPTION_GROUPS.retry,
      "all", "max", "limit", "page-size", "issue", "related", "type",
    ],
    subcommands: {
      list:   { usage: "linearctl relation list <issue> [--all] [--max <n>] [--json]" },
      create: { usage: "linearctl relation create --issue <issue> --related <issue> --type <blocks|duplicate|related|similar> [--json]" },
      delete: { usage: "linearctl relation delete <relation-id> [--json]" },
    },
    handler: handleRelationCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...pickFields(args, "issue", "related", "type"),
    }),
  },

  // ── Project ────────────────────────────────────────────────────────────
  {
    name: "project",
    optionKeys: [
      ...CURATED_BASE,
      ...OPTION_GROUPS.allTeams,
      "name", "description", "description-file", "content", "content-file", "team", "state", "status", "query", "search", "lead", "start-date", "target-date", "issues-json",
    ],
    subcommands: {
      get:                  { usage: "linearctl project get <name|id> [--json]" },
      list:                 { usage: "linearctl project list [--query <text>|--search <text>|--name <text>] [--team <id>] [--state <status-type> ...] [--all-teams] [--json]" },
      create:               { usage: "linearctl project create --name <name> [--description <text>|--description-file <path|->] [--content <text>|--content-file <path|->] [--team <id>] [--lead <user>] [--status <id|name|type>|--state <name|type>] [--start-date <date>] [--target-date <date>] [--json]" },
      update:               { usage: "linearctl project update <id> [--name ...] [--description <text>|--description-file <path|->] [--content <text>|--content-file <path|->] [--status <name|type|id>|--state <name|type>] [--lead <user>] [--start-date <date>] [--target-date <date>] [--json]" },
      "create-with-issues": { usage: "linearctl project create-with-issues --name <name> --team <id> --issues-json <json> [--description <text>|--description-file <path|->] [--content <text>|--content-file <path|->] [--lead <user>] [--status <id|name|type>|--state <name|type>] [--start-date <date>] [--target-date <date>] [--json]" },
      delete:               { usage: "linearctl project delete <id> [--json]" },
    },
    handler: handleProjectCommand,
    buildOptions: (args, env, stdin) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...teamFilterOptions(args),
      stdinStream: stdin,
      ...pickFields(args, "name", "description", "descriptionFile", "content", "contentFile", "state", "states", "status", "query", "search", "lead", "startDate", "targetDate", "issuesJson"),
    }),
  },

  // ── Cycle ──────────────────────────────────────────────────────────────
  {
    name: "cycle",
    optionKeys: [
      ...CURATED_BASE,
      ...OPTION_GROUPS.allTeams,
      "name", "description", "team", "starts-at", "ends-at",
    ],
    subcommands: {
      get:     { usage: "linearctl cycle get <id> [--json]" },
      list:    { usage: "linearctl cycle list [--team <id>] [--all-teams] [--json]" },
      current: { usage: "linearctl cycle current [--team <id>] [--json]" },
      create:  { usage: "linearctl cycle create --team <id> [--name ...] [--starts-at ...] [--ends-at ...] [--json]" },
      update:  { usage: "linearctl cycle update <id> [--name ...] [--starts-at ...] [--ends-at ...] [--json]" },
      archive: { usage: "linearctl cycle archive <id> [--json]" },
      delete:  { usage: "linearctl cycle delete <id> [--json]" },
    },
    handler: handleCycleCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...teamFilterOptions(args),
      ...pickFields(args, "name", "description", "startsAt", "endsAt"),
    }),
  },

  // ── Team ───────────────────────────────────────────────────────────────
  {
    name: "team",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.streaming,
      ...OPTION_GROUPS.retry,
      ...OPTION_GROUPS.pagination,
      "set-default",
    ],
    subcommands: {
      get:     { usage: "linearctl team get <id-or-key-or-name> [--set-default] [--json]" },
      list:    { usage: "linearctl team list [--json]" },
      members: { usage: "linearctl team members <id-or-key-or-name> [--all] [--json]" },
    },
    handler: handleTeamCommand,
    buildOptions: (args, env) => ({
      ...baseOptions(args, env),
      jsonl: args.jsonl, quiet: args.quiet,
      noRetry: args.noRetry,
      ...pickFields(args, "maxRetries"),
      setDefault: args.setDefault,
      ...paginationOptions(args),
    }),
  },

  // ── User ───────────────────────────────────────────────────────────────
  {
    name: "user",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.streaming,
      ...OPTION_GROUPS.retry,
      ...OPTION_GROUPS.pagination,
    ],
    subcommands: {
      get:  { usage: "linearctl user get <id|name|displayName|email> [--json]" },
      me:   { usage: "linearctl user me [--json]" },
      list: { usage: "linearctl user list [--json]" },
    },
    handler: handleUserCommand,
    buildOptions: (args, env) => ({
      ...baseOptions(args, env),
      jsonl: args.jsonl, quiet: args.quiet,
      noRetry: args.noRetry,
      ...pickFields(args, "maxRetries"),
      ...paginationOptions(args),
    }),
  },

  // ── Label ──────────────────────────────────────────────────────────────
  {
    name: "label",
    optionKeys: [
      ...CURATED_BASE,
      ...OPTION_GROUPS.allTeams,
      "name", "description", "color", "team", "parent", "group",
    ],
    subcommands: {
      get:    { usage: "linearctl label get <id|name> [--team <id>] [--json]" },
      list:   { usage: "linearctl label list [--team <id>] [--all-teams] [--json]" },
      create: { usage: "linearctl label create --name <name> [--description ...] [--color ...] [--team <id>] [--parent <name|id>|--group] [--json]" },
      delete: { usage: "linearctl label delete <id> [--json]" },
    },
    handler: handleLabelCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...teamFilterOptions(args),
      ...pickFields(args, "name", "description", "color", "parent"),
      group: args.group,
    }),
  },

  // ── State ──────────────────────────────────────────────────────────────
  {
    name: "state",
    optionKeys: [
      ...CURATED_BASE,
      ...OPTION_GROUPS.allTeams,
      "name", "state-type", "description", "color", "position", "team",
    ],
    subcommands: {
      get:    { usage: "linearctl state get <id|name> [--team <id>] [--json]" },
      list:   { usage: "linearctl state list [--team <id>] [--all-teams] [--json]" },
      create: { usage: "linearctl state create --name <name> --team <id> --state-type <type> [--color <hex>] [--json]" },
      archive:{ usage: "linearctl state archive <id|name> [--team <id>] [--json]" },
      delete: { usage: "linearctl state delete <id|name> [--team <id>] [--json]" },
    },
    handler: handleStateCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...teamFilterOptions(args),
      ...pickFields(args, "name", "stateType", "description", "color", "position"),
    }),
  },

  // ── Project Status ─────────────────────────────────────────────────────
  {
    name: "project-status",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.streaming,
      ...OPTION_GROUPS.dryRun,
      ...OPTION_GROUPS.retry,
      ...OPTION_GROUPS.pagination,
      "name", "status-type", "description", "color", "position",
    ],
    subcommands: {
      list:   { usage: "linearctl project-status list [--json]" },
      get:    { usage: "linearctl project-status get <id> [--json]" },
      create: { usage: "linearctl project-status create --name <name> --status-type <type> [--json]" },
      delete: { usage: "linearctl project-status delete <id> [--json]" },
    },
    handler: handleProjectStatusCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...pickFields(args, "name", "statusType", "description", "color", "position"),
    }),
  },

  // ── Comment ────────────────────────────────────────────────────────────
  {
    name: "comment",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.streaming,
      ...OPTION_GROUPS.dryRun,
      ...OPTION_GROUPS.retry,
      ...OPTION_GROUPS.pagination,
      "issue", "body", "body-file",
    ],
    subcommands: {
      list:   { usage: "linearctl comment list (<issue>|--issue <id>) [--json]" },
      create: { usage: "linearctl comment create --issue <id> (--body <text>|--body-file <path|->) [--json]" },
      update: { usage: "linearctl comment update <id> (--body <text>|--body-file <path|->) [--json]" },
      delete: { usage: "linearctl comment delete <id> [--json]" },
    },
    handler: handleCommentCommand,
    buildOptions: (args, env, stdin) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      stdinStream: stdin,
      ...pickFields(args, "issue", "body", "bodyFile"),
    }),
  },

  // ── Attachment ─────────────────────────────────────────────────────────
  {
    name: "attachment",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.streaming,
      ...OPTION_GROUPS.dryRun,
      ...OPTION_GROUPS.retry,
      ...OPTION_GROUPS.pagination,
      "issue", "url", "title",
    ],
    subcommands: {
      list:   { usage: "linearctl attachment list --issue <id> [--json]" },
      create: { usage: "linearctl attachment create --issue <id> --url <url> --title <title> [--json]" },
      delete: { usage: "linearctl attachment delete <id> [--json]" },
    },
    handler: handleAttachmentCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...pickFields(args, "issue", "url", "title"),
    }),
  },

  // ── File ───────────────────────────────────────────────────────────────
  {
    name: "file",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.dryRun,
      ...OPTION_GROUPS.retry,
      "issue", "output", "expires-in", "transfer-timeout",
    ],
    subcommands: {
      upload:   { usage: "linearctl file upload <path> [--issue <id>] [--transfer-timeout <seconds>] [--json]" },
      url:      { usage: "linearctl file url <attachment-id> [--expires-in <seconds>] [--json]" },
      download: { usage: "linearctl file download <url> [--output <path>] [--transfer-timeout <seconds>] [--json]" },
    },
    handler: handleFileCommand,
    buildOptions: (args, env) => ({
      ...baseOptions(args, env),
      dryRun: args.dryRun,
      noRetry: args.noRetry,
      ...pickFields(args, "maxRetries"),
      ...pickFields(args, "issue", "output", "expiresIn", "transferTimeout"),
    }),
  },

  // ── Auth ───────────────────────────────────────────────────────────────
  {
    name: "auth",
    optionKeys: [
      ...OPTION_GROUPS.global,
      "api-key-env", "api-key-stdin", "oauth", "oauth-client-credentials",
      "set-default", "remove-config",
      "oauth-client-id", "oauth-client-id-env", "oauth-client-secret-env", "oauth-client-secret-stdin",
      "callback-port", "no-browser",
    ],
    subcommands: {
      login:  { usage: "linearctl auth login --profile <name> --api-key-env <ENV> | --api-key-stdin | --oauth --oauth-client-id <id> | --oauth-client-credentials (--oauth-client-id <id>|--oauth-client-id-env <ENV>) (--oauth-client-secret-env <ENV>|--oauth-client-secret-stdin)" },
      logout: { usage: "linearctl auth logout --profile <name>" },
      status: { usage: "linearctl auth status [--json]" },
      switch: { usage: "linearctl auth switch <profile>" },
      whoami: { usage: "linearctl auth whoami [--json]" },
    },
    handler: handleAuthCommand,
    buildOptions: (args, env, stdin) => ({
      ...baseOptions(args, env),
      ...pickFields(args, "apiKeyEnv", "oauthClientId", "oauthClientIdEnv", "oauthClientSecretEnv", "callbackPort"),
      apiKeyStdin: args.apiKeyStdin,
      oauth: args.oauth,
      oauthClientCredentials: args.oauthClientCredentials,
      oauthClientSecretStdin: args.oauthClientSecretStdin,
      noBrowser: args.noBrowser,
      setDefault: args.setDefault,
      removeConfig: args.removeConfig,
      stdin,
    }),
  },

  // ── GQL ────────────────────────────────────────────────────────────────
  {
    name: "gql",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.retry,
      "raw", "stdin", "file", "vars-file", "var",
    ],
    subcommands: {
      introspect: { usage: "linearctl gql introspect --json" },
      query:      { usage: "linearctl gql query '{ viewer { id } }' --json" },
      mutation:   { usage: "linearctl gql mutation --file m.graphql --vars-file v.json --json" },
    },
    handler: handleGqlCommand,
    buildOptions: (args, env, stdin) => ({
      ...baseOptions(args, env),
      raw: args.raw, stdin: args.stdin,
      noRetry: args.noRetry,
      vars: args.vars,
      ...pickFields(args, "file", "varsFile", "maxRetries"),
      stdinStream: stdin,
    }),
  },

  // ── API ────────────────────────────────────────────────────────────────
  {
    name: "api",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.retry,
      "id", "input-json", "input-file", "input-stdin", "fields", "raw",
    ],
    subcommands: {
      "<resource> <operation>": { usage: "linearctl api <resource> <operation> [--id <id>] [--input-json <json>] [--fields <f1,f2>] [--json]" },
      "--help":                 { usage: "linearctl api --help                 (list resources)" },
      "<resource> --help":      { usage: "linearctl api <resource> --help      (list operations)" },
      "search <term>":          { usage: "linearctl api search <term>          (search commands)" },
    },
    handler: handleApiCommand,
    buildOptions: (args, env, stdin) => ({
      ...baseOptions(args, env),
      help: args.help,
      raw: args.raw,
      inputStdin: args.inputStdin,
      noRetry: args.noRetry,
      ...pickFields(args, "id", "inputJson", "inputFile", "fields", "maxRetries"),
      stdinStream: stdin,
    }),
  },

  // ── Schema ─────────────────────────────────────────────────────────────
  {
    name: "schema",
    optionKeys: [
      ...OPTION_GROUPS.global,
      ...OPTION_GROUPS.retry,
      "output-dir",
    ],
    subcommands: {
      version: { usage: "linearctl schema version [--json]" },
      pull:    { usage: "linearctl schema pull [--json] [--output-dir <path>]  (default: <config-dir>/schema)" },
      check:   { usage: "linearctl schema check [--json]" },
    },
    handler: handleSchemaCommand,
    buildOptions: (args, env) => ({
      ...baseOptions(args, env),
      noRetry: args.noRetry,
      ...pickFields(args, "outputDir", "maxRetries"),
    }),
  },

  // ── Workspace ──────────────────────────────────────────────────────────
  {
    name: "workspace",
    optionKeys: [
      ...OPTION_GROUPS.global,
    ],
    subcommands: {
      list: { usage: "linearctl workspace list [--json]" },
    },
    handler: handleWorkspaceCommand,
    buildOptions: (args, env) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope,
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      env,
    }),
  },

  // ── Skills ─────────────────────────────────────────────────────────────
  {
    name: "skills",
    optionKeys: [
      ...OPTION_GROUPS.global,
      "scope",
    ],
    subcommands: {
      install: { usage: "linearctl skills install [--scope project|user] [--json]" },
      list:    { usage: "linearctl skills list [--json]" },
    },
    handler: handleSkillsCommand,
    buildOptions: (args, _env, stdin) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope,
      ...pickFields(args, "scope"),
      stdinStream: stdin,
    }),
  },
] as const;

/**
 * Look up a command registration by name.
 */
export function findCommand(name: string): CommandRegistration | undefined {
  return COMMAND_REGISTRY.find((cmd) => cmd.name === name);
}
