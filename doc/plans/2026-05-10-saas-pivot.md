# SaaS Pivot — Multi-Tenant Mercury Platform

Status: Roadmap (post-stabilization)
Date: 2026-05-10
Owner: Cross-cutting (db + shared + server + ui + cli + adapters + infra)
Related: `doc/plans/2026-02-23-deployment-auth-mode-consolidation.md` (current auth foundation), `AGENTS.md` §5 (engineering invariants)

## Goal

Evolve Mercury from "self-hosted control plane any team can install" to a production-grade multi-tenant SaaS platform where:

1. Anyone can sign up at `https://mercury.<domain>` and get a working account.
2. Each user creates one or more **organizations** (the new tenant boundary).
3. Within an organization, users build **companies** (the existing domain entity, unchanged in shape) and invite teammates.
4. Self-hosted Mercury continues to ship from the same codebase — it is just SaaS with `single_org: true` and one org pre-seeded.

The wedge is **self-serve discovery**: every random sign-up is a free user-research interview, and the unit of growth becomes the individual builder rather than the team adoption decision.

## Strategic positioning

This pivot is intentionally chosen over the alternative (invite-only multi-tenant, sold to teams who already know they want Mercury) because:

- It compounds. Self-serve produces a top-of-funnel that bottoms-up sells into teams.
- Mercury's existing **company-scoped invariant** (`AGENTS.md` §5.1) is a real architectural head start — most pre-SaaS codebases must retrofit this discipline.
- Mercury is dev-stage with no production users yet — clean cutover is still possible. (See user memory: prefer fix-forward, skip migration shims.)

## Sequencing relative to existing work

This is the **first big tackle after Mercury stabilization completes**. Hard prerequisites before Phase 0 starts:

- Wince #3 Track A — final ~20% (heartbeat hot path, golden-trace fixture, executeRun decomposition). User-driven.
- Wince #4 — shared-validator follow-up.
- Two unfiled UX bugs (`mercuryai onboard` misleading server banner; container :3101 host mapping).

SaaS work begun before these resolve will compound architectural debt. **Do not start Phase 0 until those land.**

## The single defining decision (Phase 0)

Everything else in this plan flows from one architectural call: **how do agents execute in a SaaS Mercury?**

Today, the server spawns Claude Code / Codex / Cursor as **local processes on the host**. This cannot work when "the host" is your prod server hosting strangers' workloads. Three options:

### Option A — BYOC runner (control plane in cloud, compute on user's machine)

User installs `mercury-runner` daemon locally. It connects out to cloud Mercury via authenticated long-poll/websocket. Agents still spawn on the user's box with their keys.

| | |
|---|---|
| Infra burden | Lowest — control plane is mostly stateless API + DB |
| First-impression magic | Lowest — requires a local install before anything happens |
| COGS | Near-zero per agent run (user pays their own LLM bill) |
| Security blast radius | Tiny — no untrusted code in our infra |
| Time to v1 | Fastest |

### Option B — Hosted execution in sandboxes

Mercury runs agents in per-customer microVMs. Candidate substrates: Firecracker, Vercel Sandbox, Modal, Fly Machines, E2B.

| | |
|---|---|
| Infra burden | Highest — sandbox lifecycle, image registry, per-tenant networking, egress controls |
| First-impression magic | Highest — sign-up to running agent in <60s |
| COGS | Per-run sandbox cost in your gross margin |
| Security blast radius | Large — untrusted agent code in our infra |
| Time to v1 | Slowest |

### Option C — Hybrid (BYOC v1, hosted v2)

Ship BYOC first to validate the SaaS thesis with minimal infra spend. Add hosted execution after revenue justifies it. **Recommended default unless Phase 0 surfaces a blocker.**

Phase 0 produces a written decision in this doc with reasoning. No code lands before the decision.

## Single-codebase principle

**Self-hosted Mercury and SaaS Mercury ship from the same codebase, distinguished only by config.**

Self-hosted = `MERCURY_TENANT_MODE=single` with one pre-seeded organization. SaaS = `MERCURY_TENANT_MODE=multi`. Every route, service, and migration must work in both modes. No fork. No conditional code paths beyond what the tenant-mode flag explicitly enables.

This keeps the self-hosted offering alive (real value for security-conscious teams) without doubling maintenance.

## Layer-by-layer delta inventory

### `packages/db` — schema additions

New tables:

- `organizations` (id, name, slug, owner_user_id, plan_id, status, created_at)
- `organization_memberships` (org_id, user_id, role, created_at) — roles: `owner`, `admin`, `member`
- `organization_invites` — replaces or wraps current instance-scoped invites
- `subscriptions` (org_id, stripe_customer_id, plan_id, status, current_period_end)
- `usage_meters` (org_id, metric_key, period_start, value) — agent-runs, tokens, storage
- `audit_log` per-org partition strategy (existing `activity_log` grows org_id)

Schema additions to existing tables:

