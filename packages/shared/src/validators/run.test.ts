import { describe, expect, it } from "vitest";
import {
  environmentLeaseSummarySchema,
  issueForRunSchema,
  runForIssueSchema,
} from "./run.js";

const validLease = {
  id: "lease-1",
  status: "active",
  leasePolicy: "exclusive",
  provider: "local",
  providerLeaseId: "prv-1",
  executionWorkspaceId: "ws-1",
  workspacePath: "/tmp/work",
  failureReason: null,
  cleanupStatus: null,
  acquiredAt: "2026-05-10T12:00:00.000Z",
  releasedAt: null,
};

const minimalRun = {
  runId: "run-1",
  status: "succeeded" as const,
  agentId: "agent-1",
  adapterType: "claude_local",
  startedAt: "2026-05-10T11:00:00.000Z",
  finishedAt: "2026-05-10T11:30:00.000Z",
  createdAt: "2026-05-10T10:55:00.000Z",
  invocationSource: "manual",
  usageJson: { tokens: 1234 },
  resultJson: null,
};

describe("runForIssueSchema", () => {
  it("accepts a minimal happy-path run with only required fields", () => {
    const parsed = runForIssueSchema.parse(minimalRun);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.environment).toBeUndefined();
    expect(parsed.environmentLease).toBeUndefined();
  });

  it("accepts a run with all optionals populated", () => {
    const parsed = runForIssueSchema.parse({
      ...minimalRun,
      logBytes: 4096,
      retryOfRunId: "run-0",
      scheduledRetryAt: "2026-05-10T12:30:00.000Z",
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient",
      retryExhaustedReason: null,
      livenessState: "completed",
      livenessReason: null,
      continuationAttempt: 1,
      lastUsefulActionAt: "2026-05-10T11:25:00.000Z",
      nextAction: "review",
      contextSnapshot: { foo: { bar: 1 } },
      environment: { id: "env-1", name: "local", driver: "local" },
      environmentLease: validLease,
    });
    expect(parsed.environmentLease?.id).toBe("lease-1");
    expect(parsed.environment?.driver).toBe("local");
  });

  it("accepts environmentLease explicitly null", () => {
    const parsed = runForIssueSchema.parse({
      ...minimalRun,
      environmentLease: null,
    });
    expect(parsed.environmentLease).toBeNull();
  });

  it("accepts environmentLease populated", () => {
    const parsed = runForIssueSchema.parse({
      ...minimalRun,
      environmentLease: validLease,
    });
    expect(parsed.environmentLease?.status).toBe("active");
  });

  it("rejects an invalid livenessState enum value", () => {
    const result = runForIssueSchema.safeParse({
      ...minimalRun,
      livenessState: "vibing",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status enum value", () => {
    const result = runForIssueSchema.safeParse({
      ...minimalRun,
      status: "totally-made-up",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO date string for createdAt", () => {
    const result = runForIssueSchema.safeParse({
      ...minimalRun,
      createdAt: "not a date",
    });
    expect(result.success).toBe(false);
  });

  it("accepts arbitrary nested usageJson shapes including empty object", () => {
    const empty = runForIssueSchema.parse({ ...minimalRun, usageJson: {} });
    expect(empty.usageJson).toEqual({});

    const nested = runForIssueSchema.parse({
      ...minimalRun,
      usageJson: { input: { tokens: 100 }, output: { tokens: 50 } },
    });
    expect(nested.usageJson).toEqual({
      input: { tokens: 100 },
      output: { tokens: 50 },
    });
  });

  it("accepts usageJson explicitly null", () => {
    const parsed = runForIssueSchema.parse({ ...minimalRun, usageJson: null });
    expect(parsed.usageJson).toBeNull();
  });
});

describe("issueForRunSchema", () => {
  it("accepts a happy-path issue summary", () => {
    const parsed = issueForRunSchema.parse({
      issueId: "issue-1",
      identifier: "MER-42",
      title: "Ship slice 1A",
      status: "in_progress",
      priority: "high",
    });
    expect(parsed.identifier).toBe("MER-42");
  });

  it("accepts a null identifier", () => {
    const parsed = issueForRunSchema.parse({
      issueId: "issue-1",
      identifier: null,
      title: "No identifier",
      status: "todo",
      priority: "medium",
    });
    expect(parsed.identifier).toBeNull();
  });

  it("rejects an invalid priority value", () => {
    const result = issueForRunSchema.safeParse({
      issueId: "issue-1",
      identifier: null,
      title: "Bad priority",
      status: "todo",
      priority: "urgent",
    });
    expect(result.success).toBe(false);
  });
});

describe("environmentLeaseSummarySchema", () => {
  it("round-trips a valid lease summary", () => {
    const parsed = environmentLeaseSummarySchema.parse(validLease);
    expect(parsed).toEqual(validLease);
  });

  it("accepts a released lease (releasedAt populated)", () => {
    const parsed = environmentLeaseSummarySchema.parse({
      ...validLease,
      releasedAt: "2026-05-10T13:00:00.000Z",
    });
    expect(parsed.releasedAt).toBe("2026-05-10T13:00:00.000Z");
  });
});
