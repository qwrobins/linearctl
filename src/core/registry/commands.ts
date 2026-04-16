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
import type { CommandRegistration, ParsedCliArguments } from "./types.js";

// Helper to spread optional fields without cluttering every buildOptions
function optionalString(value: string | undefined, key: string): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function optionalNumber(value: number | undefined, key: string): Record<string, number> {
  return value === undefined ? {} : { [key]: value };
}

function optionalBool(value: boolean | undefined, key: string): Record<string, boolean> {
  if (value === undefined || value === false) return {};
  return { [key]: value };
}

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
      "cycle", "project", "order-by", "order-dir",
    ],
    subcommands: {
      get:            { usage: "linearctl issue get <identifier> [--json]" },
      create:         { usage: "linearctl issue create --title <title> --team <id> [--description <text>] [--priority <0-4>] [--estimate <n>] [--assignee <id>] [--label <id>] [--state <id>] [--cycle <id>] [--project <id>] [--json]" },
      list:           { usage: "linearctl issue list [--state <name>] [--assignee <id>] [--team <id>] [--label <name|id>] [--priority <0-4>] [--cycle <id>] [--project <id>] [--created-after <date>] [--updated-after <date>] [--completed-after <date>] [--order-by <field>] [--all-teams] [--all] [--json]" },
      search:         { usage: "linearctl issue search --query <text> [--all] [--json]" },
      update:         { usage: "linearctl issue update <identifier> [--title <text>] [--description <text>] [--priority <0-4>] [--estimate <n>] [--assignee <id>] [--state <id>] [--json]" },
      close:          { usage: "linearctl issue close <identifier> [--state <name>] [--json]" },
      assign:         { usage: "linearctl issue assign <identifier> <assignee-id> [--json]" },
      comment:        { usage: "linearctl issue comment <identifier> --body <text> [--json]" },
      "attach-slack": { usage: "linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>] [--json]" },
      "bulk-update":  { usage: "linearctl issue bulk-update --ids <id1,id2,...> [--state <id>] [--assignee <id>] [--priority <0-4>] [--estimate <n>] [--label <id>] [--cycle <id>] [--json]" },
      "bulk-close":   { usage: "linearctl issue bulk-close --ids <id1,id2,...> [--json]" },
      "bulk-assign":  { usage: "linearctl issue bulk-assign --ids <id1,id2,...> --assignee <id> [--json]" },
    },
    handler: handleIssueCommand,
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, sync: args.sync, dryRun: args.dryRun, quiet: args.quiet,
      allTeams: args.allTeams, jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.title, "title"),
      ...optionalString(args.team, "team"),
      ...optionalString(args.description, "description"),
      ...optionalString(args.priority, "priority"),
      ...optionalString(args.estimate, "estimate"),
      ...optionalString(args.assignee, "assignee"),
      ...optionalString(args.label, "label"),
      ...optionalString(args.state, "state"),
      ...optionalString(args.inputJson, "inputJson"),
      ...optionalString(args.ids, "ids"),
      ...optionalString(args.body, "body"),
      ...optionalString(args.url, "url"),
      ...optionalString(args.query, "query"),
      ...optionalString(args.filterJson, "filterJson"),
      ...optionalString(args.createdAfter, "createdAfter"),
      ...optionalString(args.updatedAfter, "updatedAfter"),
      ...optionalString(args.completedAfter, "completedAfter"),
      ...optionalString(args.cycle, "cycle"),
      ...optionalString(args.project, "project"),
      ...optionalString(args.orderBy, "orderBy"),
      ...optionalString(args.orderDir, "orderDir"),
      ...optionalBool(args.all, "all"),
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
    }),
  },

  // ── Project ────────────────────────────────────────────────────────────
  {
    name: "project",
    optionKeys: [
      ...CURATED_BASE,
      ...OPTION_GROUPS.allTeams,
      "name", "description", "team", "state", "issues-json",
    ],
    subcommands: {
      get:                  { usage: "linearctl project get <id> [--json]" },
      list:                 { usage: "linearctl project list [--team <id>] [--state <name>] [--all-teams] [--json]" },
      create:               { usage: "linearctl project create --name <name> [--description ...] [--team <id>] [--json]" },
      update:               { usage: "linearctl project update <id> [--name ...] [--state ...] [--json]" },
      "create-with-issues": { usage: "linearctl project create-with-issues --name <name> --team <id> --issues-json <json> [--description <text>] [--json]" },
      delete:               { usage: "linearctl project delete <id> [--json]" },
    },
    handler: handleProjectCommand,
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, dryRun: args.dryRun, quiet: args.quiet,
      allTeams: args.allTeams, jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.name, "name"),
      ...optionalString(args.description, "description"),
      ...optionalString(args.team, "team"),
      ...optionalString(args.state, "state"),
      ...optionalString(args.issuesJson, "issuesJson"),
      all: args.all,
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, dryRun: args.dryRun, quiet: args.quiet,
      allTeams: args.allTeams, jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.name, "name"),
      ...optionalString(args.description, "description"),
      ...optionalString(args.team, "team"),
      ...optionalString(args.startsAt, "startsAt"),
      ...optionalString(args.endsAt, "endsAt"),
      all: args.all,
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl, quiet: args.quiet,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      setDefault: args.setDefault,
      ...optionalBool(args.all, "all"),
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl, quiet: args.quiet,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalBool(args.all, "all"),
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, dryRun: args.dryRun, quiet: args.quiet,
      allTeams: args.allTeams, jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.name, "name"),
      ...optionalString(args.description, "description"),
      ...optionalString(args.color, "color"),
      ...optionalString(args.team, "team"),
      ...optionalBool(args.all, "all"),
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, dryRun: args.dryRun, quiet: args.quiet,
      allTeams: args.allTeams, jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.name, "name"),
      ...optionalString(args.stateType, "stateType"),
      ...optionalString(args.description, "description"),
      ...optionalString(args.color, "color"),
      ...optionalString(args.position, "position"),
      ...optionalString(args.team, "team"),
      ...optionalBool(args.all, "all"),
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, dryRun: args.dryRun, quiet: args.quiet,
      jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.name, "name"),
      ...optionalString(args.statusType, "statusType"),
      ...optionalString(args.description, "description"),
      ...optionalString(args.color, "color"),
      ...optionalString(args.position, "position"),
      ...optionalBool(args.all, "all"),
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, dryRun: args.dryRun, quiet: args.quiet,
      jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.issue, "issue"),
      ...optionalString(args.body, "body"),
      ...optionalBool(args.all, "all"),
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, dryRun: args.dryRun, quiet: args.quiet,
      jsonEnvelope: args.jsonEnvelope, jsonl: args.jsonl,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.issue, "issue"),
      ...optionalString(args.url, "url"),
      ...optionalString(args.title, "title"),
      ...optionalBool(args.all, "all"),
      ...optionalNumber(args.max, "max"),
      ...optionalNumber(args.pageSize, "pageSize"),
      ...optionalString(args.after, "after"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, dryRun: args.dryRun, jsonEnvelope: args.jsonEnvelope,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.issue, "issue"),
      ...optionalString(args.output, "output"),
      ...optionalString(args.expiresIn, "expiresIn"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope,
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.profile, "profile"),
      ...optionalString(args.apiKeyEnv, "apiKeyEnv"),
      apiKeyStdin: args.apiKeyStdin,
      oauth: args.oauth,
      ...optionalString(args.oauthClientId, "oauthClientId"),
      ...optionalString(args.callbackPort, "callbackPort"),
      noBrowser: args.noBrowser,
      setDefault: args.setDefault,
      removeConfig: args.removeConfig,
      ...optionalString(args.apiUrl, "apiUrl"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope,
      raw: args.raw, stdin: args.stdin,
      ...optionalString(args.file, "file"),
      ...optionalString(args.varsFile, "varsFile"),
      vars: args.vars,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope,
      raw: args.raw,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.id, "id"),
      ...optionalString(args.inputJson, "inputJson"),
      ...optionalString(args.inputFile, "inputFile"),
      inputStdin: args.inputStdin,
      ...optionalString(args.fields, "fields"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope,
      ...optionalString(args.profile, "profile"),
      configFile: args.configFile, credentialsFile: args.credentialsFile,
      ...optionalString(args.apiUrl, "apiUrl"),
      ...optionalString(args.outputDir, "outputDir"),
      env,
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
    buildOptions: (args: ParsedCliArguments, env: NodeJS.ProcessEnv) => ({
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
    buildOptions: (args: ParsedCliArguments, _env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream) => ({
      json: args.json, jsonEnvelope: args.jsonEnvelope,
      ...optionalString(args.scope, "scope"),
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
