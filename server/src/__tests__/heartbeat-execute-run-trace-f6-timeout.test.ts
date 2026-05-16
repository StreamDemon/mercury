// Wince #3 Track B Phase 1 — executeRun golden-trace characterization fixture F6.
//
// F6 pins the `outcome === "timed_out"` branch of executeRun's success/failure
// finalize block (heartbeat.ts ~5627-5800). The adapter stub returns
// `{ timedOut: true, exitCode: null, signal: null }`; executeRun derives
// `outcome = "timed_out"`, `runErrorCode = "timeout"`, `status = "timed_out"`.
//
// Trace LOCKED per operator sign-off 2026-05-17 (Wave 2 batch approval — all
// 6 Wave 2 fixtures approved as-is). F6_CANONICAL_TRACE below is the binding
// contract; any change to the sequence is a deliberate ordering decision that
// must be re-reviewed and re-signed-off by the operator before merging.
//
// Expected divergences from F1 (succeeded) — see heartbeat.ts cited line:
//   - setRunStatus(run.id, "timed_out", ...)              (5666-5673, 5714)
//   - setWakeupStatus(..., "timed_out", ...)              (5733: outcome === "succeeded" ? "completed" : status)
//   - terminal appendRunEvent message: "run timed_out", level: "error"
//                                                          (5740-5749)
//   - NO issue comment posted                             (5752: gated by outcome === "succeeded")
//   - NO scheduleBoundedRetryForRun                       (5768: gated by outcome === "failed",
//                                                          AND there's no transient_upstream
//                                                          contract because runErrorCode is "timeout".
//                                                          See readTransientRecoveryContractFromRun
//                                                          at heartbeat.ts:209.)
//   - clearTaskSessions arm (not upsertTaskSession)       (5780: adapterResult omits sessionId)
//   - finalizeAgentStatus(agent.id, "timed_out")          (5800)
//
// Locked decisions inherited from F1:
//   1B — issueId present so the issue-side finalize path runs (refresh /
//        finalizeIssueCommentPolicy / releaseIssueExecutionAndPromote with
//        issue context). Note: no issue comment is POSTED here (success-only).
//   2B — taskKey present in contextSnapshot. For timed_out, adapterResult has
//        no sessionId, so nextSessionState is empty and the success-block
//        branch at heartbeat.ts:5780 takes the clearTaskSessions arm rather
//        than upsertTaskSession.
//   4B — stub invokes onMeta so the adapter.invoke appendRunEvent (seq=2)
//        appears in the trace.
//
// Loop-breaker scope cut (per operator decision 1a — standardize F3's pattern
// across all non-success fixtures): the timed_out terminal status leaves the
// issue in `in_progress`, so the finally's `startNextQueuedRunForAgent` would
// re-claim and re-time-out on every scheduler tick, producing an unbounded
// re-queue tail in the trace. We stub `startNextQueuedRunForAgent` to a no-op
// AFTER the recorder installs its wrappers, scoping the trace to a SINGLE
// clean executeRun cycle that ends at the finally's
// `releaseRuntimeServicesForRun`. Trade-off: `internal:startNextQueuedRunForAgent`
// and the downstream re-queue side effect do not appear in the trace — that
// boundary is suppressed by design here and will be characterized in a
// queue-drain fixture where the loop concern does not apply.
//
// PR #62 (cancelRunInternal widen) and PR #63 (releaseIssueExecutionAndPromote
// promote-tail widen) plugged closure leaks at heartbeat.ts:6373 that
// previously bypassed the internalsForTests indirection. With both leaks
// plugged, the loop-breaker stub actually breaks the loop and the locked
// trace is a single clean executeRun cycle (28 events ending at
// `internal:releaseRuntimeServicesForRun`).
//
// Note on event [20] (liveEvent:heartbeat.run.queued): this is the promote-tail
// enqueue from releaseIssueExecutionAndPromote. The claim is BLOCKED because
// the loop-breaker stubs startNextQueuedRunForAgent to a no-op — the queued
// event still fires (releaseIssueExecutionAndPromote enqueues independently),
// but no follow-up executeRun cycle runs.

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

async function f6StubAdapterExecute(ctx: { onMeta?: (meta: Record<string, unknown>) => Promise<void> }) {
  if (typeof ctx?.onMeta === "function") {
    await ctx.onMeta({
      adapterType: "codex_local",
      command: "fake-stub-command",
      commandArgs: ["--fake"],
      env: { F6_FAKE_META: "1" },
      prompt: "fake prompt body",
      promptMetrics: { promptChars: 17 },
    });
  }
  return {
    exitCode: null,
    signal: null,
    timedOut: true,
    errorMessage: "simulated timeout",
    summary: "F6 timeout",
    provider: "test",
    model: "test-model",
  };
}

const mockAdapterExecute = vi.hoisted(() => vi.fn(f6StubAdapterExecute));

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