- `companies.organization_id` — non-null FK (in single mode, all rows point to the seeded org)
- `users.primary_organization_id` — convenience pointer for sign-in routing
- Every company-scoped table inherits org-scope transitively via `companies.organization_id` (no separate `org_id` column needed on issues/comments/etc.)

Migrations: clean — no users to preserve. Embedded Postgres remains the dev default; prod requires external `DATABASE_URL`.

### `packages/shared` — types + validators + paths

- `Organization`, `OrganizationMembership`, `Subscription`, `Plan` types
- `OrganizationRole` enum + role-check helpers
- New error codes: `ORG_NOT_FOUND`, `ORG_QUOTA_EXCEEDED`, `ORG_PLAN_DOWNGRADE_BLOCKED`, etc.
- Path constants: `/api/orgs/:orgId/...` becomes the canonical scoping prefix; `/api/companies/:companyId/...` retained for backward compat where the company implies its org

### `server/` — routes, services, middleware

- `actor` shape grows `organizationIds: string[]` and `currentOrganizationId: string | null`
- New middleware: `requireOrganizationMembership(role?)` — runs **above** existing `requireCompanyAccess`
- New routes: `POST /api/orgs`, `GET /api/orgs/:id`, `POST /api/orgs/:id/members`, `POST /api/orgs/:id/invites`, billing endpoints
- **Sign-up route** (currently invite-only): `POST /api/auth/sign-up` with email verification, captcha, rate limit
- Email service abstraction: `EmailService` with `LocalDevAdapter` (logs to console) and `ResendAdapter` (or SES/Postmark — TBD)
- Secrets abstraction: `SecretsBackend` with `FileSystemBackend` (today) and `KmsBackend` (AWS KMS / GCP KMS — TBD)
- Stripe webhook handler: `POST /api/webhooks/stripe`
- Per-org rate limiting + abuse heuristics
- Storage abstraction: extend existing `MERCURY_STORAGE_MODE` (already in env-var doc) to fully support S3/R2 — not just file mode

### `ui/` — sign-up + org switcher + billing

- Sign-up page (new) — currently only an invite landing flow exists
- Email verification UI
- Org switcher in top nav (left of company switcher)
- Org settings page: members, invites, billing, plan, danger zone (delete org)
- New-user onboarding flow: create org → create first company → invite teammates → connect first agent
- Plan upgrade modal + Stripe Checkout redirect
- Per-org usage dashboard

### `cli/` — runner + cloud login (Option A or C only)

- New package: `packages/mercury-runner/` — daemon process that connects out to cloud Mercury, pulls work, spawns adapters locally
- `mercuryai cloud login` — paste-token flow that registers the local machine as a runner for the user's org
- `mercuryai cloud status` — show connected runner state
- Existing self-hosted commands (`onboard`, `doctor`, `worktree`, etc.) all continue to work unchanged

### `packages/adapters/*` — depends on Phase 0 outcome

- Option A (BYOC): adapters spawn locally as today; runner just relays I/O over the cloud connection. Minimal adapter changes.
- Option B (hosted sandboxes): adapters spawn inside sandbox containers; need image-based packaging for each adapter.
- Option C (hybrid): start with A's model.

### `packages/plugins/*` — sandboxing tightening (SaaS only)

- Plugin loader (`server/src/adapters/plugin-loader.ts`) gains an allowlist mode for SaaS — untrusted plugin code cannot execute on shared infra without review.
- Self-hosted continues to load plugins freely.

### Infrastructure (new)

| Concern | Candidate | Notes |
|---|---|---|
| Hosted Postgres | Neon | Serverless, branchable, fits Mercury's worktree model |
| Object storage | S3 or R2 | Artifacts, transcripts, uploads |
| Secrets/KMS | AWS KMS or GCP KMS | Replaces file-based `master.key` in prod |
| Sessions / rate limit | Redis (Upstash) | Better Auth session store, abuse limits |
| Email | Resend | Verification, invites, notifications |
| Billing | Stripe | Checkout, webhooks, customer portal |
| Observability | Sentry + (TBD: Datadog vs Grafana Cloud) | Per-tenant tagging |
| Status page | (TBD: Statuspage / Better Uptime) | Public uptime + incident comms |
| Compute | Fly.io or Vercel | Initial control-plane host |

Final stack decisions deferred to Phase 2.

## Non-goals (v1)

- SOC2 certification (start the readiness work, but cert lands post-launch).
- SSO / SAML / SCIM (enterprise plan, post-v1).
- Multi-region active-active (single primary region for v1).
- Custom domains per organization.
- White-labeling / per-org branding.
- Marketplace billing for plugins.
- Support for >1 paid plan tier in v1 (one free, one paid; tiering comes later).

## Phase plan

### Phase 0 — Agent execution decision (1–2 weeks)

Lock the architectural call. No code merges before this concludes.

Deliverables:
- Decision recorded in this doc with reasoning
- 1-page comparison memo with cost model for each option at 100/1000/10000 active orgs
- Spike branch validating the chosen option's hot path

