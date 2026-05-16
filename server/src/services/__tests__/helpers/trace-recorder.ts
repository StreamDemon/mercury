// Trace recorder for executeRun characterization fixtures (wince #3 Track B Phase 1).
//
// Why this file exists: heartbeat.ts:executeRun owns the entire success/failure contract
// of every agent run. Phase 1 builds golden-trace fixtures that record the exact ordered
// sequence of every observable side effect produced by executeRun across representative
// scenarios. The trace becomes the safety net: any future change that alters the recorded
// sequence fails the test, forcing the diff to be reviewed deliberately.
//
// The recorder merges two ordered streams into one trace:
//   1. Spy stream — wrappers around heartbeat.__internalsForTests record every call.
//   2. Live event stream — a subscribeCompanyLiveEvents listener records publishLiveEvent emits.
// A single monotonic counter preserves cross-stream ordering. A separate DB snapshot
// helper (getDbSnapshot) returns the final state of relevant tables for consistency
// cross-checks (e.g., heartbeatRunEvents row count must equal spy-recorded appendRunEvent
// count).
//
// Importing this module also registers the toMatchTraceSequence vitest matcher.

import { asc, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  type Db,
} from "@mercuryai/db";
import type { LiveEvent, LiveEventType } from "@mercuryai/shared";
import { expect } from "vitest";

import { subscribeCompanyLiveEvents } from "../../live-events.js";
import type { heartbeatService } from "../../heartbeat.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;
type Internals = NonNullable<HeartbeatService["__internalsForTests"]>;
type InternalName = keyof Internals;

export type TraceEvent =
  | { kind: "internal"; name: InternalName; args: unknown[]; at: number }
  | { kind: "liveEvent"; type: LiveEventType; payload: Record<string, unknown>; at: number };

export interface TraceDbSnapshot {
  run: typeof heartbeatRuns.$inferSelect | null;
  runEvents: (typeof heartbeatRunEvents.$inferSelect)[];
  wakeupRequest: typeof agentWakeupRequests.$inferSelect | null;
  costEvents: (typeof costEvents.$inferSelect)[];
  issueComments: (typeof issueComments.$inferSelect)[];
}

export interface TraceRecorder {
  getOrderedTrace(): readonly TraceEvent[];
  getDbSnapshot(runId: string): Promise<TraceDbSnapshot>;
  waitForRunSettled(
    runId: string,
    timeoutMs?: number,
  ): Promise<typeof heartbeatRuns.$inferSelect | null | undefined>;
  /**
   * Wait until the recorded trace stops growing for `quietMs` consecutive
   * milliseconds, or until `timeoutMs` elapses. Use after `waitForRunSettled`
   * to capture executeRun's post-status-change tail (recovery handoff,
   * task-session persist, agent-status finalize, finally-block cleanup).
   */
  waitForTraceQuiescent(quietMs?: number, timeoutMs?: number): Promise<void>;
  dispose(): void;
}

export interface TraceRecorderOptions {
  db: Db;
  heartbeat: HeartbeatService;
  companyId: string;
}

