// Wince #3 Track B Phase 1 — F7: cancelled mid-run.
//
// What this fixture pins:
//   The interleaving when heartbeat.cancelRun fires while executeRun is awaiting
//   adapter.execute. Two ordered effect streams collide:
//     A) cancelRunInternal's cascade (setRunStatus, setWakeupStatus, appendRunEvent,
//        releaseIssueExecutionAndPromote, finalizeAgentStatus, startNextQueuedRunForAgent)
//     B) executeRun's post-adapter resume path. Because adapterResult arrives
//        normally and the run row was already flipped to a terminal status, the
//        outcome-resolution branch at heartbeat.ts:5629 takes
//        `outcome = latestRun.status` ("cancelled") and the rest of the
//        success-block tail fires under that outcome (setRunStatus a second
//        time with terminal-row-already-set, classifyAndPersistRunLiveness,
//        refreshContinuationSummaryForRun, finalizeIssueCommentPolicy,
//        releaseIssueExecutionAndPromote, handleRunLivenessContinuation,
//        updateRuntimeState, upsertTaskSession because taskKey + sessionId,
//        finalizeAgentStatus, finally-block releaseRuntimeServicesForRun +
//        startNextQueuedRunForAgent).
//
// Race-handling approach (deterministic, no polling on row state):
//   The stub adapter awaits onMeta SYNCHRONOUSLY first (so seq=2 adapter.invoke
//   is recorded and published before cancel runs), then signals adapterStarted,
//   then blocks on a promise the test resolves only AFTER cancelRun's full
//   cascade has completed. Because cancelRunInternal awaits every step,
//   `await heartbeat.cancelRun` guarantees the entire cancel cascade is
//   serialized before adapter returns. This is what makes a "mid-run" cancel
//   test deterministic.
//
// Simplification after PR #62 + #63 (re-run on 2026-05-17):
//   PR #62 widened cancelRunInternal's six closure-direct calls (setRunStatus,
//   setWakeupStatus, appendRunEvent, releaseIssueExecutionAndPromote,
//   finalizeAgentStatus, startNextQueuedRunForAgent) to dispatch through
//   internals.X — so the cancel cluster is now FULLY OBSERVABLE in the spy
//   stream as `internal:*` events, not just via cascading live events.
//   PR #63 routed releaseIssueExecutionAndPromote's tail-promote (heartbeat.ts:6373)
//   through internals.startNextQueuedRunForAgent — so stubbing that one entry
//   actually breaks every cascading promote loop.
//
//   The combined effect on F7: stubbing internals.startNextQueuedRunForAgent
//   to a no-op blocks BOTH the cancel-cluster's own follow-on promote AND any
//   tail-promote that releaseIssueExecutionAndPromote would have triggered
//   through executeRun's resume path. Only one full executeRun cycle ever
//   runs, so the original adapter-swap mid-test trick AND the manual runId
//   filter are no longer required. Standard loop-breaker pattern, single
//   clean cycle.
//
// Spy visibility note for the loop-breaker:
//   Replacing `internals.startNextQueuedRunForAgent` AFTER createTraceRecorder
//   overwrites the recorder's spy wrapper entirely. The call still happens at
//   runtime but does not get recorded as an `internal:startNextQueuedRunForAgent`
//   event in the trace — by design (the recorder has no public API to insert
//   an event without invoking the original). The cascade it would have
//   triggered is what matters for characterization, and that cascade is now
//   suppressed.
//
// Expected duplicate-fire patterns from cancel + executeRun resume (all
// observable via internals.X spies post-PR-#62):
//   - setRunStatus("cancelled") TWICE (cancel:7186 + executeRun resume:5714)
//   - setWakeupStatus("cancelled") TWICE (cancel:7199 + resume:5733)
//   - releaseIssueExecutionAndPromote TWICE (cancel:7211 + resume:5772)
//   - finalizeAgentStatus("cancelled") TWICE (cancel:7215 + resume:5800)
//   - appendRunEvent rows with seq=1 TWICE persisted: cancel hardcodes seq=1
//     at 7205, executeRun's local `let seq = 1` already wrote seq=1 for
//     "run started". The heartbeat_run_events schema has no UNIQUE on seq —
//     just an index — so both rows persist. Pre-existing behavior the
//     fixture documents.
//
// CAPTURE MODE: this test does NOT call toMatchTraceSequence. Phase 1 locks
// happen after operator sign-off on the captured trace recorded in the PR body.

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