Exit: written decision committed to main.

### Phase 1 — Tenancy layer in shared codebase (3–4 weeks)

Shipped to **self-hosted first** to derisk. SaaS-mode flag stays off.

Deliverables:
- `organizations` + `organization_memberships` tables and migrations
- Org-scope middleware enforced on every existing route
- Existing instance-admin role re-homed as org-owner
- `companies.organization_id` populated in single-mode with the seeded org
- All existing tests still pass; new test suite for cross-org isolation

Exit: self-hosted Mercury still works exactly as today, but every entity is now provably org-scoped.

### Phase 2 — Hosted infrastructure wedge (3–4 weeks)

Pick the stack, deploy a thin slice end-to-end.

Deliverables:
- Hosted Postgres (Neon) provisioned + connected
- Object storage + KMS abstractions implemented
- Email service implemented (start with Resend)
- Sentry tagging per-org
- Single staging environment running with Phase 1 codebase

Exit: a developer can sign up at `staging.mercury.<domain>`, create an org, create a company, and the data lives in hosted Postgres.

### Phase 3 — Public sign-up + abuse mitigation (2–3 weeks)

Deliverables:
- Sign-up route + email verification
- Captcha (Cloudflare Turnstile or hCaptcha)
- Rate limiting (Upstash Redis)
- Sign-up email-domain block list for known abuse
- Account deletion / data-export endpoints (GDPR posture)
- Terms of service / privacy policy pages

Exit: staging is open to public sign-up under a "private beta" gate (invite codes initially).

### Phase 4 — Billing + quotas (2–3 weeks)

Deliverables:
- Stripe Checkout integration
- Customer portal redirect
- Webhook handler + subscription state machine
- Per-org usage metering (agent runs, tokens, storage)
- Hard quota enforcement on free plan
- Plan upgrade UI

Exit: a free user can hit their quota, see the upgrade modal, pay, and continue.

### Phase 5 — Agent execution implementation (Phase 0 dependent)

If Option A or C — ship BYOC `mercury-runner` daemon, cloud-login flow, and the cloud-side relay.
If Option B — ship sandbox lifecycle, image registry, per-tenant networking, egress controls.

Exit: end-to-end agent run works for a SaaS user from the chosen execution model.

### Phase 6 — Closed beta (2 weeks)

Deliverables:
- Waitlist + invite-code gate
- 20–50 hand-picked beta users onboarded
- Feedback loop: in-app NPS, weekly user interviews
- Bug-burn-down sprint

Exit: NPS ≥ 30, no P0 bugs open for 1 week.

### Phase 7 — General availability (1 week)

Deliverables:
- Status page live
- On-call rotation defined
- Public launch landing page
- Pricing page
- Marketing site copy

Exit: gate removed, sign-up open to the world.

## Open questions

1. **Pricing model.** Per-seat? Per-agent-run? Per-token? Hybrid? Resolve before Phase 4.
2. **BYO LLM keys vs we provide.** If we provide, our COGS is the LLM bill. If BYO, every user friction. Probably tier-dependent.
3. **What plan is free?** Generous-free (drives sign-up) vs trial-only (drives conversion). Probably 1 company + 1 agent free, with low monthly run cap.
4. **Hermes deeper integration** (already on roadmap per user memory) — does it land before or after this pivot? Needs sequencing.
5. **OpenClaw** — already an HTTP-bot pattern. Is the BYOC `mercury-runner` an extension of OpenClaw's model, or distinct? Resolve in Phase 0.
6. **Migration story for self-hosted users who want to move to SaaS.** Probably "export company → import to cloud" using the existing import/export plumbing (`doc/plans/2026-03-13-company-import-export-v2.md`).

## Risks

- **Compounding debt.** Starting before winces resolve = mess. Hard gate above.
- **Premature infra.** Picking Stack X in Phase 2 and outgrowing it by Phase 6. Mitigation: pick boring/portable defaults (Postgres, S3-compatible, Redis), avoid lock-in beyond Stripe.
- **Scope creep into v1.** SOC2, SSO, custom domains, marketplace — all real demand, all post-v1. Re-evaluate quarterly.
- **Self-hosted regression.** The "single codebase" principle is load-bearing. Every PR in Phases 1–5 must pass the self-hosted test suite.
- **Agent execution flip.** If Phase 0 picks Option B, Phase 5 alone is 2–3 months of infra + security work. Plan accordingly.

## Definition of done (v1 / GA)

- Anyone can sign up, verify email, create an org, create a company, hire an agent, and see meaningful output within 5 minutes of landing on the homepage.
- Free plan is generous enough to validate without payment.
- Paid plan converts via Stripe with no human intervention.
- Self-hosted Mercury is unchanged from a user's perspective.
- All four engineering invariants from `AGENTS.md` §5 still hold under multi-tenant load.
- 99.5% uptime over the first 30 days post-GA.