// F6 canonical sequence — 28 events. Operator-approved 2026-05-17 (Wave 2 batch
// sign-off). Argument matchers use the predicate form because the matcher's
// array form has no positional wildcard; predicates skip noisy args (runIds,
// agent rows, timestamps) and assert only stable invariants (status enums,
// seq numbers, event kinds, error codes).
const F6_CANONICAL_TRACE: readonly TraceMatcher[] = [
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
      args[1] === "timed_out" &&
      (args[2] as { errorCode?: string } | undefined)?.errorCode === "timeout",
  },
  { kind: "liveEvent", type: "heartbeat.run.status", payloadMatch: { status: "timed_out" } },
  { kind: "internal", name: "classifyAndPersistRunLiveness" },
  {
    kind: "internal",
    name: "setWakeupStatus",
    argsMatch: (args) => args[1] === "timed_out",
  },
  {
    kind: "internal",
    name: "appendRunEvent",
    argsMatch: (args) => {
      const payload = args[2] as { eventType?: string; level?: string } | undefined;
      return args[1] === 3 && payload?.eventType === "lifecycle" && payload?.level === "error";
    },
  },
  { kind: "liveEvent", type: "heartbeat.run.event", payloadMatch: { seq: 3, eventType: "lifecycle" } },
  { kind: "internal", name: "refreshContinuationSummaryForRun" },
  { kind: "internal", name: "finalizeIssueCommentPolicy" },
  { kind: "internal", name: "releaseIssueExecutionAndPromote" },
  // promote-tail enqueue from releaseIssueExecutionAndPromote. The downstream
  // claim is blocked by the loop-breaker stub on startNextQueuedRunForAgent.
  { kind: "liveEvent", type: "heartbeat.run.queued" },
  { kind: "internal", name: "handleRunLivenessContinuation" },
  { kind: "internal", name: "updateRuntimeState" },
  // clearTaskSessions arm — adapterResult omits sessionId, so the success
  // block at heartbeat.ts:5780 takes this branch rather than upsertTaskSession.
  { kind: "internal", name: "clearTaskSessions" },
  {
    kind: "internal",
    name: "finalizeAgentStatus",
    argsMatch: (args) => args[1] === "timed_out",
  },
  { kind: "liveEvent", type: "agent.status" },
  { kind: "liveEvent", type: "activity.logged" },
  { kind: "internal", name: "releaseRuntimeServicesForRun" },
];

describeEmbeddedPostgres("executeRun characterization fixtures — F6 timeout (wince #3 Track B Phase 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mercury-execute-run-trace-f6-");
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

  // afterEach ordering verbatim from F1 (heartbeat-execute-run-trace.test.ts).
  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(f6StubAdapterExecute);
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

  it("F6 — adapter timeout matches the canonical 28-event timed_out trace", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const taskKey = "f6-canonical-task-key";

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

    // Decision 1B inherited from F1: include an issueId to pin the issue-side
    // finalize path. For timed_out, no run-summary comment is posted (gated
    // by outcome === "succeeded" at heartbeat.ts:5752), but
    // refreshContinuationSummaryForRun / finalizeIssueCommentPolicy /
    // releaseIssueExecutionAndPromote still run with issue context.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "F6 timed_out canonical fixture",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const recorder = createTraceRecorder({ db, heartbeat, companyId });

    try {
      // Loop-breaker: prevent the post-finalize startNextQueuedRunForAgent from
      // re-firing executeRun (the timed_out run keeps the issue in_progress, so
      // the next scheduler tick would re-claim and re-time-out). F3 established
      // this pattern; the operator standardized it across all non-success
      // fixtures. Trade-off: trace ends at internal:releaseRuntimeServicesForRun
      // instead of internal:startNextQueuedRunForAgent — that side effect is
      // suppressed by design.
      heartbeat.__internalsForTests.startNextQueuedRunForAgent = async () => undefined;

      // Decision 2B inherited from F1: include taskKey in contextSnapshot.
      // For timed_out, the success-block branch at heartbeat.ts:5780 takes
      // the clearTaskSessions arm (adapterResult omits sessionId).
      const queued = await heartbeat.invoke(
        agentId,
        "on_demand",
        { issueId, taskKey },
        "manual",
      );
      expect(queued).not.toBeNull();

      const finished = await recorder.waitForRunSettled(queued!.id, 10_000);
      expect(finished?.status).toBe("timed_out");
      // executeRun continues for ~10 internal calls + the finally block AFTER
      // setRunStatus("timed_out") flips the row. Wait for the trace to
      // stabilize before snapshotting so the captured tail is complete.
      await recorder.waitForTraceQuiescent(300, 5_000);

      const trace = recorder.getOrderedTrace();
      const snapshot = await recorder.getDbSnapshot(queued!.id);

      // The locked canonical contract. Any change to this sequence is a
      // deliberate ordering decision that must be reviewed (and re-signed-off
      // by the operator) before merging — that is the whole point.
      expect(trace).toMatchTraceSequence(F6_CANONICAL_TRACE);

      // DB cross-checks — these confirm the spy/live-event recording stayed
      // consistent with what actually persisted.
      expect(snapshot.run?.status).toBe("timed_out");
      expect(snapshot.run?.errorCode).toBe("timeout");
      expect(snapshot.wakeupRequest?.status).toBe("timed_out");
      // heartbeatRunEvents row count must equal the spy-recorded appendRunEvent
      // count (3: seq=1 "run started", seq=2 "adapter.invoke", seq=3 "run timed_out").
      expect(snapshot.runEvents).toHaveLength(3);
      const appendRunEventCount = trace.filter(
        (ev) => ev.kind === "internal" && ev.name === "appendRunEvent",
      ).length;
      expect(snapshot.runEvents.length).toBe(appendRunEventCount);
      // No issue comment on timeout (gated by outcome === "succeeded" at 5752).
      expect(snapshot.issueComments).toHaveLength(0);
      // costUsd deliberately omitted (decision 3A inherited from F1).
      expect(snapshot.costEvents).toHaveLength(0);
      // scheduleBoundedRetryForRun must NOT appear (gated to outcome === "failed";
      // timed_out routes to a distinct branch).
      expect(
        trace.some((ev) => ev.kind === "internal" && ev.name === "scheduleBoundedRetryForRun"),
      ).toBe(false);
    } finally {
      recorder.dispose();
    }
  }, 30_000);
});
