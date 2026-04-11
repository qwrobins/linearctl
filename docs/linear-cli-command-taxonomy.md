# Linear CLI Command Taxonomy

## Layer 1: Curated Commands

### Auth

- `linear auth login`
- `linear auth logout`
- `linear auth status`
- `linear auth switch`

### Issue

- `linear issue list`
- `linear issue get`
- `linear issue create`
- `linear issue update`
- `linear issue close`
- `linear issue assign`
- `linear issue comment`

### Project

- `linear project list`
- `linear project get`
- `linear project create`
- `linear project update`

### Cycle

- `linear cycle list`
- `linear cycle get`
- `linear cycle create`
- `linear cycle update`

### Team

- `linear team list`
- `linear team get`

### User

- `linear user list`
- `linear user get`
- `linear user me`

### Label

- `linear label list`
- `linear label get`
- `linear label create`

### Comment

- `linear comment list`
- `linear comment create`
- `linear comment update`
- `linear comment delete`

### Attachment

- `linear attachment list`
- `linear attachment create`
- `linear attachment delete`

### File

- `linear file upload`
- `linear file download`
- `linear file url`

### Schema

- `linear schema pull`
- `linear schema version`
- `linear schema check`

## Layer 2: Generated API Commands

General pattern:

- `linear api <resource> <operation>`

Examples:

- `linear api issue list`
- `linear api issue get`
- `linear api issue create`
- `linear api project-milestone create`
- `linear api issue-label create`
- `linear api custom-view get`

Discoverability:

- `linear api --help`
- `linear api <resource> --help`
- `linear api <resource> <operation> --help`
- `linear api search <term>`

Common flags:

- `--id`
- `--input-json`
- `--input-file`
- `--input-stdin`
- `--fields`
- `--profile`
- `--json`
- `--json-envelope`

## Layer 3: Raw GraphQL Commands

- `linear gql query '<query>'`
- `linear gql query --file <path>`
- `linear gql query --stdin`
- `linear gql mutation '<mutation>'`
- `linear gql mutation --file <path>`
- `linear gql mutation --stdin`
- `linear gql introspect`

Common flags:

- `--var key=value`
- `--vars-file <path>`
- `--json`
- `--json-envelope`
- `--raw`
- `--profile`

## Post-MVP Curated Expansion Candidates

- `linear initiative ...`
- `linear milestone ...`
- `linear document ...`
- `linear status ...`
- `linear webhook ...`
- `linear agent ...`
- bulk operations
- JSONL streaming options
