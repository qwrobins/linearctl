import { emitValidationError } from "../core/output/validation-error.js";
import { type IssueCommandOptions } from "./issue/options.js";
import { handleIssueGet, handleIssueSearch, handleIssueList } from "./issue/read.js";
import { handleIssueCreate, handleIssueUpdate, handleIssueDelete } from "./issue/write.js";
import { handleIssueClose, handleIssueAssign, handleIssueComment, handleIssueAttachSlack } from "./issue/workflow.js";
import { handleBulkUpdate, handleBulkClose, handleBulkArchive, handleBulkDelete, handleBulkAssign } from "./issue/bulk.js";
export type { IssueCommandOptions } from "./issue/options.js";
export type { NormalizedIssue } from "./issue/model.js";
export { normalizeIssue } from "./issue/model.js";
export type { NormalizedComment } from "./issue/model.js";

export async function handleIssueCommand(
  positionals: string[],
  options: IssueCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get" || subcommand === "view") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError(`usage: linearctl issue ${subcommand} <identifier>`, options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue get accepts exactly one identifier.", options);
    }
    return handleIssueGet(identifier, options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("issue create does not accept positional arguments.", options);
    }
    return handleIssueCreate(options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("issue list does not accept positional arguments.", options);
    }
    if ((options.query ?? options.search) !== undefined) {
      return handleIssueSearch(options, true);
    }
    return handleIssueList(options);
  }

  if (subcommand === "search") {
    if (rest.length > 1) {
      return emitValidationError("issue search accepts at most one query argument.", options);
    }
    if (rest[0] !== undefined && (options.query !== undefined || options.search !== undefined)) {
      return emitValidationError(
        "mixed positional and flag-based search terms are not allowed; provide either a positional query or --query/--search, not both.",
        options
      );
    }
    return handleIssueSearch(rest[0] === undefined ? options : { ...options, query: options.query ?? options.search ?? rest[0] });
  }

  if (subcommand === "update") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue update <identifier> [--title <text>] [--description <text>|--description-file <path|->] [--priority <0-4>] [--estimate <n>] [--due-date <YYYY-MM-DD|none>] [--assignee <id|none>] [--label <name|id>] [--state <name|id>] [--cycle <id|none>] [--project <name|id|none>] [--project-milestone <id|none>|--milestone <id|none>] [--parent <identifier|none>] [--json]", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue update accepts exactly one identifier.", options);
    }
    return handleIssueUpdate(identifier, options);
  }

  if (subcommand === "close") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue close <identifier>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue close accepts exactly one identifier.", options);
    }
    return handleIssueClose(identifier, options);
  }

  if (subcommand === "delete") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue delete <identifier>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue delete accepts exactly one identifier.", options);
    }
    return handleIssueDelete(identifier, options);
  }

  if (subcommand === "assign") {
    const identifier = rest[0];
    const assigneeId = rest[1];
    if (identifier === undefined || identifier === "" || assigneeId === undefined || assigneeId === "") {
      return emitValidationError("usage: linearctl issue assign <identifier> <assignee-id>", options);
    }
    if (rest.length > 2) {
      return emitValidationError("issue assign accepts exactly two positional arguments.", options);
    }
    return handleIssueAssign(identifier, assigneeId, options);
  }

  if (subcommand === "comment") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue comment <identifier> --body <text>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue comment accepts exactly one identifier.", options);
    }
    return handleIssueComment(identifier, options);
  }

  if (subcommand === "attach-slack") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>]", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue attach-slack accepts exactly one identifier.", options);
    }
    return handleIssueAttachSlack(identifier, options);
  }

  if (subcommand === "bulk-update") {
    if (rest.length > 0) {
      return emitValidationError("issue bulk-update does not accept positional arguments. Use --ids.", options);
    }
    return handleBulkUpdate(options);
  }

  if (subcommand === "bulk-close") {
    if (rest.length > 0) {
      return emitValidationError("issue bulk-close does not accept positional arguments. Use --ids.", options);
    }
    return handleBulkClose(options);
  }

  if (subcommand === "bulk-archive") {
    if (rest.length > 0) {
      return emitValidationError("issue bulk-archive does not accept positional arguments. Use --ids.", options);
    }
    return handleBulkArchive(options);
  }

  if (subcommand === "bulk-delete") {
    if (rest.length > 0) {
      return emitValidationError("issue bulk-delete does not accept positional arguments. Use --ids.", options);
    }
    return handleBulkDelete(options);
  }

  if (subcommand === "bulk-assign") {
    if (rest.length > 0) {
      return emitValidationError("issue bulk-assign does not accept positional arguments. Use --ids.", options);
    }
    return handleBulkAssign(options);
  }

  return emitValidationError("unsupported issue command. Try: get, view, create, list, search, update, close, delete, assign, comment, attach-slack, bulk-update, bulk-close, bulk-archive, bulk-delete, bulk-assign.", options);
}
