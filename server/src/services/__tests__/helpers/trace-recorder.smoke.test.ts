// Smoke test for trace-recorder mechanics (wince #3 Track B Phase 1 — PR B).
//
// Validates the recorder infrastructure in isolation: spy installation/disposal,
// live-event subscription, monotonic sequencing across both streams, and the
// toMatchTraceSequence matcher's pass/fail behavior. Does NOT spin up embedded
// Postgres or the real heartbeat service — that integration is exercised by the
// F1 happy-path fixture in PR C.

import { describe, expect, it } from "vitest";

import { publishLiveEvent } from "../../live-events.js";
import {
  createTraceRecorder,
  matchTraceSequence,
  type TraceEvent,
  type TraceMatcher,
} from "./trace-recorder.js";

function makeFakeHeartbeat() {
  // Minimal stand-in: only the surfaces createTraceRecorder reads on construction
  // or via the returned helpers. The smoke does not call getDbSnapshot or
  // waitForRunSettled, so db / getRun shapes can stay narrow.
  const calls: string[] = [];
  const internals = {
    setRunStatus: async (...args: unknown[]) => {
      calls.push(`setRunStatus:${JSON.stringify(args)}`);
      return "original-result" as unknown;
    },
    appendRunEvent: async (...args: unknown[]) => {
      calls.push(`appendRunEvent:${JSON.stringify(args)}`);
      return undefined;
    },
  };
  const heartbeat = {
    __internalsForTests: internals,
    // Unused by these smoke cases, but keeps the type shape close enough that
    // createTraceRecorder's options check accepts it.
    getRun: async () => null,
  };
  return { heartbeat, internals, calls };
}

describe("trace-recorder smoke", () => {
  it("records internal-spy calls in order with monotonic sequence indices", async () => {
    const { heartbeat, calls } = makeFakeHeartbeat();
    const recorder = createTraceRecorder({
      db: {} as never,
      heartbeat: heartbeat as never,
      companyId: "company-smoke-1",
    });

    await heartbeat.__internalsForTests.setRunStatus("run-1", "running");
    await heartbeat.__internalsForTests.appendRunEvent({ id: "run-1" }, 1, { eventType: "lifecycle" });

    const trace = recorder.getOrderedTrace();
    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({ kind: "internal", name: "setRunStatus", at: 0 });
    expect(trace[1]).toMatchObject({ kind: "internal", name: "appendRunEvent", at: 1 });

    // Originals were still invoked — wrapper is transparent.
    expect(calls).toEqual([
      'setRunStatus:["run-1","running"]',
      'appendRunEvent:[{"id":"run-1"},1,{"eventType":"lifecycle"}]',
    ]);

    recorder.dispose();
  });

  it("records live events from publishLiveEvent into the same ordered stream", async () => {
    const { heartbeat } = makeFakeHeartbeat();
    const companyId = "company-smoke-2";
    const recorder = createTraceRecorder({
      db: {} as never,
      heartbeat: heartbeat as never,
      companyId,
    });

    await heartbeat.__internalsForTests.setRunStatus("run-2", "running");
    publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: { runId: "run-2", status: "running" } });
    await heartbeat.__internalsForTests.appendRunEvent({ id: "run-2" }, 1, { eventType: "lifecycle" });

    const trace = recorder.getOrderedTrace();
    expect(trace).toHaveLength(3);
    expect(trace[0]).toMatchObject({ kind: "internal", name: "setRunStatus" });
    expect(trace[1]).toMatchObject({
      kind: "liveEvent",
      type: "heartbeat.run.status",
      payload: { runId: "run-2", status: "running" },
    });
    expect(trace[2]).toMatchObject({ kind: "internal", name: "appendRunEvent" });
    expect(trace.map((e) => e.at)).toEqual([0, 1, 2]);

    recorder.dispose();
  });

  it("ignores live events for other companies", () => {
    const { heartbeat } = makeFakeHeartbeat();
    const recorder = createTraceRecorder({
      db: {} as never,
      heartbeat: heartbeat as never,
      companyId: "company-smoke-3",
    });

    publishLiveEvent({ companyId: "other-company", type: "heartbeat.run.status", payload: {} });
    publishLiveEvent({ companyId: "company-smoke-3", type: "heartbeat.run.event", payload: { seq: 5 } });

    const trace = recorder.getOrderedTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ kind: "liveEvent", type: "heartbeat.run.event" });

    recorder.dispose();
  });

  it("dispose() restores originals and stops recording further events", async () => {
    const { heartbeat, calls, internals } = makeFakeHeartbeat();
    const originalSetRunStatus = internals.setRunStatus;
    const companyId = "company-smoke-4";
    const recorder = createTraceRecorder({
      db: {} as never,
      heartbeat: heartbeat as never,
      companyId,
    });

    // While installed, the reference is the wrapper, not the original.
    expect(internals.setRunStatus).not.toBe(originalSetRunStatus);

    await heartbeat.__internalsForTests.setRunStatus("run-3", "running");
    expect(recorder.getOrderedTrace()).toHaveLength(1);

    recorder.dispose();

    // After dispose, the original reference is restored…
    expect(internals.setRunStatus).toBe(originalSetRunStatus);

    // …and post-dispose calls do not get recorded.
    await internals.setRunStatus("run-3", "succeeded");
    publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: {} });
    expect(recorder.getOrderedTrace()).toHaveLength(1);

    // Originals invoked both before and after dispose:
    expect(calls).toContain('setRunStatus:["run-3","running"]');
    expect(calls).toContain('setRunStatus:["run-3","succeeded"]');
  });

  it("dispose() is idempotent — second call is a no-op", () => {
    const { heartbeat } = makeFakeHeartbeat();
    const recorder = createTraceRecorder({
      db: {} as never,
      heartbeat: heartbeat as never,
      companyId: "company-smoke-5",
    });

    expect(() => {
      recorder.dispose();
      recorder.dispose();
    }).not.toThrow();
  });

  it("throws if heartbeat handle lacks __internalsForTests", () => {
    expect(() =>
      createTraceRecorder({
        db: {} as never,
        heartbeat: { getRun: async () => null } as never,
        companyId: "c",
      }),
    ).toThrow(/__internalsForTests/);
  });
});

