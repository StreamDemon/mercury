// Wince #3 Track B Phase 1 — executeRun golden-trace characterization fixture F4.
//
// F4 pins the agent-not-found early-failure path inside executeRun
// (heartbeat.ts:4720-4734). When `getAgent(run.agentId)` returns null after
// the run has already been claimed (status flipped to "running"), executeRun
// fires:
//   1. setRunStatus(runId, "failed", { errorCode: "agent_not_found" })
//   2. setWakeupStatus(wakeupRequestId, "failed")
//   3. releaseIssueExecutionAndPromote(failedRun) — only if failedRun is fetchable
//   4. return — falls through to the outer finally at heartbeat.ts:5922-5943
//
// Spec discrepancy noted (captured for PR review): the F4 brief asserted that
// this early-return BYPASSES the outer finally. Reading heartbeat.ts shows the
// try block opens at line 4719 BEFORE the agent check at 4721, so the return
// at 4733 DOES fall into the finally. The captured trace below therefore
// includes the finally tail (releaseRuntimeServicesForRun +
// startNextQueuedRunForAgent). This is the truthful trace; the spec was
// wrong and is corrected here.
//
// Note on the finally tail: unlike F2/F3/F5/F6/F7, F4 does NOT need a
// loop-breaker stub for startNextQueuedRunForAgent. The agent-not-found
// early-exit never reaches releaseIssueExecutionAndPromote's promote-tail
// (there's no issue context to promote on this run), so the finally's call
// to startNextQueuedRunForAgent runs once and bottoms out — it does not
// re-enter executeRun. The canonical trace therefore INCLUDES that single
// startNextQueuedRunForAgent at the tail.
//
// Induction (deterministic, via postgres trigger):
// The two gates upstream of executeRun's `getAgent` (`startNextQueuedRunForAgent`
// at heartbeat.ts:4608-4609 and `claimQueuedRun` at heartbeat.ts:3765-3768)
// both check `getAgent` and bail/cancel if the agent is missing. Seeding a
// run with a non-existent agentId never reaches the executeRun branch we want.
//
// Two earlier approaches failed:
//   1. Wall-clock race (poll for status="running", then delete the agent before
//      executeRun's getAgent resolves) lost 8/8 attempts — the poll window is
//      too coarse to hit the microtask gap reliably.
//   2. Monkey-patching `internals.setWakeupStatus` didn't fire — claimQueuedRun
//      calls the raw local `setWakeupStatus` directly, not the indirected
//      `internals.setWakeupStatus` (which exists only for executeRun's sake).
//
// Deterministic approach (this one): install a postgres trigger that deletes
// the agent row atomically as part of the same transaction that flips a
// heartbeat_run from "queued" to "running" (the UPDATE inside claimQueuedRun
// at heartbeat.ts:3839-3848). When claimQueuedRun's UPDATE commits, the agent
// row is provably gone. claimQueuedRun's own follow-up `getAgent` call (used
// for the executionAgentNameKey stamp at heartbeat.ts:3874) returns null but
// the surrounding code tolerates that. executeRun then receives the claimed
// row, calls `getAgent(run.agentId)` at heartbeat.ts:4720, gets null, and
// takes the agent-not-found path.
//
// CANONICAL TRACE LOCKED per operator sign-off 2026-05-17 (batch approval of
// all Wave 2 fixtures F2-F7 as-captured).

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@mercuryai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

// Stub adapter is registered for symmetry with F1, but the agent-not-found
// path returns BEFORE adapter.execute is reached — so this stub will not be
// invoked when the race resolves to the intended path.
async function f4StubAdapterExecute() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "F4 stub adapter — should not be reached.",
    provider: "test",
    model: "test-model",
  };
}

