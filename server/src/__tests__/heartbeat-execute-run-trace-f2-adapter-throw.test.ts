// Wince #3 Track B Phase 1 — executeRun golden-trace characterization fixtures.
//
// F2 (this file) characterizes the INNER-CATCH path at heartbeat.ts:5801-5878,
// the recovery handoff that fires when the adapter itself throws DURING execute
// (i.e. AFTER ensureRuntimeState/resolveWorkspaceForRun succeed but BEFORE the
// success-block completes). This is the highest-stakes failure path in
// executeRun: a future re-ordering that skips releaseIssueExecutionAndPromote,
// updateRuntimeState(errorMessage), upsertTaskSession(lastError), or
// finalizeAgentStatus("failed") would silently strand work without recovery.
//
// Induction: getServerAdapter().execute is mocked to invoke onMeta (so the
// appendRunEvent(adapter.invoke) call at heartbeat.ts:5491 is exercised
// symmetrically with F1) then throw new Error("simulated adapter failure").
//
// Locked decisions inherited from F1 (PR #55):
//   1B — F2 includes an issueId to pin the issue-side failure recovery
//        (refreshContinuationSummaryForRun / finalizeIssueCommentPolicy /
//        releaseIssueExecutionAndPromote with issue context).
//   2B — F2 includes a taskKey in contextSnapshot so the failure-block
//        upsertTaskSession branch at heartbeat.ts:5864 takes the lastError
//        recording arm.
//   4B — Stub invokes onMeta with fake meta BEFORE throwing (symmetric with
//        F1's appendRunEvent(adapter.invoke) capture).
//   5  — activity.logged / agent.status / heartbeat.run.log live events stay
//        in the captured trace as observable contract.
//
// Deferred (intentional Phase 1 scope cuts — not bugs):
//   3A — costUsd is NOT relevant on the throw path (no AdapterRunResult).
//   6  — workspace-runtime calls remain opaque to the spy stream (same
//        rationale as F1).
//
// LOCKED 2026-05-17 per operator batch sign-off on Wave 2 fixtures. The
// canonical sequence below is now the contract; any future drift requires
// fresh operator sign-off before re-locking.
//
// LOOP-BREAKER (Wave 2 operator decision 1a, finalized after PR #62 + #63):
// the F2 fixture stubs heartbeat.__internalsForTests.startNextQueuedRunForAgent
// to a no-op AFTER recorder construction but BEFORE heartbeat.invoke. PRs #62
// (widen cancelRunInternal through __internalsForTests) and #63 (route the
// releaseIssueExecutionAndPromote promote-tail through __internalsForTests)
// plugged the two remaining closure leaks at heartbeat.ts where the
// pre-stub-bound function reference was being called directly — so the
// loop-breaker now ACTUALLY breaks the loop. Without those PRs, the stub was
// shadowed and re-promotions still fired, producing 4 cascading failure
// cycles (~109 events). With them, the trace is a single clean cycle (26
// events) ending at internal:releaseRuntimeServicesForRun from the finally
// block. Trade-off: the trace ENDS at internal:releaseRuntimeServicesForRun
// rather than continuing into startNextQueuedRunForAgent — that side effect
// is suppressed by design and is documented in the canonical sequence.

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

async function f2StubAdapterExecute(ctx: { onMeta?: (meta: Record<string, unknown>) => Promise<void> }) {
  if (typeof ctx?.onMeta === "function") {
    // Decision 4B: emit meta BEFORE throwing so the inner-catch trace shares
    // F1's adapter.invoke leading edge. Without this, F2 and F1 would diverge
    // at the meta point for reasons unrelated to the failure path itself.
    await ctx.onMeta({
      adapterType: "codex_local",
      command: "fake-stub-command",
      commandArgs: ["--fake"],
      env: { F2_FAKE_META: "1" },
      prompt: "fake prompt body",
      promptMetrics: { promptChars: 17 },
    });
  }
  throw new Error("simulated adapter failure");
}

const mockAdapterExecute = vi.hoisted(() => vi.fn(f2StubAdapterExecute));

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

