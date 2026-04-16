/**
 * Manual overrides for generated API command naming.
 *
 * The manifest generator derives resource/operation names from GraphQL field
 * names using heuristic suffix rules and depluralization.  When those
 * heuristics produce an awkward or unstable name, add an entry here keyed by
 * the exact GraphQL field name.  Overrides are checked in `fieldToEntry()`
 * **before** the heuristic path runs, so they always win.
 *
 * @example
 *   // GraphQL field "imageUploadFromUrl" heuristically splits as
 *   // resource="image-upload-from" operation="url" — override it:
 *   imageUploadFromUrl: { resource: "image", operation: "upload-from-url" }
 */
export const namingOverrides: Record<
  string,
  { resource: string; operation: string }
> = {
  // "imageUploadFromUrl" — the fallback regex peels the last capitalized word
  // ("Url") as the operation, giving resource="image-upload-from" op="url".
  // The actual intent is an upload operation on the image resource.
  imageUploadFromUrl: { resource: "image", operation: "upload-from-url" },

  // "attachmentsForURL" — depluralize cannot strip the "s" because the field
  // does not end in "s" after the "URL" suffix, yielding
  // resource="attachments-for-url".  Stabilise to "attachment".
  attachmentsForURL: { resource: "attachment", operation: "list-for-url" },

  // "issueImportCreateCSVJira" — consecutive suffixes cause the heuristic to
  // peel "Jira" as the operation and leave "issue-import-create-csv" as the
  // resource.  Stabilise under the issue-import resource.
  issueImportCreateCSVJira: { resource: "issue-import", operation: "create-csv-jira" },
};
