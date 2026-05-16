// Wince #3 Track B Phase 1 — executeRun golden-trace characterization fixture F6.
//
// F6 pins the `outcome === "timed_out"` branch of executeRun's success/failure
// finalize block (heartbeat.ts ~5627-5800). The adapter stub returns
// `{ timedOut: true, exitCode: null, signal: null }`; executeRun derives
// `outcome = "timed_out"`, `runErrorCode = "timeout"`, `status = "timed_out"`.
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
//   - finalizeAgentStatus(agent.id, "timed_out")          (5800)
//
// CAPTURE MODE: this fixture intentionally does NOT call toMatchTraceSequence.
// The captured trace is logged for operator sign-off; once approved it will be
// frozen into an F6_CANONICAL_TRACE matcher in a follow-up.
//
// Locked decisions inherited from F1:
//   1B — issueId present so the issue-side finalize path runs (refresh /
//        finalizeIssueCommentPolicy / releaseIssueExecutionAndPromote with
//        issue context). Note: no issue comment is POSTED here (success-only).
//   2B — taskKey present in contextSnapshot. For timed_out, adapterResult has
//        no sessionId, so nextSessionState should be empty and the
//        success-block branch at heartbeat.ts:5780 takes the clearTaskSessions
//        arm rather than upsertTaskSession. The captured trace will show
//        which arm fires — operator confirms during sign-off.
//   4B — stub invokes onMeta so the adapter.invoke appendRunEvent (seq=2)
//        appears in the trace.

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
} from "../services/__tests__/helpers/trace-recorder.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping executeRun trace fixtures on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

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

  it("F6 — adapter timeout captures the timed_out finalize trace [CAPTURE]", async () => {
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
      // Decision 2B inherited from F1: include taskKey in contextSnapshot.
      // For timed_out, the success-block branch at heartbeat.ts:5780 still
      // runs; the captured trace shows which arm (clearTaskSessions vs
      // upsertTaskSession) fires for this adapter shape.
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

      // CAPTURE MODE — do NOT lock toMatchTraceSequence here. The recorded
      // trace is the artifact under review.
      expect(trace.length).toBeGreaterThan(0);
      expect(snapshot.run?.status).toBe("timed_out");

      // Echo the captured trace for PR sign-off. Structured one-line-per-event
      // so the operator can scan it in the PR body verbatim.
      // eslint-disable-next-line no-console
      console.log(
        "\n[F6 captured trace] ordered events:\n" +
          trace
            .map((ev, i) => {
              if (ev.kind === "internal") {
                return `  ${String(i).padStart(2, "0")}  internal   ${String(ev.name)}`;
              }
              return `  ${String(i).padStart(2, "0")}  liveEvent  ${ev.type}`;
            })
            .join("\n"),
      );
      // eslint-disable-next-line no-console
      console.log(
        "\n[F6 captured trace] DB snapshot:\n" +
          JSON.stringify(
            {
              runStatus: snapshot.run?.status,
              runErrorCode: snapshot.run?.errorCode,
              wakeupStatus: snapshot.wakeupRequest?.status,
              runEventsCount: snapshot.runEvents.length,
              costEventsCount: snapshot.costEvents.length,
              issueCommentsCount: snapshot.issueComments.length,
              scheduleBoundedRetryForRunSeen: trace.some(
                (ev) => ev.kind === "internal" && ev.name === "scheduleBoundedRetryForRun",
              ),
            },
            null,
            2,
          ),
      );
    } finally {
      recorder.dispose();
    }
  }, 30_000);
});