export function createTraceRecorder(options: TraceRecorderOptions): TraceRecorder {
  const { db, heartbeat, companyId } = options;
  const internals = heartbeat.__internalsForTests;
  if (!internals) {
    throw new Error(
      "heartbeat.__internalsForTests is unavailable — fixture requires the internals refactor (PR #53 / wince-3 Track B Phase 1).",
    );
  }

  const trace: TraceEvent[] = [];
  let nextAt = 0;
  const sequence = () => nextAt++;

  // Capture originals before replacing so dispose() can restore.
  const original: Record<string, unknown> = {};
  for (const key of Object.keys(internals) as InternalName[]) {
    original[key as string] = internals[key];
  }

  for (const key of Object.keys(original) as InternalName[]) {
    const originalFn = original[key as string] as (...args: unknown[]) => unknown;
    (internals as Record<string, unknown>)[key as string] = (...args: unknown[]) => {
      trace.push({ kind: "internal", name: key, args, at: sequence() });
      return originalFn(...args);
    };
  }

  const unsubscribe = subscribeCompanyLiveEvents(companyId, (event: LiveEvent) => {
    trace.push({
      kind: "liveEvent",
      type: event.type,
      payload: event.payload,
      at: sequence(),
    });
  });

  let disposed = false;

  return {
    getOrderedTrace() {
      // Stable sort by sequence index. Push order already preserves this; sort is
      // a defensive guarantee in case any concurrent emit races with a spy push.
      return [...trace].sort((a, b) => a.at - b.at);
    },

    async getDbSnapshot(runId: string): Promise<TraceDbSnapshot> {
      const [runRow] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);

      const events = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId))
        .orderBy(asc(heartbeatRunEvents.seq));

      let wakeup: typeof agentWakeupRequests.$inferSelect | null = null;
      if (runRow?.wakeupRequestId) {
        const [row] = await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, runRow.wakeupRequestId))
          .limit(1);
        wakeup = row ?? null;
      }

      const costs = await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.heartbeatRunId, runId));

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.createdByRunId, runId))
        .orderBy(asc(issueComments.createdAt));

      return {
        run: runRow ?? null,
        runEvents: events,
        wakeupRequest: wakeup,
        costEvents: costs,
        issueComments: comments,
      };
    },

    async waitForRunSettled(runId: string, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const run = await heartbeat.getRun(runId);
        if (!run || (run.status !== "queued" && run.status !== "running")) return run;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return heartbeat.getRun(runId);
    },

    async waitForTraceQuiescent(quietMs = 250, timeoutMs = 5_000) {
      // The heartbeatRuns row's status flips to a terminal value at the
      // setRunStatus call inside executeRun, but executeRun continues for
      // several more internal calls (finalizeIssueCommentPolicy,
      // releaseIssueExecutionAndPromote, handleRunLivenessContinuation,
      // updateRuntimeState, clearTaskSessions/upsertTaskSession,
      // finalizeAgentStatus) and then the unconditional `finally` block
      // (releaseRuntimeServicesForRun, startNextQueuedRunForAgent).
      // Polling heartbeat.getRun(runId) alone returns BEFORE that tail is
      // observable. Use this helper after waitForRunSettled to wait until the
      // recorded trace stops growing for `quietMs` consecutive milliseconds.
      const deadline = Date.now() + timeoutMs;
      let lastLength = trace.length;
      let lastChangeAt = Date.now();
      while (Date.now() < deadline) {
        if (trace.length !== lastLength) {
          lastLength = trace.length;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= quietMs) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const key of Object.keys(original) as InternalName[]) {
        (internals as Record<string, unknown>)[key as string] = original[key as string];
      }
    },
  };
}

// ----- toMatchTraceSequence vitest matcher -----

export type TraceMatcher =
  | {
      kind: "internal";
      name: InternalName;
      argsMatch?: unknown[] | ((args: unknown[]) => boolean);
    }
  | {
      kind: "liveEvent";
      type: LiveEventType;
      payloadMatch?: Record<string, unknown> | ((payload: Record<string, unknown>) => boolean);
    };

interface MatchFailure {
  index: number;
  reason: string;
}

export interface MatchResult {
  pass: boolean;
  failures: MatchFailure[];
}

