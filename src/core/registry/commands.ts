/**
 * Command registry — the single source of truth for all CLI commands.
 * Drives help text, option parsing, dispatch, and curated metadata.
 */

import { handleAuthCommand } from "../../commands/auth.js";
import { handleCycleCommand } from "../../commands/cycle.js";
import { handleFileCommand } from "../../commands/file.js";
import { handleGqlCommand } from "../../commands/gql.js";
import { handleIssueCommand } from "../../commands/issue.js";
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
      ...OPTION_GROUPS.allTeams,
      "title", "team", "description", "priority", "estimate", "assignee",
      "label", "state", "input-json", "ids", "body", "url", "sync", "query",
      "filter-json", "created-after", "updated-after", "completed-after",
      "cycle", "project", "milestone", "project-milestone", "order-by", "order-dir", "parent",
    ],
    subcommands: {
      get:            { usage: "linearctl issue get <identifier> [--json]" },
      create:         { usage: "linearctl issue create --title <title> --team <id> [--description <text>] [--priority <0-4>] [--estimate <n>] [--assignee <id>] [--label <id>] [--state <id>] [--cycle <id>] [--project <id|name>] [--project-milestone <id>|--milestone <id>] [--parent <identifier>] [--json]" },
      list:           { usage: "linearctl issue list [--state <name>] [--assignee <id>] [--team <id>] [--label <name|id>] [--priority <0-4>] [--cycle <id>] [--project <id|name>] [--created-after <date>] [--updated-after <date>] [--completed-after <date>] [--order-by <field>] [--all-teams] [--all] [--json]" },
      search:         { usage: "linearctl issue search --query <text> [--all] [--json]" },
      update:         { usage: "linearctl issue update <identifier> [--title <text>] [--description <text>] [--priority <0-4>] [--estimate <n>] [--assignee <id>] [--label <name|id>] [--state <id>] [--cycle <id>] [--project <id>] [--parent <identifier>] [--json]" },
      close:          { usage: "linearctl issue close <identifier> [--state <name>] [--json]" },
      assign:         { usage: "linearctl issue assign <identifier> <assignee-id> [--json]" },
      comment:        { usage: "linearctl issue comment <identifier> --body <text> [--json]" },
      "attach-slack": { usage: "linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>] [--json]" },
      "bulk-update":  { usage: "linearctl issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] [--priority <0-4>] [--estimate <n>] [--label <id>] [--cycle <id>] [--json]" },
      "bulk-close":   { usage: "linearctl issue bulk-close --ids <id1,id2,...> [--json]" },
      "bulk-assign":  { usage: "linearctl issue bulk-assign --ids <id1,id2,...> --assignee <id> [--json]" },
    },
    handler: handleIssueCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...teamFilterOptions(args),
      sync: args.sync,
      ...pickFields(args, "title", "description", "priority", "estimate", "assignee",
        "label", "state", "inputJson", "ids", "body", "url", "query",
        "filterJson", "createdAfter", "updatedAfter", "completedAfter",
        "cycle", "project", "milestone", "projectMilestone", "orderBy", "orderDir", "parent"),
    }),
  },

  // ── Project ────────────────────────────────────────────────────────────
  {
    name: "project",
    optionKeys: [
      ...CURATED_BASE,
      ...OPTION_GROUPS.allTeams,
      "name", "description", "team", "state", "target-date", "issues-json",
    ],
    subcommands: {
      get:                  { usage: "linearctl project get <name|id> [--json]" },
      list:                 { usage: "linearctl project list [--team <id>] [--state <status-type>] [--all-teams] [--json]" },
      create:               { usage: "linearctl project create --name <name> [--description ...] [--team <id>] [--json]" },
      update:               { usage: "linearctl project update <id> [--name ...] [--description ...] [--state ...] [--target-date <date>] [--json]" },
      "create-with-issues": { usage: "linearctl project create-with-issues --name <name> --team <id> --issues-json <json> [--description <text>] [--json]" },
      delete:               { usage: "linearctl project delete <id> [--json]" },
    },
    handler: handleProjectCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...teamFilterOptions(args),
      ...pickFields(args, "name", "description", "state", "targetDate", "issuesJson"),
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
      get:  { usage: "linearctl team get <id-or-key> [--set-default] [--json]" },
      list: { usage: "linearctl team list [--json]" },
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
      get:  { usage: "linearctl user get <id> [--json]" },
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
      "name", "description", "color", "team",
    ],
    subcommands: {
      get:    { usage: "linearctl label get <id> [--json]" },
      list:   { usage: "linearctl label list [--team <id>] [--all-teams] [--json]" },
      create: { usage: "linearctl label create --name <name> [--description ...] [--color ...] [--team <id>] [--json]" },
      delete: { usage: "linearctl label delete <id> [--json]" },
    },
    handler: handleLabelCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...teamFilterOptions(args),
      ...pickFields(args, "name", "description", "color"),
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
      get:    { usage: "linearctl state get <id> [--json]" },
      list:   { usage: "linearctl state list [--team <id>] [--all-teams] [--json]" },
      create: { usage: "linearctl state create --name <name> --team <id> --state-type <type> [--json]" },
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
      "issue", "body",
    ],
    subcommands: {
      list:   { usage: "linearctl comment list --issue <id> [--json]" },
      create: { usage: "linearctl comment create --issue <id> --body <text> [--json]" },
      update: { usage: "linearctl comment update <id> --body <text> [--json]" },
      delete: { usage: "linearctl comment delete <id> [--json]" },
    },
    handler: handleCommentCommand,
    buildOptions: (args, env) => ({
      ...curatedOptions(args, env),
      ...paginationOptions(args),
      ...pickFields(args, "issue", "body"),
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
      "issue", "output", "expires-in",
    ],
    subcommands: {
      upload:   { usage: "linearctl file upload <path> [--issue <id>] [--json]" },
      url:      { usage: "linearctl file url <attachment-id> [--expires-in <seconds>] [--json]" },
      download: { usage: "linearctl file download <url> [--output <path>] [--json]" },
    },
    handler: handleFileCommand,
    buildOptions: (args, env) => ({
      ...baseOptions(args, env),
      dryRun: args.dryRun,
      noRetry: args.noRetry,
      ...pickFields(args, "maxRetries"),
      ...pickFields(args, "issue", "output", "expiresIn"),
    }),
  },

  // ── Auth ───────────────────────────────────────────────────────────────
  {
    name: "auth",
    optionKeys: [
      "help", "json", "json-envelope",
      "config", "config-file", "credentials", "credentials-file",
      "profile", "api-key-env", "api-key-stdin", "oauth",
      "set-default", "remove-config", "api-url",
      "oauth-client-id", "callback-port", "no-browser",
    ],
    subcommands: {
      login:  { usage: "linearctl auth login --profile <name> --api-key-env <ENV>" },
      logout: { usage: "linearctl auth logout --profile <name>" },
      status: { usage: "linearctl auth status [--json]" },
      switch: { usage: "linearctl auth switch <profile>" },
      whoami: { usage: "linearctl auth whoami [--json]" },
    },
    handler: handleAuthCommand,
    buildOptions: (args, env, stdin) => ({
      ...baseOptions(args, env),
      ...pickFields(args, "apiKeyEnv", "oauthClientId", "callbackPort"),
      apiKeyStdin: args.apiKeyStdin,
      oauth: args.oauth,
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
      "help", "json", "json-envelope",
      "config", "config-file", "credentials", "credentials-file",
      "profile", "api-url", "raw", "stdin", "file", "vars-file", "var",
      "no-retry", "max-retries",
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
      "help", "json", "json-envelope",
      "config", "config-file", "credentials", "credentials-file",
      "profile", "api-url", "id", "input-json", "input-file", "input-stdin",
      "fields", "raw", "no-retry", "max-retries",
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
      "help", "json", "json-envelope",
      "config", "config-file", "credentials", "credentials-file",
      "profile", "api-url", "output-dir", "no-retry", "max-retries",
    ],
    subcommands: {
      version: { usage: "linearctl schema version [--json]" },
      pull:    { usage: "linearctl schema pull [--json] [--output-dir <path>]  (default: project src/generated/manifest)" },
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
      "help", "json", "json-envelope",
      "config", "config-file", "credentials", "credentials-file",
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
      "help", "json", "json-envelope", "scope",
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