// F2 canonical sequence — 26 events. Operator-approved 2026-05-17 (Wave 2 batch).
// Argument matchers use the predicate form because the matcher's array form
// has no positional wildcard; predicates skip noisy args (runIds, agent rows,
// timestamps) and assert only stable invariants (status enums, seq numbers,
// event kinds, errorCode strings).
//
// Notable contract points vs F1 (success path):
//   - setRunStatus("failed", { errorCode: "adapter_failed" })
//   - setWakeupStatus(..., "failed")
//   - finalizeAgentStatus(..., "failed")
//   - 3 appendRunEvent calls: seq=1 lifecycle "run started", seq=2 "adapter.invoke",
//     seq=3 lifecycle "run failed" (NOT a separate error event; the failure-block
//     writes a single lifecycle entry on the way down).
//   - At index 20: heartbeat.run.queued is emitted by the promote-tail invoked
//     from releaseIssueExecutionAndPromote — the loop-breaker swallows the claim
//     but the enqueue event still surfaces. This is by design.
//   - The trace ENDS at internal:releaseRuntimeServicesForRun (the finally block);
//     the post-finalize startNextQueuedRunForAgent side effect is suppressed by
//     the loop-breaker (see header note for full rationale).
const F2_CANONICAL_TRACE: readonly TraceMatcher[] = [
  { kind: "liveEvent", type: "heartbeat.run.queued" },
  { kind: "liveEvent", type: "heartbeat.run.status" },
  { kind: "internal", name: "realizeExecutionWorkspace" },
  { kind: "liveEvent", type: "activity.logged" },
  { kind: "liveEvent", type: "agent.status" },
  {
    kind: "internal",
    name: "appendRunEvent",
    argsMatch: (args) =>
      args[1] === 1 && (args[2] as { eventType?: string })?.eventType === "lifecycle",
  },
  { kind: "liveEvent", type: "heartbeat.run.event", payloadMatch: { seq: 1, eventType: "lifecycle" } },
  { kind: "liveEvent", type: "heartbeat.run.log" },
  { kind: "internal", name: "ensureRuntimeServicesForRun" },
  {
    kind: "internal",
    name: "appendRunEvent",
    argsMatch: (args) =>
      args[1] === 2 && (args[2] as { eventType?: string })?.eventType === "adapter.invoke",
  },
  { kind: "liveEvent", type: "heartbeat.run.event", payloadMatch: { seq: 2, eventType: "adapter.invoke" } },
  {
    kind: "internal",
    name: "setRunStatus",
    argsMatch: (args) =>
      args[1] === "failed" && (args[2] as { errorCode?: string })?.errorCode === "adapter_failed",
  },
  { kind: "liveEvent", type: "heartbeat.run.status", payloadMatch: { status: "failed" } },
  {
    kind: "internal",
    name: "setWakeupStatus",
    argsMatch: (args) => args[1] === "failed",
  },
  {
    kind: "internal",
    name: "appendRunEvent",
    argsMatch: (args) =>
      args[1] === 3 && (args[2] as { eventType?: string })?.eventType === "error",
  },
  { kind: "liveEvent", type: "heartbeat.run.event", payloadMatch: { seq: 3, eventType: "error" } },
  { kind: "internal", name: "classifyAndPersistRunLiveness" },
  { kind: "internal", name: "refreshContinuationSummaryForRun" },
  { kind: "internal", name: "finalizeIssueCommentPolicy" },
  { kind: "internal", name: "releaseIssueExecutionAndPromote" },
  // promote-tail enqueue surfaces, but the loop-breaker swallows the claim.
  { kind: "liveEvent", type: "heartbeat.run.queued" },
  { kind: "internal", name: "updateRuntimeState" },
  {
    kind: "internal",
    name: "finalizeAgentStatus",
    argsMatch: (args) => args[1] === "failed",
  },
  { kind: "liveEvent", type: "agent.status" },
  { kind: "liveEvent", type: "activity.logged" },
  { kind: "internal", name: "releaseRuntimeServicesForRun" },
];

describeEmbeddedPostgres("executeRun characterization fixtures (wince #3 Track B Phase 1) — F2", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mercury-execute-run-trace-f2-");
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
    mockAdapterExecute.mockImplementation(f2StubAdapterExecute);
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

  it("F2 — adapter throws (inner catch) matches the canonical 26-event trace", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const taskKey = "f2-canonical-task-key";

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

    // Decision 1B: include an issueId to pin the issue-side failure path
    // (refreshContinuationSummaryForRun / finalizeIssueCommentPolicy /
    // releaseIssueExecutionAndPromote with issue context).
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "F2 adapter-throw recovery handoff",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const recorder = createTraceRecorder({ db, heartbeat, companyId });

    // Loop-breaker: prevent the post-finalize startNextQueuedRunForAgent from
    // re-firing executeRun against the same throwing stub. F3 established this
    // pattern; the operator standardized it across all non-success fixtures.
    // Trade-off: trace ends at internal:releaseRuntimeServicesForRun instead of
    // ending at internal:startNextQueuedRunForAgent — that side effect is
    // suppressed by design. Document in the canonical sequence.
    heartbeat.__internalsForTests.startNextQueuedRunForAgent = async () => undefined;

    try {
      // Decision 2B: include taskKey in contextSnapshot so the failure-block
      // upsertTaskSession branch at heartbeat.ts:5864 takes the lastError arm.
      const queued = await heartbeat.invoke(
        agentId,
        "on_demand",
        { issueId, taskKey },
        "manual",
      );
      expect(queued).not.toBeNull();

      const finished = await recorder.waitForRunSettled(queued!.id, 10_000);
      expect(finished?.status).toBe("failed");
      // executeRun continues for ~8 internal calls + the finally block AFTER
      // setRunStatus("failed") flips the row. Wait for the trace to stabilize
      // before snapshotting so the captured tail is complete.
      await recorder.waitForTraceQuiescent(300, 5_000);

      const trace = recorder.getOrderedTrace();
      const snapshot = await recorder.getDbSnapshot(queued!.id);

      // The locked canonical contract. Any change to this sequence is a
      // deliberate ordering decision that must be reviewed (and re-signed-off
      // by the operator) before merging — that is the whole point.
      expect(trace).toMatchTraceSequence(F2_CANONICAL_TRACE);

      // DB cross-checks — these confirm the spy/live-event recording stayed
      // consistent with what actually persisted.
      expect(snapshot.run?.status).toBe("failed");
      expect(snapshot.run?.errorCode).toBe("adapter_failed");
      expect(snapshot.wakeupRequest?.status).toBe("failed");
      // heartbeatRunEvents row count must equal the spy-recorded appendRunEvent
      // count (3: seq=1 "run started", seq=2 "adapter.invoke", seq=3 error).
      expect(snapshot.runEvents).toHaveLength(3);
      const appendRunEventCount = trace.filter(
        (ev) => ev.kind === "internal" && ev.name === "appendRunEvent",
      ).length;
      expect(snapshot.runEvents.length).toBe(appendRunEventCount);
      // No issue comment on the adapter-throw path (the success arm posts one;
      // the failure arm does not).
      expect(snapshot.issueComments).toHaveLength(0);
      // No cost row — adapter never returned an AdapterRunResult.
      expect(snapshot.costEvents).toHaveLength(0);
    } finally {
      recorder.dispose();
    }
  }, 30_000);
});
