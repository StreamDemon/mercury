---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `mercuryai run`

One-command bootstrap and start:

```sh
pnpm mercuryai run
```

Does:

1. Auto-onboards if config is missing
2. Runs `mercuryai doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm mercuryai run --instance dev
```

## `mercuryai onboard`

Interactive first-time setup:

```sh
pnpm mercuryai onboard
```

If Mercury is already configured, rerunning `onboard` keeps the existing config in place. Use `mercuryai configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm mercuryai onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm mercuryai onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts Mercury with that setup.

## `mercuryai doctor`

Health checks with optional auto-repair:

```sh
pnpm mercuryai doctor
pnpm mercuryai doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `mercuryai configure`

Update configuration sections:

```sh
pnpm mercuryai configure --section server
pnpm mercuryai configure --section secrets
pnpm mercuryai configure --section storage
```

## `mercuryai env`

Show resolved environment configuration:

```sh
pnpm mercuryai env
```

This now includes bind-oriented deployment settings such as `MERCURY_BIND` and `MERCURY_BIND_HOST` when configured.

## `mercuryai allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm mercuryai allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.mercury/instances/default/config.json` |
| Database | `~/.mercury/instances/default/db` |
| Logs | `~/.mercury/instances/default/logs` |
| Storage | `~/.mercury/instances/default/data/storage` |
| Secrets key | `~/.mercury/instances/default/secrets/master.key` |

Override with:

```sh
MERCURY_HOME=/custom/home MERCURY_INSTANCE_ID=dev pnpm mercuryai run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm mercuryai run --data-dir ./tmp/mercury-dev
pnpm mercuryai doctor --data-dir ./tmp/mercury-dev
```
