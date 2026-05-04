---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Mercury uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `MERCURY_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `MERCURY_BIND_HOST` | (unset) | Required when `MERCURY_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `MERCURY_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `MERCURY_HOME` | `~/.mercury` | Base directory for all Mercury data |
| `MERCURY_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `MERCURY_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `MERCURY_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `MERCURY_API_URL` | (auto-derived) | Mercury API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `MERCURY_SECRETS_MASTER_KEY_FILE` | `~/.mercury/.../secrets/master.key` | Path to key file |
| `MERCURY_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `MERCURY_AGENT_ID` | Agent's unique ID |
| `MERCURY_COMPANY_ID` | Company ID |
| `MERCURY_API_URL` | Mercury API base URL (inherits the server-level value; see Server Configuration above) |
| `MERCURY_API_KEY` | Short-lived JWT for API auth |
| `MERCURY_RUN_ID` | Current heartbeat run ID |
| `MERCURY_TASK_ID` | Issue that triggered this wake |
| `MERCURY_WAKE_REASON` | Wake trigger reason |
| `MERCURY_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `MERCURY_APPROVAL_ID` | Resolved approval ID |
| `MERCURY_APPROVAL_STATUS` | Approval decision |
| `MERCURY_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
