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
// CAPTURE MODE: This file does NOT lock toMatchTraceSequence. It surfaces the
// recorded ordered sequence via console.log so the operator can sign off on
// the canonical F2 trace; a follow-up commit will replace the permissive
// assertions with toMatchTraceSequence(F2_CANONICAL_TRACE).

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
import { createTraceRecorder } from "../services/__tests__/helpers/trace-recorder.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping executeRun trace fixtures on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Local helpers — capture-mode display utilities. Defined inline (rather than
// shared with F1) so each capture fixture is self-contained for sign-off and
// so future F3-F7 captures can fork these without coupling to F1.
function summarizeTraceForDisplay(trace: ReadonlyArray<{ kind: string; name?: string; type?: string }>) {
  return trace.map((ev, idx) => {
    const idxStr = String(idx).padStart(2, "0");
    if (ev.kind === "internal") return `[${idxStr}] internal:${ev.name ?? "<unknown>"}`;
    if (ev.kind === "liveEvent") return `[${idxStr}] liveEvent:${ev.type ?? "<unknown>"}`;
    return `[${idxStr}] ${ev.kind}`;
  });
}

function countByKey(trace: ReadonlyArray<{ kind: string; name?: string; type?: string }>) {
  const counts = new Map<string, number>();
  for (const ev of trace) {
    const key = ev.kind === "internal" ? `internal:${ev.name ?? "<unknown>"}` : `liveEvent:${ev.type ?? "<unknown>"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort());
}

describeEmbeddedPostgres("executeRun characterization fixtures (wince #3 Track B Phase 1) — F2 capture", () => {
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

  it("F2 — adapter throws (inner catch) — CAPTURE the recovery handoff trace", async () => {
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

      // CAPTURE MODE assertions — permissive only. The locked
      // F2_CANONICAL_TRACE matcher will be added in a follow-up commit AFTER
      // the operator signs off on the captured sequence printed below.
      expect(trace.length).toBeGreaterThan(0);
      expect(snapshot.run?.status).toBe("failed");
      expect(snapshot.run?.errorCode).toBe("adapter_failed");

      // Surface the captured trace + DB snapshot for operator sign-off.
      // (PR body must include this verbatim under "Captured trace".)
      // eslint-disable-next-line no-console
      console.log("\n===== F2 captured trace (ordered) =====");
      for (const line of summarizeTraceForDisplay(trace)) {
        // eslint-disable-next-line no-console
        console.log(line);
      }
      // eslint-disable-next-line no-console
      console.log("\n===== F2 trace event counts (by key) =====");
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(countByKey(trace), null, 2));
      // eslint-disable-next-line no-console
      console.log("\n===== F2 DB snapshot =====");
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        runStatus: snapshot.run?.status ?? null,
        runErrorCode: snapshot.run?.errorCode ?? null,
        runErrorMessage: snapshot.run?.error ?? null,
        wakeupStatus: snapshot.wakeupRequest?.status ?? null,
        heartbeatRunEventsCount: snapshot.runEvents.length,
        runEventTypes: snapshot.runEvents.map((ev: { eventType?: string }) => ev.eventType ?? null),
        costEventsCount: snapshot.costEvents.length,
        issueCommentsCount: snapshot.issueComments.length,
      }, null, 2));
    } finally {
      recorder.dispose();
    }
  }, 30_000);
});
