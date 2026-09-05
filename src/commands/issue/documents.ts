
export const CURATED_ISSUE_FRAGMENT = `
fragment CuratedIssue on Issue {
  id
  identifier
  title
  description
  priority
  estimate
  dueDate
  state { id name type }
  team { id key name }
  assignee { id name email }
  creator { id name email }
  cycle { id number name }
  project { id name }
  projectMilestone { id name }
  parent { id identifier title }
  labels { nodes { id name } }
  url
  trashed
  archivedAt
  createdAt
  updatedAt
}`;

export const CURATED_ISSUE_SEARCH_RESULT_FRAGMENT = `
fragment CuratedIssueSearchResult on IssueSearchResult {
  id
  identifier
  title
  description
  priority
  estimate
  dueDate
  state { id name type }
  team { id key name }
  assignee { id name email }
  creator { id name email }
  cycle { id number name }
  project { id name }
  projectMilestone { id name }
  parent { id identifier title }
  labels { nodes { id name } }
  url
  trashed
  archivedAt
  createdAt
  updatedAt
}`;

export const ISSUE_GET_QUERY = `
query IssueGet($id: String!) {
  issue(id: $id) {
    ...CuratedIssue
  }
}
${CURATED_ISSUE_FRAGMENT}`;

export const ISSUE_CREATE_MUTATION = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      ...CuratedIssue
    }
  }
}
${CURATED_ISSUE_FRAGMENT}`;

export const ISSUE_LIST_QUERY = `
query IssueList($first: Int!, $after: String, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
  issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
    nodes {
      ...CuratedIssue
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_ISSUE_FRAGMENT}`;

export const ISSUE_SEARCH_QUERY = `
query IssueSearch($first: Int!, $after: String, $term: String!, $filter: IssueFilter) {
  searchIssues(first: $first, after: $after, term: $term, filter: $filter) {
    nodes {
      ...CuratedIssueSearchResult
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_ISSUE_SEARCH_RESULT_FRAGMENT}`;

export const ISSUE_UPDATE_MUTATION = `
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      ...CuratedIssue
    }
  }
}
${CURATED_ISSUE_FRAGMENT}`;

export const ISSUE_ARCHIVE_MUTATION = `
mutation IssueArchive($id: String!) {
  issueArchive(id: $id) {
    success
  }
}`;

export const ISSUE_DELETE_MUTATION = `
mutation IssueDelete($id: String!) {
  issueDelete(id: $id) {
    success
  }
}`;

export const COMMENT_CREATE_MUTATION = `
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
      createdAt
      user { id name email }
    }
  }
}`;

export const ATTACHMENT_LINK_SLACK_MUTATION = `
mutation AttachmentLinkSlack($issueId: String!, $url: String!, $syncToCommentThread: Boolean, $title: String) {
  attachmentLinkSlack(issueId: $issueId, url: $url, syncToCommentThread: $syncToCommentThread, title: $title) {
    success
    attachment {
      id
      title
      subtitle
      url
      issue { id identifier title }
      createdAt
    }
  }
}`;
