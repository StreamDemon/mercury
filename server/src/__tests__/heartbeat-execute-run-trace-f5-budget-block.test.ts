// Wince #3 Track B Phase 1 — executeRun golden-trace characterization fixtures.
//
// F5 (this file) pins the "budget-blocked claim" cancellation cluster: a run that
// is successfully queued but, by the time the scheduler tries to CLAIM it,
// `budgets.getInvocationBlock` returns blocking. claimQueuedRun cancels the run
// via cancelRunInternal BEFORE executeRun's body ever runs. The trace exercises
// the cancellation cascade (setRunStatus → cancelled, setWakeupStatus →
// cancelled, appendRunEvent → "run cancelled", releaseIssueExecutionAndPromote,
// finalizeAgentStatus → cancelled outcome).
//
// Scenario chosen: SCENARIO 2 (budget-blocked in claimQueuedRun, not enqueueWakeup).
// Scenario 1 (budget already blocking at invoke time) would fail at line 6449
// with a thrown conflict and no heartbeat_runs row — trace would be empty since
// the queued liveEvent at line 6935 never fires. Scenario 2 is the richer fixture
// that matches the fixture name ("Budget-blocked CLAIM") and characterizes the
// cancellation cluster (cancelRunInternal cascade at heartbeat.ts:7166-7218).
//
// Why scenario 2 is reproducible without a race: enqueueWakeup awaits
// startNextQueuedRunForAgent inline (heartbeat.ts:6947) before returning, so we
// can't naturally insert a budget mutation between queue and claim. Instead we
// pre-fill the agent's concurrency slot with a fake `running` heartbeatRuns row
// (availableSlots = maxConcurrentRuns - runningCount = 1 - 1 = 0). The first
// invoke queues the run but claim is skipped. We then seed the company-paused
// budget block, free the slot, and call heartbeat.resumeQueuedRuns() — claim
// fires deterministically, sees the block, and cascades through cancelRunInternal.
//
// Spy stream coverage (re-verified 2026-05-17 after PR #62 + PR #63):
// cancelRunInternal (heartbeat.ts:7166-7218) previously called setRunStatus,
// setWakeupStatus, appendRunEvent, releaseIssueExecutionAndPromote,
// finalizeAgentStatus, and startNextQueuedRunForAgent via LOCAL CLOSURE refs,
// so F5's spy stream was nearly empty for the cancel cascade. PR #62 widened
// cancelRunInternal to route those calls through `internals.X`, and PR #63
// widened releaseIssueExecutionAndPromote's promote-tail (the cycle-2 queue
// event + startNextQueuedRunForAgent invocation) through `internals.X`. With
// both leaks plugged, F5's recorded trace now shows the cancel cluster as
// explicit `internal:*` events (setRunStatus, setWakeupStatus, appendRunEvent,
// releaseIssueExecutionAndPromote, finalizeAgentStatus) — this is the
// post-#62/#63 characterization of the cancellation path.
//
// Loop-breaker (matches F2/F3/F6 precedent): with PR #63 in place,
// releaseIssueExecutionAndPromote's promote-tail re-promotes the
// still-in_progress issue, which queues a second cycle that ALSO hits the
// budget block and cascades through cancelRunInternal again. Without a
// loop-breaker stub, this cycle 2 produces 22 events (vs 10 for cycle 1
// alone) AND its in-flight transactions race recorder.getDbSnapshot, returning
// run=null. The cycle-3 startNextQueuedRunForAgent also holds the
// agent_start_lock for the full 30s timeout. We stub
// __internalsForTests.startNextQueuedRunForAgent to a no-op AFTER recorder
// construction; the trade-off is documented at the stub site below.
//
// CAPTURE MODE: this file does NOT call toMatchTraceSequence. It prints the
// captured trace via console.log and asserts only loose invariants (trace not
// empty, run cancelled, wakeupRequest cancelled). The locked F5_CANONICAL_TRACE
// constant will be added in a follow-up PR after user sign-off on the printed
// sequence.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  budgetPolicies,
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

