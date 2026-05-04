# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative docs (read first)

`AGENTS.md` is the binding contract for contributors (human + AI). Beyond it, read in this order before non-trivial changes:

1. `doc/GOAL.md` — what Mercury is for
2. `doc/PRODUCT.md` — product surfaces
3. `doc/SPEC-implementation.md` — V1 build contract (controls when it conflicts with `doc/SPEC.md`)
4. `doc/DEVELOPING.md` — full dev guide (worktrees, ports, secrets, OpenClaw smoke)
5. `doc/DATABASE.md` — embedded vs hosted Postgres, migration workflow

## What this repo is

Mercury is a Node.js + React control plane that orchestrates a team of AI agents (Claude Code, Codex, Cursor, Gemini, OpenClaw, HTTP bots, etc.) into "zero-human companies" with org charts, goals, budgets, governance, and audit logging. **Not** a chatbot, agent framework, or workflow builder.

This checkout is the `HenkDz/mercury` fork (see `AGENTS.md` §11) on branch `feat/externalize-hermes-adapter` — the Hermes adapter is **plugin-only** here (no `hermes-mercury-adapter` import in `server/` or `ui/` source despite being in `package.json`).

## Workspace layout

pnpm monorepo (`pnpm-workspace.yaml`). Top-level workspaces:

- `server/` (`@mercuryai/server`) — Express REST API, orchestration services, heartbeat execution, plugin runtime. Entry: `server/src/index.ts`. Routes in `server/src/routes/`, services in `server/src/services/`.
- `ui/` (`@mercuryai/ui`) — React 19 + Vite board UI. Served by the API in dev middleware mode at the same origin.
- `cli/` — `mercuryai` CLI (onboard, doctor, configure, worktree, issue, context, etc.).
- `packages/db/` — Drizzle schema + migrations. **Embedded PGlite/Postgres** is started automatically when `DATABASE_URL` is unset.
- `packages/shared/` — API types, validators, constants, path constants. **Sync changes here whenever schema or routes change.**
- `packages/adapter-utils/` — shared adapter utilities.
- `packages/adapters/*` — per-agent adapters (`claude-local`, `codex-local`, `cursor-local`, `gemini-local`, `opencode-local`, `pi-local`, `openclaw-gateway`).
- `packages/plugins/*` — plugin SDK, sandbox-provider plugins, examples. Note `pnpm-workspace.yaml` excludes `sandbox-providers/**` and `examples/plugin-orchestration-smoke-example` from the workspace lockfile to keep them installable as standalone packages.
- `packages/mcp-server/` — MCP server bridge.

Shared TS config: `tsconfig.base.json`; root composite project at `tsconfig.json`.

## Common commands

Run from repo root unless noted.

```sh
pnpm install
pnpm dev              # full dev (API + UI in middleware mode), watch
pnpm dev:once         # full dev, no watch (auto-applies pending migrations)
pnpm dev:server       # server only
pnpm dev:ui           # UI only (vite)
pnpm dev:list         # inspect the managed dev runner for this repo
pnpm dev:stop         # stop it

pnpm typecheck        # `pnpm -r typecheck` after preflight workspace-link check
pnpm build            # `pnpm -r build` after preflight workspace-link check

pnpm test             # default — Vitest only (cheap). Aliased to `test:run`.
pnpm test:watch       # Vitest watch
pnpm test:e2e         # Playwright (opt-in, separate)
pnpm test:release-smoke

pnpm db:generate      # compiles packages/db then runs drizzle-kit generate
pnpm db:migrate       # apply pending migrations to the active instance
pnpm db:backup        # one-off backup via scripts/backup-db.sh

pnpm storybook        # @mercuryai/ui Storybook on :6006
```

Run a single Vitest file: `pnpm vitest run path/to/file.test.ts` (or `pnpm --filter @mercuryai/server exec vitest run path/to/file.test.ts` to scope to one workspace). The root `vitest.config.ts` lists every project — there is no separate root suite.

