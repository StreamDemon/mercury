// Wince #3 Track B Phase 1 — executeRun golden-trace characterization fixtures.
//
// F3 (this file) pins the outer-catch path at heartbeat.ts:5880-5921. Setup
// code BEFORE adapter.execute (workspace resolution, runtime services, env
// lease, etc.) throws → the inner catch does NOT fire → the outer catch fires.
// Critical property: every write in the outer catch is wrapped in
// `.catch(() => undefined)`, so even if individual recovery writes fail the
// overall sequence still progresses.
//
// Expected outer-catch sequence (per heartbeat.ts:5880-5921):
//   setRunStatus("failed", errorCode="adapter_failed")
//   setWakeupStatus("failed")
//   appendRunEvent(eventType:"error", seq:1)
//   classifyAndPersistRunLiveness
//   refreshContinuationSummaryForRun
//   finalizeIssueCommentPolicy
//   releaseIssueExecutionAndPromote
//   finalizeAgentStatus("failed")
//   --- finally ---
//   releaseRuntimeServicesForRun
//   startNextQueuedRunForAgent
//
// Induction approach: APPROACH (A) — re-swap an internal AFTER the recorder
// installs its wrappers. We replace `internals.realizeExecutionWorkspace`
// (called at heartbeat.ts:4996, before adapter.execute) with a thrower.
//
// Trade-off 1 (acknowledged): the thrower bypasses the recorder's wrapper, so
// `internal:realizeExecutionWorkspace` does NOT appear in the trace. The
// trace characterizes the AFTERMATH (outer-catch sequence) without the
// trigger itself. That is acceptable because the safety-critical invariant
// this fixture pins is the ordering of the outer-catch recovery writes.
//
// Trade-off 2 (loop-breaker): with an issue-id seed, the outer-catch arm
// `releaseIssueExecutionAndPromote` auto-re-promotes the failed issue, then
// the `finally`'s `startNextQueuedRunForAgent` claims the new queued run,
// the thrower is still installed, and the cycle repeats indefinitely. To
// keep the capture clean (one cycle for operator sign-off) we also stub
// `internals.startNextQueuedRunForAgent` to a no-op AFTER the recorder
// installs. Consequence: that internal does not show in the trace either.
// The fixture still captures the full outer-catch sequence through the
// finally's `releaseRuntimeServicesForRun`. A future F-variant can pin the
// `startNextQueuedRunForAgent` behavior in a happy-path or queue-drain
// fixture where the loop concern does not apply.
//
// CAPTURE MODE: this fixture intentionally does NOT call
// `toMatchTraceSequence(...)`. Phase 1 lands captures first, then the
// operator reviews and signs off on the ordered sequence in the PR body,
// then a follow-up commit converts the capture to a locked canonical trace.

import { randomUUID } from "node:crypto";
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

// Defensive stub: if the induction misfires and adapter.execute is reached
// after all, return a benign success so we don't muddy the failure mode under
// test. The induction throws BEFORE adapter.execute, so this should not run.
async function f3StubAdapterExecute(ctx: { onMeta?: (meta: Record<string, unknown>) => Promise<void> }) {
  if (typeof ctx?.onMeta === "function") {
    await ctx.onMeta({
      adapterType: "codex_local",
      command: "fake-stub-command",
      commandArgs: ["--fake"],
      env: { F3_FAKE_META: "1" },
      prompt: "fake prompt body",
      promptMetrics: { promptChars: 17 },
    });
  }
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "F3 defensive stub — should not be reached.",
    provider: "test",
    model: "test-model",
    sessionId: "f3-canonical-session",
  };
}

