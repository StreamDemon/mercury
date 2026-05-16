// Wince #3 Track B Phase 1 — executeRun golden-trace characterization fixtures.
//
// F1 (this file) establishes the canonical happy-path trace that every other
// fixture (F2-F7, parallel via worktrees in Wave 2) will diff against.
//
// Locked decisions (user sign-off recorded in PR C body):
//   1B — F1 includes an issueId to pin the issue-side success path.
//   2B — F1 includes a taskKey in contextSnapshot and the stub returns
//        sessionId so the success-block branch at heartbeat.ts:5780 takes the
//        upsertTaskSession arm (vs clearTaskSessions).
//   4B — The stub adapter invokes onMeta with fake meta to capture the
//        appendRunEvent(adapter.invoke) call at heartbeat.ts:5491.
//   5  — activity.logged / agent.status / heartbeat.run.log live events stay
//        in the locked trace as observable contract.
//
// Deferred (intentional Phase 1 scope cuts — not bugs):
//   3A — costUsd is NOT returned by the stub adapter. Adding it triggered a
//        cleanup FK race against cost_events. Cost-ledger ordering will get
//        its own dedicated fixture variant (likely an F2 sibling or F8) with
//        afterEach hardened to wait for cost-event listener settlement.
//   6  — workspace-runtime calls are NOT spied as internal events. They emit
//        activity.logged / agent.status / heartbeat.run.log live events that
//        appear in the trace, but the calls themselves stay opaque to the
//        spy stream. Rationale: workspace-runtime carve is wince #3 Phase 5
//        with its own characterization requirement; pre-empting it here
//        would tightly couple every Phase 1 fixture to workspace-runtime's
//        internal ordering and force trace updates across F1-F7 whenever
//        Phase 5 work refactors that file.

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

async function f1StubAdapterExecute(ctx: { onMeta?: (meta: Record<string, unknown>) => Promise<void> }) {
  if (typeof ctx?.onMeta === "function") {
    await ctx.onMeta({
      adapterType: "codex_local",
      command: "fake-stub-command",
      commandArgs: ["--fake"],
      env: { F1_FAKE_META: "1" },
      prompt: "fake prompt body",
      promptMetrics: { promptChars: 17 },
    });
  }
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "F1 happy-path canonical fixture.",
    provider: "test",
    model: "test-model",
    sessionId: "f1-canonical-session",
  };
}

const mockAdapterExecute = vi.hoisted(() => vi.fn(f1StubAdapterExecute));

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

// F1 canonical sequence — 28 events. User-approved 2026-05-16.
// Argument matchers use the predicate form because the matcher's array form
// has no positional wildcard; predicates skip noisy args (runIds, agent rows,
// timestamps) and assert only stable invariants (status enums, seq numbers,
// event kinds).
const F1_CANONICAL_TRACE: readonly TraceMatcher[] = [
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
    argsMatch: (args) => args[1] === "succeeded",
  },
  { kind: "liveEvent", type: "heartbeat.run.status", payloadMatch: { status: "succeeded" } },
  { kind: "internal", name: "classifyAndPersistRunLiveness" },
  {
    kind: "internal",
    name: "setWakeupStatus",
    argsMatch: (args) => args[1] === "completed",
  },
  {
    kind: "internal",
    name: "appendRunEvent",
    argsMatch: (args) =>
      args[1] === 3 && (args[2] as { eventType?: string })?.eventType === "lifecycle",
  },
  { kind: "liveEvent", type: "heartbeat.run.event", payloadMatch: { seq: 3, eventType: "lifecycle" } },
  { kind: "internal", name: "refreshContinuationSummaryForRun" },
  { kind: "internal", name: "finalizeIssueCommentPolicy" },
  { kind: "internal", name: "releaseIssueExecutionAndPromote" },
  { kind: "internal", name: "handleRunLivenessContinuation" },
  { kind: "internal", name: "updateRuntimeState" },
  { kind: "internal", name: "upsertTaskSession" },
  {
    kind: "internal",
    name: "finalizeAgentStatus",
    argsMatch: (args) => args[1] === "succeeded",
  },
  { kind: "liveEvent", type: "agent.status" },
  { kind: "liveEvent", type: "activity.logged" },
  { kind: "internal", name: "releaseRuntimeServicesForRun" },
  { kind: "internal", name: "startNextQueuedRunForAgent" },
];

describeEmbeddedPostgres("executeRun characterization fixtures (wince #3 Track B Phase 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mercury-execute-run-trace-");
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
    mockAdapterExecute.mockImplementation(f1StubAdapterExecute);
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

  it("F1 — happy path success matches the canonical 28-event trace", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const taskKey = "f1-canonical-task-key";

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

    // Decision 1B: include an issueId to pin the issue-side success path
    // (refreshContinuationSummaryForRun / finalizeIssueCommentPolicy /
    // releaseIssueExecutionAndPromote with issue context, issue-comment posting).
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "F1 canonical happy path",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const recorder = createTraceRecorder({ db, heartbeat, companyId });

    try {
      // Decision 2B: include taskKey in contextSnapshot so the success-path
      // branch at heartbeat.ts:5780 takes the upsertTaskSession arm.
      const queued = await heartbeat.invoke(
        agentId,
        "on_demand",
        { issueId, taskKey },
        "manual",
      );
      expect(queued).not.toBeNull();

      const finished = await recorder.waitForRunSettled(queued!.id, 10_000);
      expect(finished?.status).toBe("succeeded");
      // executeRun continues for ~10 internal calls + the finally block AFTER
      // setRunStatus("succeeded") flips the row. Wait for the trace to stabilize
      // before snapshotting so the captured tail is complete.
      await recorder.waitForTraceQuiescent(300, 5_000);

      const trace = recorder.getOrderedTrace();
      const snapshot = await recorder.getDbSnapshot(queued!.id);

      // The locked canonical contract. Any change to this sequence is a
      // deliberate ordering decision that must be reviewed (and re-signed-off
      // by the operator) before merging — that is the whole point.
      expect(trace).toMatchTraceSequence(F1_CANONICAL_TRACE);

      // DB cross-checks — these confirm the spy/live-event recording stayed
      // consistent with what actually persisted.
      expect(snapshot.run?.status).toBe("succeeded");
      expect(snapshot.run?.errorCode).toBeNull();
      expect(snapshot.wakeupRequest?.status).toBe("completed");
      // heartbeatRunEvents row count must equal the spy-recorded appendRunEvent
      // count (3: seq=1 "run started", seq=2 "adapter.invoke", seq=3 "run succeeded").
      expect(snapshot.runEvents).toHaveLength(3);
      const appendRunEventCount = trace.filter(
        (ev) => ev.kind === "internal" && ev.name === "appendRunEvent",
      ).length;
      expect(snapshot.runEvents.length).toBe(appendRunEventCount);
      // Issue comment posted on success.
      expect(snapshot.issueComments).toHaveLength(1);
      // costUsd deliberately omitted (decision 3A) — confirm no cost row.
      expect(snapshot.costEvents).toHaveLength(0);
    } finally {
      recorder.dispose();
    }
  }, 30_000);
});
