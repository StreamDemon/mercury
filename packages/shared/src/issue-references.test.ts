import { describe, expect, it } from "vitest";
import {
  buildIssueReferenceHref,
  extractIssueReferenceIdentifiers,
  findIssueReferenceMatches,
  normalizeIssueIdentifier,
  parseIssueReferenceHref,
} from "./issue-references.js";

describe("issue references", () => {
  it("normalizes identifiers to uppercase", () => {
    expect(normalizeIssueIdentifier("merc-123")).toBe("MERC-123");
    expect(normalizeIssueIdentifier("not-an-issue")).toBeNull();
  });

  it("parses relative and absolute issue hrefs", () => {
    expect(parseIssueReferenceHref("/issues/MERC-123")).toEqual({ identifier: "MERC-123" });
    expect(parseIssueReferenceHref("/PAP/issues/merc-456")).toEqual({ identifier: "MERC-456" });
    expect(parseIssueReferenceHref("https://modernmethod.io/mercury/PAP/issues/merc-789#comment-1")).toEqual({
      identifier: "MERC-789",
    });
    expect(parseIssueReferenceHref("https://modernmethod.io/mercury/projects/MERC-789")).toBeNull();
  });

  it("builds canonical issue hrefs", () => {
    expect(buildIssueReferenceHref("merc-123")).toBe("/issues/MERC-123");
  });

  it("finds identifiers and issue paths in plain text", () => {
    expect(findIssueReferenceMatches("See MERC-1, /issues/MERC-2, and https://x.test/PAP/issues/merc-3.")).toEqual([
      { index: 4, length: 6, identifier: "MERC-1", matchedText: "MERC-1" },
      { index: 12, length: 14, identifier: "MERC-2", matchedText: "/issues/MERC-2" },
      {
        index: 32,
        length: 32,
        identifier: "MERC-3",
        matchedText: "https://x.test/PAP/issues/merc-3",
      },
    ]);
  });

  it("trims unmatched square brackets from issue path tokens", () => {
    expect(findIssueReferenceMatches("See /issues/MERC-123] for context.")).toEqual([
      { index: 4, length: 16, identifier: "MERC-123", matchedText: "/issues/MERC-123" },
    ]);
  });

  it("extracts and dedupes references from markdown", () => {
    expect(extractIssueReferenceIdentifiers("MERC-1 [again](/issues/merc-1) MERC-2")).toEqual(["MERC-1", "MERC-2"]);
  });

  it("ignores inline code and fenced code blocks", () => {
    const markdown = [
      "Use MERC-1 here.",
      "",
      "`MERC-2` should not count.",
      "",
      "```md",
      "MERC-3",
      "/issues/MERC-4",
      "```",
      "",
      "Final /issues/MERC-5 mention.",
    ].join("\n");

    expect(extractIssueReferenceIdentifiers(markdown)).toEqual(["MERC-1", "MERC-5"]);
  });
});