// Shared promise refs the test wires up per-invocation. The stub closes over
// these via module scope so it can signal entry and block on release without
// the test needing to inject them through the mocked module surface.
let adapterEnteredResolve: (() => void) | null = null;
let releaseAdapter: Promise<void> | null = null;
let resolveReleaseAdapter: (() => void) | null = null;

async function f7BlockingStubAdapterExecute(ctx: {
  onMeta?: (meta: Record<string, unknown>) => Promise<void>;
}) {
  // 1) Synchronously emit the adapter.invoke event BEFORE signalling entry so
  //    the trace records seq=2 adapter.invoke + the matching live event before
  //    the test releases the cancel. Order matters for determinism: if entry
  //    is signalled first, cancel can race ahead of the adapter.invoke append
  //    and the trace varies between runs.
  if (typeof ctx?.onMeta === "function") {
    await ctx.onMeta({
      adapterType: "codex_local",
      command: "fake-stub-command",
      commandArgs: ["--fake-f7"],
      env: { F7_FAKE_META: "1" },
      prompt: "fake prompt body for F7",
      promptMetrics: { promptChars: 24 },
    });
  }
  // 2) Tell the test the adapter is in-flight.
  adapterEnteredResolve?.();
  // 3) Block until the test resolves releaseAdapter (which it does only AFTER
  //    awaiting heartbeat.cancelRun's entire cascade).
  if (releaseAdapter) {
    await releaseAdapter;
  }
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorMessage: "cancelled by F7 fixture",
    summary: "F7 mid-run cancel canonical fixture.",
    provider: "test",
    model: "test-model",
    sessionId: "f7-canonical-session",
  };
}