export function matchTraceSequence(
  trace: readonly TraceEvent[],
  expected: readonly TraceMatcher[],
): MatchResult {
  const failures: MatchFailure[] = [];

  if (trace.length !== expected.length) {
    failures.push({
      index: -1,
      reason: `length mismatch: expected ${expected.length} events, got ${trace.length}`,
    });
    return { pass: false, failures };
  }

  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const a = trace[i];

    if (e.kind !== a.kind) {
      failures.push({ index: i, reason: `kind mismatch: expected ${e.kind}, got ${a.kind}` });
      continue;
    }

    if (e.kind === "internal" && a.kind === "internal") {
      if (a.name !== e.name) {
        failures.push({
          index: i,
          reason: `internal name mismatch: expected "${String(e.name)}", got "${String(a.name)}"`,
        });
        continue;
      }
      if (e.argsMatch !== undefined) {
        if (typeof e.argsMatch === "function") {
          if (!e.argsMatch(a.args)) {
            failures.push({ index: i, reason: `internal:${String(e.name)} argsMatch predicate returned false` });
          }
        } else {
          for (let j = 0; j < e.argsMatch.length; j++) {
            if (!partialDeepMatch(a.args[j], e.argsMatch[j])) {
              failures.push({
                index: i,
                reason: `internal:${String(e.name)} args[${j}] partial mismatch (expected ⊆ actual failed)`,
              });
            }
          }
        }
      }
    } else if (e.kind === "liveEvent" && a.kind === "liveEvent") {
      if (a.type !== e.type) {
        failures.push({
          index: i,
          reason: `liveEvent type mismatch: expected "${e.type}", got "${a.type}"`,
        });
        continue;
      }
      if (e.payloadMatch !== undefined) {
        if (typeof e.payloadMatch === "function") {
          if (!e.payloadMatch(a.payload)) {
            failures.push({ index: i, reason: `liveEvent:${e.type} payloadMatch predicate returned false` });
          }
        } else if (!partialDeepMatch(a.payload, e.payloadMatch)) {
          failures.push({ index: i, reason: `liveEvent:${e.type} payload partial mismatch` });
        }
      }
    }
  }

  return { pass: failures.length === 0, failures };
}

// Partial deep match: every key in `expected` must equal (recursively, same partial rule)
// the corresponding key in `actual`. Arrays compare element-by-element with the same
// recursive rule and require equal length. Extra keys in `actual` are ignored — that's
// what makes this a "partial" match and why fixture assertions don't break on noise
// fields like timestamps or generated IDs.
function partialDeepMatch(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (expected === null || expected === undefined) return actual === expected;
  if (typeof expected !== "object") return actual === expected;
  if (actual === null || actual === undefined || typeof actual !== "object") return false;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (actual.length !== expected.length) return false;
    return expected.every((v, i) => partialDeepMatch(actual[i], v));
  }
  if (Array.isArray(actual)) return false;

  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (!partialDeepMatch((actual as Record<string, unknown>)[key], value)) return false;
  }
  return true;
}

function describeTrace(trace: readonly TraceEvent[]): string {
  return trace
    .map((ev, i) => {
      if (ev.kind === "internal") {
        const argsJson = safeJson(ev.args).slice(0, 120);
        return `  [${i}] internal:${String(ev.name)}(${argsJson})`;
      }
      const payloadJson = safeJson(ev.payload).slice(0, 120);
      return `  [${i}] liveEvent:${ev.type} ${payloadJson}`;
    })
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Date) return v.toISOString();
      return v;
    });
  } catch {
    return "[unserializable]";
  }
}

expect.extend({
  toMatchTraceSequence(received: unknown, expected: readonly TraceMatcher[]) {
    if (!Array.isArray(received)) {
      return {
        pass: false,
        message: () => `toMatchTraceSequence: received value is not an array (got ${typeof received})`,
      };
    }
    const result = matchTraceSequence(received as readonly TraceEvent[], expected);
    if (result.pass) {
      return {
        pass: true,
        message: () => "expected trace not to match sequence",
      };
    }
    return {
      pass: false,
      message: () => {
        const failureLines = result.failures
          .map((f) => `  [${f.index}] ${f.reason}`)
          .join("\n");
        const traceLines = describeTrace(received as readonly TraceEvent[]);
        return [
          "Trace did not match expected sequence.",
          "",
          "Failures:",
          failureLines,
          "",
          `Full received trace (${received.length} events):`,
          traceLines,
        ].join("\n");
      },
    };
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "vitest" {
  // Augmentation must mirror vitest's `interface Assertion<T = any>` generic
  // signature exactly (see @vitest/expect Assertion declaration). Using a
  // different default (e.g. `unknown`) trips TS2428.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    toMatchTraceSequence(expected: readonly TraceMatcher[]): T;
  }
  interface AsymmetricMatchersContaining {
    toMatchTraceSequence(expected: readonly TraceMatcher[]): unknown;
  }
}
