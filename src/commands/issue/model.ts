import { commandIO, type CommandIO } from "../../core/runtime/options.js";

export interface RawSlackAttachment {
  id: string;
  title: string | null;
  subtitle: string | null;
  url: string;
  issue: { id: string; identifier: string; title: string };
  createdAt: string;
}

export interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  state: { id: string; name: string; type: string } | null;
  team: { id: string; key: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  creator: { id: string; name: string; email: string } | null;
  cycle: { id: string; number: number; name: string | null } | null;
  project: { id: string; name: string } | null;
  projectMilestone: { id: string; name: string } | null;
  parent: { id: string; identifier: string; title: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  url: string;
  trashed: boolean | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  state: { id: string; name: string; type: string } | null;
  team: { id: string; key: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  creator: { id: string; name: string; email: string } | null;
  cycle: { id: string; number: number; name: string | null } | null;
  project: { id: string; name: string } | null;
  projectMilestone: { id: string; name: string } | null;
  parent: { id: string; identifier: string; title: string } | null;
  labels: Array<{ id: string; name: string }>;
  url: string;
  trashed: boolean | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function normalizeIssue(raw: RawIssue): NormalizedIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description,
    priority: raw.priority,
    estimate: raw.estimate,
    dueDate: raw.dueDate,
    state: raw.state,
    team: raw.team,
    assignee: raw.assignee,
    creator: raw.creator,
    cycle: raw.cycle,
    project: raw.project,
    projectMilestone: raw.projectMilestone,
    parent: raw.parent,
    labels: raw.labels.nodes,
    url: raw.url,
    trashed: raw.trashed,
    archivedAt: raw.archivedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

export function printHumanIssue(issue: NormalizedIssue, options: CommandIO): void {
  const { stdout } = commandIO(options);
  stdout.write(`${issue.identifier}  ${issue.title}\n`);
  if (issue.state !== null) {
    stdout.write(`  State:    ${issue.state.name}\n`);
  }
  stdout.write(`  Team:     ${issue.team.name}\n`);
  if (issue.assignee !== null) {
    stdout.write(`  Assignee: ${issue.assignee.name}\n`);
  }
  if (issue.priority !== 0) {
    stdout.write(`  Priority: ${issue.priority}\n`);
  }
  if (issue.estimate !== null) {
    stdout.write(`  Estimate: ${issue.estimate}\n`);
  }
  if (issue.dueDate !== null) {
    stdout.write(`  Due date: ${issue.dueDate}\n`);
  }
  if (issue.project !== null) {
    stdout.write(`  Project:  ${issue.project.name}\n`);
  }
  if (issue.trashed === true) {
    stdout.write("  Trashed: true\n");
  }
  if (issue.archivedAt !== null) {
    stdout.write(`  Archived: ${issue.archivedAt}\n`);
  }
  if (issue.labels.length > 0) {
    stdout.write(`  Labels:   ${issue.labels.map((l) => l.name).join(", ")}\n`);
  }
  stdout.write(`  URL:      ${issue.url}\n`);
}

export interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

export interface NormalizedComment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}