const mockAdapterExecute = vi.hoisted(() => vi.fn());

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
} from "../services/__tests__/helpers/trace-recorder.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping executeRun trace fixtures on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("executeRun characterization fixtures (wince #3 Track B Phase 1) — F7 cancel", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mercury-execute-run-trace-f7-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

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
    mockAdapterExecute.mockImplementation(f7BlockingStubAdapterExecute);
    runningProcesses.clear();
    // Defensive: if a previous test path left the release promise unresolved,
    // resolve it so any orphan stub invocation can complete.
    resolveReleaseAdapter?.();
    adapterEnteredResolve = null;
    releaseAdapter = null;
    resolveReleaseAdapter = null;
    await waitForHeartbeatIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
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

  it("F7 — cancel mid-run captures the cancel-cascade + executeRun resume trace [CAPTURE]", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const taskKey = "f7-canonical-task-key";

    await db.insert(companies).values({
      id: companyId,
      name: "Mercury",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TraceAgentF7",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "F7 cancel mid-run canonical fixture",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    // Wire the synchronization promises BEFORE invoking so the stub captures
    // the current refs the moment it's entered.
    const adapterEntered = new Promise<void>((resolve) => {
      adapterEnteredResolve = resolve;
    });
    releaseAdapter = new Promise<void>((resolve) => {
      resolveReleaseAdapter = resolve;
    });
    mockAdapterExecute.mockImplementation(f7BlockingStubAdapterExecute);

    const heartbeat = heartbeatService(db);
    const recorder = createTraceRecorder({ db, heartbeat, companyId });

    // Standard Wave 2 loop-breaker pattern (mirrors F2/F6 design): stub
    // internals.startNextQueuedRunForAgent to no-op so the post-cancel
    // cascade doesn't auto-promote any follow-on runs into the blocking stub.
    // Combined with PR #63's routing of heartbeat.ts:6373 through internals.X,
    // this short-circuits BOTH (a) the finally-block startNext at 5942,
    // (b) cancelRunInternal's own startNext at 7216, AND (c) the tail-promote
    // inside releaseIssueExecutionAndPromote at 6373. Result: exactly one
    // executeRun cycle, no contamination, no manual runId filtering needed.
    const internals = heartbeat.__internalsForTests;
    if (internals) {
      internals.startNextQueuedRunForAgent = async () => {};
    }

    try {
      const queued = await heartbeat.invoke(
        agentId,
        "on_demand",
        { issueId, taskKey },
        "manual",
      );
      expect(queued).not.toBeNull();

      // Wait until the stub adapter has been entered (post-onMeta). This
      // guarantees seq=2 adapter.invoke is already recorded in the trace before
      // we trigger cancellation.
      await Promise.race([
        adapterEntered,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("adapter did not enter within 10s")), 10_000),
        ),
      ]);

      // Cancel while the adapter is blocked. Because cancelRunInternal awaits
      // every step of its cascade, awaiting cancelRun serializes the full
      // cancel sequence (setRunStatus → setWakeupStatus → appendRunEvent →
      // releaseIssueExecutionAndPromote → finalizeAgentStatus →
      // startNextQueuedRunForAgent) BEFORE we let the adapter return.
      const cancelled = await heartbeat.cancelRun(queued!.id);
      expect(cancelled?.status).toBe("cancelled");

      // Release the adapter so executeRun's await on adapter.execute resolves
      // for our blocked invocation and the post-adapter resume path runs
      // (it will see the terminal row and take outcome = "cancelled" via the
      // heartbeat.ts:5629 branch).
      resolveReleaseAdapter?.();

      const finished = await recorder.waitForRunSettled(queued!.id, 10_000);
      expect(finished?.status).toBe("cancelled");
      // executeRun's resume tail and the finally block continue past the
      // status flip; wait for the trace to stop growing before snapshotting.
      await recorder.waitForTraceQuiescent(300, 5_000);

      const trace = recorder.getOrderedTrace();
      const snapshot = await recorder.getDbSnapshot(queued!.id);

      // CAPTURE-MODE assertions (per task spec). No toMatchTraceSequence lock.
      expect(trace.length).toBeGreaterThan(0);
      expect(snapshot.run?.status).toBe("cancelled");

      // eslint-disable-next-line no-console
      console.log(
        "\n=== F7 captured trace (",
        trace.length,
        " events) ===\n" +
          trace
            .map((ev, i) => {
              if (ev.kind === "internal") {
                const argSummary = ev.args
                  .map((a) => {
                    if (a === null || a === undefined) return String(a);
                    if (typeof a === "string") return JSON.stringify(a.length > 60 ? a.slice(0, 60) + "…" : a);
                    if (typeof a === "number" || typeof a === "boolean") return String(a);
                    if (typeof a === "object") {
                      try {
                        const json = JSON.stringify(a);
                        return json.length > 80 ? json.slice(0, 80) + "…" : json;
                      } catch {
                        return "[unserializable]";
                      }
                    }
                    return typeof a;
                  })
                  .join(", ");
                return `  [${String(i).padStart(2, " ")}] internal:${String(ev.name)}(${argSummary})`;
              }
              const payloadJson = (() => {
                try {
                  const json = JSON.stringify(ev.payload);
                  return json.length > 120 ? json.slice(0, 120) + "…" : json;
                } catch {
                  return "[unserializable]";
                }
              })();
              return `  [${String(i).padStart(2, " ")}] liveEvent:${ev.type} ${payloadJson}`;
            })
            .join("\n") +
          "\n=== /F7 captured trace ===\n",
      );
      // eslint-disable-next-line no-console
      console.log(
        "F7 DB snapshot:",
        JSON.stringify(
          {
            runStatus: snapshot.run?.status,
            runErrorCode: snapshot.run?.errorCode,
            runError: snapshot.run?.error,
            wakeupStatus: snapshot.wakeupRequest?.status,
            runEventsCount: snapshot.runEvents.length,
            runEventSeqs: snapshot.runEvents.map((e) => ({ seq: e.seq, eventType: e.eventType })),
            costEventsCount: snapshot.costEvents.length,
            issueCommentsCount: snapshot.issueComments.length,
          },
          null,
          2,
        ),
      );
    } finally {
      // Safety: ensure adapter is released even on test failure so afterEach
      // can drain.
      resolveReleaseAdapter?.();
      recorder.dispose();
    }
  }, 30_000);
});