describe("matchTraceSequence", () => {
  const internalEvent = (name: string, args: unknown[] = [], at = 0): TraceEvent => ({
    kind: "internal",
    name: name as never,
    args,
    at,
  });
  const liveEventEv = (type: string, payload: Record<string, unknown> = {}, at = 0): TraceEvent => ({
    kind: "liveEvent",
    type: type as never,
    payload,
    at,
  });

  it("passes on exact-shape sequence with no matchers", () => {
    const trace = [internalEvent("setRunStatus", ["run-1", "running"], 0), liveEventEv("heartbeat.run.status", {}, 1)];
    const expected: TraceMatcher[] = [
      { kind: "internal", name: "setRunStatus" as never },
      { kind: "liveEvent", type: "heartbeat.run.status" as never },
    ];
    expect(matchTraceSequence(trace, expected)).toEqual({ pass: true, failures: [] });
  });

  it("fails on length mismatch", () => {
    const result = matchTraceSequence([], [{ kind: "internal", name: "setRunStatus" as never }]);
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/length mismatch/);
  });

  it("fails on kind mismatch at a specific index", () => {
    const trace = [internalEvent("setRunStatus", [], 0)];
    const result = matchTraceSequence(trace, [{ kind: "liveEvent", type: "heartbeat.run.status" as never }]);
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.index).toBe(0);
    expect(result.failures[0]?.reason).toMatch(/kind mismatch/);
  });

  it("fails on internal name mismatch", () => {
    const trace = [internalEvent("setRunStatus", [], 0)];
    const result = matchTraceSequence(trace, [{ kind: "internal", name: "appendRunEvent" as never }]);
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/name mismatch/);
  });

  it("argsMatch as object array does partial deep matching per arg", () => {
    const trace = [internalEvent("setRunStatus", ["run-1", "running", { error: null, extra: "noise" }], 0)];
    const expected: TraceMatcher[] = [
      {
        kind: "internal",
        name: "setRunStatus" as never,
        argsMatch: ["run-1", "running", { error: null }],
      },
    ];
    expect(matchTraceSequence(trace, expected).pass).toBe(true);
  });

  it("argsMatch detects partial mismatches", () => {
    const trace = [internalEvent("setRunStatus", ["run-1", "failed", { error: "boom" }], 0)];
    const expected: TraceMatcher[] = [
      {
        kind: "internal",
        name: "setRunStatus" as never,
        argsMatch: ["run-1", "succeeded"],
      },
    ];
    const result = matchTraceSequence(trace, expected);
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/args\[1\] partial mismatch/);
  });

  it("argsMatch predicate form gets the raw args array", () => {
    const trace = [internalEvent("setRunStatus", ["run-1", "running"], 0)];
    const seen: unknown[][] = [];
    const expected: TraceMatcher[] = [
      {
        kind: "internal",
        name: "setRunStatus" as never,
        argsMatch: (args) => {
          seen.push(args);
          return args.length === 2;
        },
      },
    ];
    expect(matchTraceSequence(trace, expected).pass).toBe(true);
    expect(seen).toEqual([["run-1", "running"]]);
  });

  it("payloadMatch as object does partial deep matching", () => {
    const trace = [liveEventEv("heartbeat.run.status", { runId: "r1", status: "running", noise: 42 }, 0)];
    const expected: TraceMatcher[] = [
      {
        kind: "liveEvent",
        type: "heartbeat.run.status" as never,
        payloadMatch: { status: "running" },
      },
    ];
    expect(matchTraceSequence(trace, expected).pass).toBe(true);
  });

  it("ignores extra keys in actual but flags missing keys", () => {
    const trace = [liveEventEv("heartbeat.run.status", { runId: "r1" }, 0)];
    const expected: TraceMatcher[] = [
      {
        kind: "liveEvent",
        type: "heartbeat.run.status" as never,
        payloadMatch: { runId: "r1", status: "running" },
      },
    ];
    const result = matchTraceSequence(trace, expected);
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/payload partial mismatch/);
  });

  it("toMatchTraceSequence vitest matcher integrates", () => {
    const trace = [internalEvent("setRunStatus", ["run-1", "running"], 0)];
    expect(trace).toMatchTraceSequence([{ kind: "internal", name: "setRunStatus" as never }]);
  });

  it("toMatchTraceSequence vitest matcher fails readably", () => {
    const trace = [internalEvent("setRunStatus", ["run-1", "running"], 0)];
    expect(() => {
      expect(trace).toMatchTraceSequence([{ kind: "internal", name: "appendRunEvent" as never }]);
    }).toThrow(/Trace did not match expected sequence/);
  });
});