`pnpm test` does **not** run Playwright. Pick the smallest verification that proves the change; reserve `pnpm -r typecheck && pnpm test:run && pnpm build` for PR-ready hand-off (see `AGENTS.md` §7).

## Dev server specifics (Windows / NTFS)

- `pnpm dev` and `pnpm dev:once` are **idempotent** for the current repo + instance — if a runner is already alive they report it instead of double-starting.
- Default port is `3100`; this fork auto-detects and shifts to `3101+` if `3100` is taken by an upstream Mercury instance.
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead.
- Cold server startup from NTFS can take 30–60s. Don't assume failure immediately.
- Vite cache survives `rm -rf dist`; clear both `ui/dist` and `ui/node_modules/.vite` when fully resetting UI state.
- Kill all Mercury processes before starting: `pkill -f "mercury"; pkill -f "tsx.*index.ts"` (or the PowerShell equivalent).

## Database workflow

When you change the data model:

1. Edit `packages/db/src/schema/*.ts`.
2. Export new tables from `packages/db/src/schema/index.ts`.
3. `pnpm db:generate` — drizzle-kit reads the **compiled** schema from `packages/db/dist/schema/*.js` (the script compiles first).
4. `pnpm -r typecheck`.
5. Apply with `pnpm db:migrate` (or rely on auto-apply in `pnpm dev:once`).

Local dev DB lives at `~/.mercury/instances/default/db/`. Reset = delete that dir. Override with `MERCURY_HOME` and `MERCURY_INSTANCE_ID`.

For multi-worktree development, **never point two servers at the same embedded Postgres dir** — use `pnpm mercuryai worktree init` (see `doc/DEVELOPING.md` "Worktree-local Instances" for full CLI reference).

## Engineering rules (from AGENTS.md §5)

These are the invariants — not generic advice.

1. **Company-scoped.** Every domain entity is scoped to a company; routes/services must enforce the boundary.
2. **Sync the contract across all four layers** when schema or API behavior changes: `packages/db` schema, `packages/shared` types/validators, `server` routes/services, `ui` API clients/pages.
3. **Preserve control-plane invariants:** single-assignee task model; atomic issue checkout for `in_progress`; approval gates for governed actions; budget hard-stop auto-pause; activity-log entries for mutating actions.
4. **Plan files** go in `doc/plans/` named `YYYY-MM-DD-slug.md`. Don't create repo markdown when a Mercury issue's `plan` document is the right place.
5. **API/auth:** base path `/api`. Board access = full-control operator. Agents authenticate via bearer key in `agent_api_keys` (hashed at rest) and must not cross companies. Mutations write activity-log entries and return consistent HTTP errors (400/401/403/404/409/422/500).

## Pull requests

`AGENTS.md` §10 is mandatory: every PR must fill in **all** sections of `.github/PULL_REQUEST_TEMPLATE.md` — Thinking Path, What Changed, Verification, Risks, Model Used, Checklist. The repo also uses Greptile (`CONTRIBUTING.md`); a PR needs 5/5 with all comments addressed before merge.

`pnpm-lock.yaml` is **owned by GitHub Actions on `master`** — do **not** commit lockfile changes in pull requests.

## Mercury-specific notes

- Hermes adapter is **vendored** at `packages/adapters/hermes-local/` as `@mercuryai/adapter-hermes` (workspace package, sourced from `https://github.com/NousResearch/hermes-paperclip-adapter@0.2.0`). Re-sync procedure in `packages/adapters/hermes-local/UPSTREAM.md`. Adapter type stays `hermes_local` for backward compat.
- UI conventions in `RunTranscriptView.tsx` (stderr_group accordion, tool_group accordion) and `LatestRunCard` (markdown-stripped 3-line/280-char dashboard excerpt) are part of Mercury's source, not patches.
- Plugin loader (`server/src/adapters/plugin-loader.ts`) must stay free of hardcoded adapter imports. `createServerAdapter()` must include all optional fields, especially `detectModel`. Built-in UI adapters can shadow external plugin parsers — remove the built-in when fully externalizing.