const mockAdapterExecute = vi.hoisted(() => vi.fn(f4StubAdapterExecute));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import {
  createTraceRecorder,
  type TraceMatcher,
} from "../services/__tests__/helpers/trace-recorder.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping executeRun trace fixtures on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// F4 canonical sequence — 7 events. Operator-approved 2026-05-17 (Wave 2 batch).
// Argument matchers use the predicate form to skip noisy args (runIds, full
// run rows, timestamps) and assert only stable invariants (status enums,
// errorCode, wakeup status).
const F4_CANONICAL_TRACE: readonly TraceMatcher[] = [
  // [00] claimQueuedRun flips queued -> running and emits the status live event.
  { kind: "liveEvent", type: "heartbeat.run.status", payloadMatch: { status: "running" } },
  // [01] executeRun's getAgent returns null -> setRunStatus(failed, agent_not_found).
  {
    kind: "internal",
    name: "setRunStatus",
    argsMatch: (args) =>
      args[1] === "failed" &&
      (args[2] as { errorCode?: string })?.errorCode === "agent_not_found",
  },
  // [02] status live event for the failure flip.
  { kind: "liveEvent", type: "heartbeat.run.status", payloadMatch: { status: "failed" } },
  // [03] setWakeupStatus(failed) for the corresponding wakeup row.
  {
    kind: "internal",
    name: "setWakeupStatus",
    argsMatch: (args) => args[1] === "failed",
  },
  // [04] releaseIssueExecutionAndPromote — runs even with no issue context;
  // there's nothing to promote so this bottoms out without re-entering.
  { kind: "internal", name: "releaseIssueExecutionAndPromote" },
  // [05] outer finally: releaseRuntimeServicesForRun.
  { kind: "internal", name: "releaseRuntimeServicesForRun" },
  // [06] outer finally: startNextQueuedRunForAgent. No queued successor exists,
  // so this single call bottoms out — no loop-breaker stub required for F4.
  { kind: "internal", name: "startNextQueuedRunForAgent" },
];

