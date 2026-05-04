# Mercury MCP Server

Model Context Protocol server for Mercury.

This package is a thin MCP wrapper over the existing Mercury REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `MERCURY_API_URL` - Mercury base URL, for example `http://localhost:3100`
- `MERCURY_API_KEY` - bearer token used for `/api` requests
- `MERCURY_COMPANY_ID` - optional default company for company-scoped tools
- `MERCURY_AGENT_ID` - optional default agent for checkout helpers
- `MERCURY_RUN_ID` - optional run id forwarded on mutating requests

## Usage

```sh
npx -y @mercuryai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @mercuryai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `mercuryMe`
- `mercuryInboxLite`
- `mercuryListAgents`
- `mercuryGetAgent`
- `mercuryListIssues`
- `mercuryGetIssue`
- `mercuryGetHeartbeatContext`
- `mercuryListComments`
- `mercuryGetComment`
- `mercuryListIssueApprovals`
- `mercuryListDocuments`
- `mercuryGetDocument`
- `mercuryListDocumentRevisions`
- `mercuryListProjects`
- `mercuryGetProject`
- `mercuryGetIssueWorkspaceRuntime`
- `mercuryWaitForIssueWorkspaceService`
- `mercuryListGoals`
- `mercuryGetGoal`
- `mercuryListApprovals`
- `mercuryGetApproval`
- `mercuryGetApprovalIssues`
- `mercuryListApprovalComments`

Write tools:

- `mercuryCreateIssue`
- `mercuryUpdateIssue`
- `mercuryCheckoutIssue`
- `mercuryReleaseIssue`
- `mercuryAddComment`
- `mercurySuggestTasks`
- `mercuryAskUserQuestions`
- `mercuryRequestConfirmation`
- `mercuryUpsertIssueDocument`
- `mercuryRestoreIssueDocumentRevision`
- `mercuryControlIssueWorkspaceServices`
- `mercuryCreateApproval`
- `mercuryLinkIssueApproval`
- `mercuryUnlinkIssueApproval`
- `mercuryApprovalDecision`
- `mercuryAddApprovalComment`

Escape hatch:

- `mercuryApiRequest`

`mercuryApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
