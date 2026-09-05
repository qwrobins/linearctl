import { type CommandOptions } from "../../core/runtime/options.js";

export interface IssueCommandOptions extends CommandOptions {
  jsonl?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  confirm?: boolean;
  // issue create/update flags
  title?: string;
  team?: string;
  allTeams?: boolean;
  description?: string;
  descriptionFile?: string;
  stdinStream?: NodeJS.ReadableStream;
  priority?: string;
  estimate?: string;
  dueDate?: string;
  assignee?: string;
  label?: string;
  state?: string;
  states?: string[];
  status?: string;
  milestone?: string;
  projectMilestone?: string;
  inputJson?: string;
  // bulk operation flags
  ids?: string;
  // issue comment flags
  body?: string;
  bodyFile?: string;
  // issue attach-slack flags
  url?: string;
  sync?: boolean;
  // parent issue flag
  parent?: string;
  // issue list flags
  cycle?: string;
  project?: string;
  filterJson?: string;
  createdAfter?: string;
  updatedAfter?: string;
  completedAfter?: string;
  orderBy?: string;
  orderDir?: string;
  // issue search flags
  query?: string;
  search?: string;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  quiet?: boolean;
}