async function f5StubAdapterExecute(ctx: { onMeta?: (meta: Record<string, unknown>) => Promise<void> }) {
  // Symmetry with F1 stub. F5 never reaches adapter execute (the run is cancelled
  // at claim time before executeRun runs the adapter), so this body is dead code
  // in the canonical fixture path. Kept here so that if any executeRun path does
  // sneak through (test bug, refactor regression) the stub returns a clean
  // success rather than throwing — keeping the failure mode legible.
  if (typeof ctx?.onMeta === "function") {
    await ctx.onMeta({
      adapterType: "codex_local",
      command: "fake-stub-command",
      commandArgs: ["--fake"],
      env: { F5_FAKE_META: "1" },
      prompt: "fake prompt body",
      promptMetrics: { promptChars: 17 },
    });
  }
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "F5 stub adapter (should not be reached).",
    provider: "test",
    model: "test-model",
    sessionId: "f5-budget-block-session",
  };
}

const mockAdapterExecute = vi.hoisted(() => vi.fn(f5StubAdapterExecute));

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

describeEmbeddedPostgres("executeRun characterization fixtures — F5 budget-blocked claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mercury-execute-run-trace-f5-");
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
    mockAdapterExecute.mockImplementation(f5StubAdapterExecute);
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
    // budgetPolicies.companyId references companies.id; delete budget rows
    // BEFORE the company row. (F1's cleanup omits this because it doesn't seed
    // a budget policy.)
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("F5 — budget-blocked claim cancels queued run via cancelRunInternal cascade [CAPTURE]", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const taskKey = "f5-budget-block-task-key";

    await db.insert(companies).values({
      id: companyId,
      name: "Mercury F5",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // maxConcurrentRuns=1 so a single fake "running" row fills the slot and
    // blocks claim during the initial invoke. This is the deterministic substitute
    // for the impossible "race a budget mutation between queue and claim" path.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TraceAgentF5",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "F5 budget-blocked claim",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    // Fake "running" row consumes the concurrency slot. No wakeupRequestId
    // (claimQueuedRun won't even look at this row — it just contributes to the
    // runningCount via countRunningRunsForAgent).
    const fakeRunningRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: fakeRunningRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { fakeSlotFiller: true },
    });

    const heartbeat = heartbeatService(db);
    const recorder = createTraceRecorder({ db, heartbeat, companyId });

    // Loop-breaker (matches F2/F3/F6 precedent, finalized after PR #62 + #63):
    // stub `startNextQueuedRunForAgent` to a no-op AFTER recorder construction
    // but BEFORE heartbeat.resumeQueuedRuns. Without this, cycle 1's
    // releaseIssueExecutionAndPromote re-promotes the still-in_progress issue,
    // which queues + cancels a second cycle (events 7-14 in the unstubbed
    // trace) and triggers a third startNextQueuedRunForAgent that holds the
    // agent_start_lock for the full 30s timeout. The downstream lock
    // contention also causes recorder.getDbSnapshot to race the in-flight
    // cycle-2 transactions and return run=null. With the stub, the cancel
    // cascade ends after the first cycle and the test runs cleanly in <1s.
    // Trade-off: internal:startNextQueuedRunForAgent and the cycle-2 re-promote
    // do not appear in the trace — that side effect is suppressed by design.
    heartbeat.__internalsForTests.startNextQueuedRunForAgent = async () => undefined;

    try {
      // 1. Invoke. Budget is OK here (no policy yet, company not paused), so
      //    enqueueWakeup proceeds. startNextQueuedRunForAgent computes
      //    availableSlots = 1 - 1 = 0 and returns without claiming. Run stays queued.
      const queued = await heartbeat.invoke(
        agentId,
        "on_demand",
        { issueId, taskKey },
        "manual",
      );
      expect(queued).not.toBeNull();
      expect(queued!.status).toBe("queued");

      // Sanity: confirm the queued run did NOT get claimed during invoke.
      const afterInvoke = await heartbeat.getRun(queued!.id);
      expect(afterInvoke?.status).toBe("queued");

      // 2. Seed the budget block. Cheapest scenario-2 trigger that doesn't
      //    require seeding cost_events: company-scoped pause with
      //    pauseReason="budget" makes getInvocationBlock return the "Company
      //    is paused because its budget hard-stop was reached." block at
      //    budgets.ts:743-753 — no budget_policies row, no cost_events row
      //    needed for the block itself. (We still seed an inactive policy row
      //    for realism and to exercise the cleanup-ordering FK constraint.)
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: false,
        isActive: false,
      });
      await db
        .update(companies)
        .set({ status: "paused", pauseReason: "budget", pausedAt: new Date() })
        .where(eq(companies.id, companyId));

      // 3. Free the slot so the next startNextQueuedRunForAgent sees
      //    availableSlots > 0 and proceeds to claimQueuedRun. We hard-delete the
      //    fake row rather than transitioning it through setRunStatus to avoid
      //    polluting the trace with an unrelated status liveEvent.
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, fakeRunningRunId));

      // 4. Trigger the scheduler. resumeQueuedRuns walks every distinct
      //    agentId with a queued run and calls startNextQueuedRunForAgent.
      //    For our queued run, claimQueuedRun → getInvocationBlock returns the
      //    company-paused block → cancelRunInternal cascade.
      await heartbeat.resumeQueuedRuns();

      // 5. Wait for the cascade tail (finalizeAgentStatus, startNextQueuedRunForAgent)
      //    to settle.
      const finished = await recorder.waitForRunSettled(queued!.id, 10_000);
      expect(finished?.status).toBe("cancelled");
      await recorder.waitForTraceQuiescent(300, 5_000);

      const trace = recorder.getOrderedTrace();
      const snapshot = await recorder.getDbSnapshot(queued!.id);

      // -------- CAPTURE MODE diagnostics --------
      // eslint-disable-next-line no-console
      console.log("\n=== F5 captured trace (budget-blocked claim) ===");
      // eslint-disable-next-line no-console
      console.log(`event count: ${trace.length}`);
      trace.forEach((ev, i) => {
        if (ev.kind === "internal") {
          // eslint-disable-next-line no-console
          console.log(`  [${i}] internal:${String(ev.name)}`);
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `  [${i}] liveEvent:${ev.type} ${JSON.stringify(ev.payload).slice(0, 200)}`,
          );
        }
      });
      // eslint-disable-next-line no-console
      console.log("=== F5 DB snapshot ===");
      // eslint-disable-next-line no-console
      console.log(`run.status         = ${snapshot.run?.status}`);
      // eslint-disable-next-line no-console
      console.log(`run.errorCode      = ${snapshot.run?.errorCode}`);
      // eslint-disable-next-line no-console
      console.log(`run.error          = ${snapshot.run?.error}`);
      // eslint-disable-next-line no-console
      console.log(`wakeupRequest.status = ${snapshot.wakeupRequest?.status}`);
      // eslint-disable-next-line no-console
      console.log(`runEvents.length     = ${snapshot.runEvents.length}`);
      snapshot.runEvents.forEach((ev, i) => {
        // eslint-disable-next-line no-console
        console.log(`  runEvent[${i}] seq=${ev.seq} eventType=${ev.eventType} message=${ev.message}`);
      });
      // eslint-disable-next-line no-console
      console.log(`issueComments.length = ${snapshot.issueComments.length}`);
      // eslint-disable-next-line no-console
      console.log(`costEvents.length    = ${snapshot.costEvents.length}`);

      // -------- Loose invariants (no toMatchTraceSequence in CAPTURE mode) --------
      expect(trace.length).toBeGreaterThan(0);
      expect(snapshot.run?.status).toBe("cancelled");
      expect(snapshot.run?.errorCode).toBe("cancelled");
      // The block reason comes from budgets.getInvocationBlock's company-paused
      // branch. We assert containment rather than exact equality to keep the
      // assertion resilient to copy edits in the source string.
      expect(snapshot.run?.error ?? "").toContain("budget");
      expect(snapshot.wakeupRequest?.status).toBe("cancelled");
      // cancelRunInternal calls appendRunEvent at heartbeat.ts:7205 with seq=1
      // ("run cancelled"). releaseIssueExecutionAndPromote may also append
      // events if it triggers a recovery promotion, so we assert at-least-1
      // rather than exactly-1 and verify the cancel event is present.
      expect(snapshot.runEvents.length).toBeGreaterThanOrEqual(1);
      const cancelEvent = snapshot.runEvents.find(
        (ev) => ev.seq === 1 && ev.eventType === "lifecycle",
      );
      expect(cancelEvent).toBeDefined();
      expect(cancelEvent?.message ?? "").toContain("cancelled");
      // No issue comments and no cost events on a cancelled-at-claim path.
      expect(snapshot.issueComments).toHaveLength(0);
      expect(snapshot.costEvents).toHaveLength(0);
      // Stub adapter must never have been invoked — run was cancelled BEFORE
      // executeRun reached the adapter.invoke step.
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    } finally {
      recorder.dispose();
    }
  }, 30_000);
});
