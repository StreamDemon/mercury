import { z } from "zod";
import {
  HEARTBEAT_RUN_STATUSES,
  RUN_LIVENESS_STATES,
  ISSUE_STATUSES,
  ISSUE_PRIORITIES,
} from "../constants.js";

export const environmentLeaseSummarySchema = z.object({
  id: z.string(),
  status: z.string(),
  leasePolicy: z.string(),
  provider: z.string().nullable(),
  providerLeaseId: z.string().nullable(),
  executionWorkspaceId: z.string().nullable(),
  workspacePath: z.string().nullable(),
  failureReason: z.string().nullable(),
  cleanupStatus: z.string().nullable(),
  acquiredAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable(),
});
export type EnvironmentLeaseSummary = z.infer<typeof environmentLeaseSummarySchema>;

export const runForIssueSchema = z.object({
  runId: z.string(),
  status: z.enum(HEARTBEAT_RUN_STATUSES),
  agentId: z.string(),
  adapterType: z.string(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  invocationSource: z.string(),
  // JSON-blob columns stay LOOSE — server may serialize various shapes; goal
  // is rename detection, not full validation.
  usageJson: z.record(z.unknown()).nullable(),
  resultJson: z.record(z.unknown()).nullable(),
  logBytes: z.number().int().nullable().optional(),
  retryOfRunId: z.string().nullable().optional(),
  scheduledRetryAt: z.string().datetime().nullable().optional(),
  scheduledRetryAttempt: z.number().int().optional(),
  scheduledRetryReason: z.string().nullable().optional(),
  retryExhaustedReason: z.string().nullable().optional(),
  livenessState: z.enum(RUN_LIVENESS_STATES).nullable().optional(),
  livenessReason: z.string().nullable().optional(),
  continuationAttempt: z.number().int().optional(),
  lastUsefulActionAt: z.string().datetime().nullable().optional(),
  nextAction: z.string().nullable().optional(),
  contextSnapshot: z.record(z.unknown()).nullable().optional(),
  environment: z
    .object({
      id: z.string(),
      name: z.string(),
      driver: z.string(),
    })
    .nullable()
    .optional(),
  environmentLease: environmentLeaseSummarySchema.nullable().optional(),
});
export type RunForIssue = z.infer<typeof runForIssueSchema>;

export const issueForRunSchema = z.object({
  issueId: z.string(),
  identifier: z.string().nullable(),
  title: z.string(),
  status: z.enum(ISSUE_STATUSES),
  priority: z.enum(ISSUE_PRIORITIES),
});
export type IssueForRun = z.infer<typeof issueForRunSchema>;
