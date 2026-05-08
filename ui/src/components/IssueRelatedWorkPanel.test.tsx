import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IssueRelatedWorkPanel } from "./IssueRelatedWorkPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

describe("IssueRelatedWorkPanel", () => {
  it("renders outbound and inbound related work with source labels", () => {
    const html = renderToStaticMarkup(
      <IssueRelatedWorkPanel
        relatedWork={{
          outbound: [
            {
              issue: {
                id: "issue-2",
                identifier: "MERC-22",
                title: "Downstream task",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 2,
              sources: [
                { kind: "title", sourceRecordId: null, label: "title", matchedText: "MERC-22" },
                { kind: "document", sourceRecordId: "doc-1", label: "plan", matchedText: "/issues/MERC-22" },
              ],
            },
          ],
          inbound: [
            {
              issue: {
                id: "issue-3",
                identifier: "MERC-33",
                title: "Upstream task",
                status: "in_progress",
                priority: "high",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [
                { kind: "comment", sourceRecordId: "comment-1", label: "comment", matchedText: "MERC-1" },
              ],
            },
          ],
        }}
      />,
    );

    expect(html).toContain("References");
    expect(html).toContain("Referenced by");
    expect(html).toContain("MERC-22");
    expect(html).toContain("MERC-33");
    expect(html).toContain('aria-label="Issue MERC-22: Downstream task"');
    expect(html).toContain('aria-label="Issue MERC-33: Upstream task"');
    expect(html).toContain("plan");
    expect(html).toContain("comment");
  });

  it("collapses duplicate source labels into a single chip with a count", () => {
    const html = renderToStaticMarkup(
      <IssueRelatedWorkPanel
        relatedWork={{
          outbound: [],
          inbound: [
            {
              issue: {
                id: "issue-4",
                identifier: "MERC-44",
                title: "Chatty inbound",
                status: "in_progress",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 3,
              sources: [
                { kind: "comment", sourceRecordId: "c1", label: "comment", matchedText: "MERC-44 first" },
                { kind: "comment", sourceRecordId: "c2", label: "comment", matchedText: "MERC-44 second" },
                { kind: "comment", sourceRecordId: "c3", label: "comment", matchedText: "MERC-44 third" },
              ],
            },
          ],
        }}
      />,
    );

    const commentMatches = html.match(/>comment</g) ?? [];
    expect(commentMatches).toHaveLength(1);
    expect(html).toContain("×3");
  });
});
