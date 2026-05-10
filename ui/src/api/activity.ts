import type { ActivityEvent } from "@mercuryai/shared";
import { issueForRunSchema, runForIssueSchema } from "@mercuryai/shared";
import { api } from "./client";

export type { IssueForRun, RunForIssue, RunLivenessState } from "@mercuryai/shared";

export const activityApi = {
  list: (companyId: string, filters?: { entityType?: string; entityId?: string; agentId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<ActivityEvent[]>(`/companies/${companyId}/activity${qs ? `?${qs}` : ""}`);
  },
  forIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity`),
  runsForIssue: (issueId: string) => api.get(`/issues/${issueId}/runs`, runForIssueSchema.array()),
  issuesForRun: (runId: string) => api.get(`/heartbeat-runs/${runId}/issues`, issueForRunSchema.array()),
};