describeEmbeddedPostgres(
  "executeRun characterization fixtures (wince #3 Track B Phase 1) — F4 agent-not-found",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("mercury-execute-run-trace-f4-");
      db = createDb(tempDb.connectionString);

      // To induce the agent-not-found path, the test must delete the agent row
      // AFTER claimQueuedRun has already linked the heartbeat_run to it but
      // BEFORE executeRun's `getAgent` resolves. The default FK constraint on
      // heartbeat_runs.agent_id (and other agents.id refs) blocks that delete.
      // This test fixture's temp DB is isolated, so we drop the FK constraints
      // that would block the cross-claim delete. Production schemas are
      // unaffected — this is an integration-test-only DDL change scoped to
      // this temp database.
      const fksToDrop = [
        ["heartbeat_runs", "heartbeat_runs_agent_id_agents_id_fk"],
        ["heartbeat_run_events", "heartbeat_run_events_agent_id_agents_id_fk"],
        ["cost_events", "cost_events_agent_id_agents_id_fk"],
        ["agent_wakeup_requests", "agent_wakeup_requests_agent_id_agents_id_fk"],
        ["agent_runtime_state", "agent_runtime_state_agent_id_agents_id_fk"],
        ["agent_task_sessions", "agent_task_sessions_agent_id_agents_id_fk"],
        ["activity_log", "activity_log_agent_id_agents_id_fk"],
      ];
      for (const [table, constraint] of fksToDrop) {
        await db
          .execute(sql.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`))
          .catch(() => undefined);
      }
    }, 20_000);

    async function waitForHeartbeatIdle(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
        if (!runs.some((r) => r.status === "queued" || r.status === "running")) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    afterEach(async () => {
      vi.clearAllMocks();
      mockAdapterExecute.mockImplementation(f4StubAdapterExecute);
      runningProcesses.clear();
      await waitForHeartbeatIdle();
      // Small settle for async cost-event / plugin-domain-event listeners.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await db.delete(activityLog);
      await db.delete(costEvents);
      await db.delete(issueComments);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(issues);
      // agentTaskSessions.last_run_id references heartbeat_runs.id; delete the
      // session rows BEFORE the run rows.
      await db.delete(agentTaskSessions);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      await db.delete(environmentLeases);
      await db.delete(environments);
      await db.delete(companySkills);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      // Best-effort cleanup. Windows hosts occasionally leave the embedded
      // postgres data directory file-locked from a subprocess that hasn't
      // fully released its handles. Swallow EPERM so the suite reports the
      // test result, not the cleanup race.
      try {
        await tempDb?.cleanup();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[F4] tempDb cleanup failed (likely Windows host race): ${(err as Error).message}`);
      }
    });

    it(
      "F4 — agent deleted between claim and getAgent matches the canonical 7-event trace",
      async () => {
        const heartbeat = heartbeatService(db);

        const companyId = randomUUID();
        const agentId = randomUUID();
        const runId = randomUUID();
        const wakeupRequestId = randomUUID();
        const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
        const now = new Date();

        await db.insert(companies).values({
          id: companyId,
          name: "Mercury",
          issuePrefix,
          requireBoardApprovalForNewAgents: false,
        });

        await db.insert(agents).values({
          id: agentId,
          companyId,
          name: "F4DoomedAgent",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        });

        // Seed the queued wakeup + run directly (no heartbeat.invoke, which
        // would generate its own wakeup row). Status "queued" so
        // resumeQueuedRuns() picks it up via startNextQueuedRunForAgent ->
        // claimQueuedRun -> executeRun.
        await db.insert(agentWakeupRequests).values({
          id: wakeupRequestId,
          companyId,
          agentId,
          source: "on_demand",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {},
          status: "pending",
          runId,
          claimedAt: null,
        });

        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          invocationSource: "on_demand",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId,
          contextSnapshot: {},
          startedAt: now,
          updatedAt: now,
        });

        // Deterministic induction: install a postgres trigger so the UPDATE
        // inside claimQueuedRun (heartbeat.ts:3839-3848 — flips heartbeat_run
        // from "queued" to "running") atomically deletes our doomed agent row
        // in the same transaction. By the time claimQueuedRun returns, the
        // agent is provably gone and executeRun's `getAgent(run.agentId)` at
        // heartbeat.ts:4720 returns null.
        const triggerName = `f4_doom_agent_on_claim_${agentId.replace(/-/g, "")}`;
        const fnName = `f4_doom_agent_fn_${agentId.replace(/-/g, "")}`;
        await db.execute(
          sql.raw(`
            CREATE OR REPLACE FUNCTION "${fnName}"() RETURNS trigger AS $$
            BEGIN
              IF NEW.id = '${runId}' AND NEW.status = 'running' AND OLD.status = 'queued' THEN
                DELETE FROM agents WHERE id = '${agentId}';
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
          `),
        );
        await db.execute(
          sql.raw(`
            CREATE TRIGGER "${triggerName}"
            AFTER UPDATE ON heartbeat_runs
            FOR EACH ROW
            EXECUTE FUNCTION "${fnName}"();
          `),
        );

        const recorder = createTraceRecorder({ db, heartbeat, companyId });

        try {
          // Drive the scheduler. resumeQueuedRuns -> startNextQueuedRunForAgent
          // -> claimQueuedRun's UPDATE fires the trigger (deletes agent atomic
          // with the status flip) -> claimQueuedRun returns -> void executeRun
          // -> getAgent returns null -> agent-not-found path.
          await heartbeat.resumeQueuedRuns();

          // Wait for executeRun's async chain to finish.
          const settled = await recorder.waitForRunSettled(runId, 10_000);
          await recorder.waitForTraceQuiescent(300, 5_000);

          const trace = recorder.getOrderedTrace();
          const snapshot = await recorder.getDbSnapshot(runId);

          // Confirm the induction worked: the agent row is gone.
          const [agentRow] = await db
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1);
          expect(agentRow).toBeUndefined();
          expect(settled?.status ?? snapshot.run?.status).toBe("failed");

          // The locked canonical contract. Any change to this sequence is a
          // deliberate ordering decision that must be reviewed (and re-signed-off
          // by the operator) before merging — that is the whole point.
          expect(trace).toMatchTraceSequence(F4_CANONICAL_TRACE);

          // DB cross-checks — these confirm the spy/live-event recording stayed
          // consistent with what actually persisted.
          expect(snapshot.run?.status).toBe("failed");
          expect(snapshot.run?.errorCode).toBe("agent_not_found");
          expect(snapshot.wakeupRequest?.status).toBe("failed");
          // Agent-not-found exits before any appendRunEvent calls fire, so no
          // run events should be persisted.
          expect(snapshot.runEvents).toHaveLength(0);
          // No issue context on this run; no issue comments expected.
          expect(snapshot.issueComments).toHaveLength(0);
          // Adapter.execute never reached; no cost events expected.
          expect(snapshot.costEvents).toHaveLength(0);
        } finally {
          recorder.dispose();
          // Drop the test-only trigger so afterEach cleanup is unimpeded.
          await db
            .execute(sql.raw(`DROP TRIGGER IF EXISTS "${triggerName}" ON heartbeat_runs`))
            .catch(() => undefined);
          await db
            .execute(sql.raw(`DROP FUNCTION IF EXISTS "${fnName}"()`))
            .catch(() => undefined);
        }
      },
      90_000,
    );
  },
);
