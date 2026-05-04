---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm mercuryai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm mercuryai issue get <issue-id-or-identifier>

# Create issue
pnpm mercuryai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm mercuryai issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm mercuryai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm mercuryai issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm mercuryai issue release <issue-id>
```

## Company Commands

```sh
pnpm mercuryai company list
pnpm mercuryai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm mercuryai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm mercuryai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm mercuryai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm mercuryai agent list
pnpm mercuryai agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm mercuryai approval list [--status pending]

# Get approval
pnpm mercuryai approval get <approval-id>

# Create approval
pnpm mercuryai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm mercuryai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm mercuryai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm mercuryai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm mercuryai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm mercuryai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm mercuryai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm mercuryai dashboard get
```

## Heartbeat

```sh
pnpm mercuryai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
