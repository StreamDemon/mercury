# CLI Reference

Mercury CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm mercuryai --help
```

First-time local bootstrap + run:

```sh
pnpm mercuryai run
```

Choose local instance:

```sh
pnpm mercuryai run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `mercuryai onboard` and `mercuryai configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `mercuryai run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `MERCURY_DEPLOYMENT_MODE`
- `mercuryai run` and `mercuryai doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm mercuryai allowed-hostname dotta-macbook-pro
```

Bring up the default local SSH fixture for environment testing:

```sh
pnpm mercuryai env-lab up
pnpm mercuryai env-lab doctor
pnpm mercuryai env-lab status --json
pnpm mercuryai env-lab down
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.mercury`:

```sh
pnpm mercuryai run --data-dir ./tmp/mercury-dev
pnpm mercuryai issue list --data-dir ./tmp/mercury-dev
```

## Context Profiles

Store local defaults in `~/.mercury/context.json`:

```sh
pnpm mercuryai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm mercuryai context show
pnpm mercuryai context list
pnpm mercuryai context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm mercuryai context set --api-key-env-var-name MERCURY_API_KEY
export MERCURY_API_KEY=...
```

## Company Commands

```sh
pnpm mercuryai company list
pnpm mercuryai company get <company-id>
pnpm mercuryai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm mercuryai company delete PAP --yes --confirm PAP
pnpm mercuryai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `MERCURY_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `MERCURY_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm mercuryai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm mercuryai issue get <issue-id-or-identifier>
pnpm mercuryai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm mercuryai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm mercuryai issue comment <issue-id> --body "..." [--reopen]
pnpm mercuryai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm mercuryai issue release <issue-id>
```

## Agent Commands

```sh
pnpm mercuryai agent list --company-id <company-id>
pnpm mercuryai agent get <agent-id>
pnpm mercuryai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Mercury agent:

- creates a new long-lived agent API key
- installs missing Mercury skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `MERCURY_API_URL`, `MERCURY_COMPANY_ID`, `MERCURY_AGENT_ID`, and `MERCURY_API_KEY`

Example for shortname-based local setup:

```sh
pnpm mercuryai agent local-cli codexcoder --company-id <company-id>
pnpm mercuryai agent local-cli claudecoder --company-id <company-id>
```

## Approval Commands

```sh
pnpm mercuryai approval list --company-id <company-id> [--status pending]
pnpm mercuryai approval get <approval-id>
pnpm mercuryai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm mercuryai approval approve <approval-id> [--decision-note "..."]
pnpm mercuryai approval reject <approval-id> [--decision-note "..."]
pnpm mercuryai approval request-revision <approval-id> [--decision-note "..."]
pnpm mercuryai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm mercuryai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm mercuryai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm mercuryai dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm mercuryai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Default local instance root is `~/.mercury/instances/default`:

- config: `~/.mercury/instances/default/config.json`
- embedded db: `~/.mercury/instances/default/db`
- logs: `~/.mercury/instances/default/logs`
- storage: `~/.mercury/instances/default/data/storage`
- secrets key: `~/.mercury/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
MERCURY_HOME=/custom/home MERCURY_INSTANCE_ID=dev pnpm mercuryai run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm mercuryai configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