const mockAdapterExecute = vi.hoisted(() => vi.fn(f3StubAdapterExecute));

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
import { createTraceRecorder } from "../services/__tests__/helpers/trace-recorder.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping executeRun trace fixtures on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("executeRun characterization fixtures — F3 setup error (wince #3 Track B Phase 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mercury-execute-run-trace-f3-");
    db = createDb(tempDb.connectionString);
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
    mockAdapterExecute.mockImplementation(f3StubAdapterExecute);
    runningProcesses.clear();
    await waitForHeartbeatIdle();
    // small settle for async cost-event / plugin-domain-event listeners.
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
    await tempDb?.cleanup();
  });

  it("F3 — outer-catch path captures the setup-error recovery sequence [CAPTURE]", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const taskKey = "f3-canonical-task-key";

    await db.insert(companies).values({
      id: companyId,
      name: "Mercury",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TraceAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Mirror F1 seed: include an issueId so the outer catch exercises the
    // issue-side recovery arms (refreshContinuationSummaryForRun,
    // finalizeIssueCommentPolicy, releaseIssueExecutionAndPromote with an
    // actual issue context).
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "F3 outer-catch setup-failure path",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const recorder = createTraceRecorder({ db, heartbeat, companyId });

    try {
      // Approach (A) induction: re-swap realizeExecutionWorkspace AFTER the
      // recorder installs its wrapper. The heartbeat code reads the live
      // reference from `internals` at the call site (heartbeat.ts:4996), so
      // this thrower fires instead of the recorder wrapper. The thrown
      // error escapes the inner try/catch (which only wraps adapter.execute)
      // and lands in the outer catch at heartbeat.ts:5880.
      const internals = heartbeat.__internalsForTests;
      if (!internals) throw new Error("internals not exposed — PR #53 missing");
      internals.realizeExecutionWorkspace = (async () => {
        throw new Error("F3 simulated setup failure — realizeExecutionWorkspace threw");
      }) as typeof internals.realizeExecutionWorkspace;
      // Loop-breaker (see header trade-off 2). Stub the finally's tail call
      // so the failed-run cycle does not re-trigger via re-promotion +
      // queue-claim. Returning undefined matches the real return shape
      // (the real function is `async () => void`).
      internals.startNextQueuedRunForAgent = (async () => {
        return undefined;
      }) as typeof internals.startNextQueuedRunForAgent;

      const queued = await heartbeat.invoke(
        agentId,
        "on_demand",
        { issueId, taskKey },
        "manual",
      );
      expect(queued).not.toBeNull();

      const finished = await recorder.waitForRunSettled(queued!.id, 10_000);
      expect(finished?.status).toBe("failed");
      // The outer-catch body continues past the status flip for ~7 internal
      // calls and then the unconditional `finally` block. Wait for the trace
      // tail to stabilize before snapshotting.
      await recorder.waitForTraceQuiescent(300, 5_000);

      const trace = recorder.getOrderedTrace();
      const snapshot = await recorder.getDbSnapshot(queued!.id);

      // CAPTURE MODE assertions — no toMatchTraceSequence lock-in yet.
      expect(trace.length).toBeGreaterThan(0);
      expect(snapshot.run?.status).toBe("failed");
      expect(snapshot.run?.errorCode).toBe("adapter_failed");

      // Print the ordered sequence + DB snapshot stats for operator review in
      // the PR body. Mirror F1's pre-lock-in capture pattern.
      // eslint-disable-next-line no-console
      console.log("\n===== F3 CAPTURED TRACE (setup-error outer catch) =====");
      // eslint-disable-next-line no-console
      console.log(`Total events: ${trace.length}`);
      for (let i = 0; i < trace.length; i++) {
        const ev = trace[i];
        if (ev.kind === "internal") {
          // eslint-disable-next-line no-console
          console.log(`  [${i}] internal:${String(ev.name)}`);
        } else {
          // eslint-disable-next-line no-console
          console.log(`  [${i}] liveEvent:${ev.type}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log("\n----- DB snapshot -----");
      // eslint-disable-next-line no-console
      console.log(`  run.status        = ${snapshot.run?.status}`);
      // eslint-disable-next-line no-console
      console.log(`  run.errorCode     = ${snapshot.run?.errorCode}`);
      // eslint-disable-next-line no-console
      console.log(`  run.error         = ${snapshot.run?.error}`);
      // eslint-disable-next-line no-console
      console.log(`  wakeup.status     = ${snapshot.wakeupRequest?.status}`);
      // eslint-disable-next-line no-console
      console.log(`  runEvents.length  = ${snapshot.runEvents.length}`);
      // eslint-disable-next-line no-console
      console.log(`  costEvents.length = ${snapshot.costEvents.length}`);
      // eslint-disable-next-line no-console
      console.log(`  issueComments.length = ${snapshot.issueComments.length}`);
      // eslint-disable-next-line no-console
      console.log("===== END F3 CAPTURED TRACE =====\n");
    } finally {
      recorder.dispose();
    }
  }, 30_000);
});
