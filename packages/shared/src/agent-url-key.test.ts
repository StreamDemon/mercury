import { describe, expect, it } from "vitest";
import { deriveAgentUrlKey, isUuidLike, normalizeAgentUrlKey } from "./agent-url-key.js";

describe("normalizeAgentUrlKey (default — lowercase)", () => {
  it("lowercases and dash-collapses a typical name", () => {
    expect(normalizeAgentUrlKey("My Awesome Agent")).toBe("my-awesome-agent");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeAgentUrlKey("  spaced  ")).toBe("spaced");
  });

  it("collapses runs of non-alphanumerics to a single dash", () => {
    expect(normalizeAgentUrlKey("Special!!Chars##here")).toBe("special-chars-here");
  });

  it("strips leading and trailing dashes", () => {
    expect(normalizeAgentUrlKey("---leading-trailing---")).toBe("leading-trailing");
  });

  it("returns null for empty / whitespace-only / non-alphanumeric input", () => {
    expect(normalizeAgentUrlKey("")).toBeNull();
    expect(normalizeAgentUrlKey("   ")).toBeNull();
    expect(normalizeAgentUrlKey("!!!")).toBeNull();
  });

  it("returns null for null, undefined, and non-string values", () => {
    expect(normalizeAgentUrlKey(null)).toBeNull();
    expect(normalizeAgentUrlKey(undefined)).toBeNull();
    expect(normalizeAgentUrlKey(42 as unknown as string)).toBeNull();
  });
});

describe("normalizeAgentUrlKey (preserveCase)", () => {
  it("preserves casing on a single segment", () => {
    expect(normalizeAgentUrlKey("StreamDemon", { preserveCase: true })).toBe("StreamDemon");
  });

  it("preserves casing while still dash-collapsing non-alphanumerics", () => {
    expect(normalizeAgentUrlKey("My Awesome Skill", { preserveCase: true })).toBe("My-Awesome-Skill");
  });

  it("treats slash as a non-alphanumeric (callers split keys before normalizing per segment)", () => {
    expect(normalizeAgentUrlKey("Owner/Repo", { preserveCase: true })).toBe("Owner-Repo");
  });

  it("trims and strips leading/trailing dashes the same as default", () => {
    expect(normalizeAgentUrlKey("  ---MixedCase---  ", { preserveCase: true })).toBe("MixedCase");
  });

  it("returns null for empty / non-alphanumeric input", () => {
    expect(normalizeAgentUrlKey("", { preserveCase: true })).toBeNull();
    expect(normalizeAgentUrlKey("   ", { preserveCase: true })).toBeNull();
    expect(normalizeAgentUrlKey("!!!", { preserveCase: true })).toBeNull();
  });

  it("default option object behaves the same as omitting it", () => {
    expect(normalizeAgentUrlKey("My Agent", {})).toBe("my-agent");
    expect(normalizeAgentUrlKey("My Agent", { preserveCase: false })).toBe("my-agent");
  });
});

describe("deriveAgentUrlKey", () => {
  it("returns normalized name when present", () => {
    expect(deriveAgentUrlKey("My Agent")).toBe("my-agent");
  });

  it("falls back to normalized fallback when name is null", () => {
    expect(deriveAgentUrlKey(null, "Backup Name")).toBe("backup-name");
  });

  it("returns the literal 'agent' when both name and fallback are null", () => {
    expect(deriveAgentUrlKey(null, null)).toBe("agent");
    expect(deriveAgentUrlKey(undefined)).toBe("agent");
  });

  it("threads preserveCase through to both name and fallback", () => {
    expect(deriveAgentUrlKey("StreamDemon", null, { preserveCase: true })).toBe("StreamDemon");
    expect(deriveAgentUrlKey(null, "FallbackName", { preserveCase: true })).toBe("FallbackName");
  });
});

describe("isUuidLike", () => {
  it("recognizes a v4-shaped UUID", () => {
    expect(isUuidLike("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects non-UUID strings and non-strings", () => {
    expect(isUuidLike("not-a-uuid")).toBe(false);
    expect(isUuidLike("")).toBe(false);
    expect(isUuidLike(null)).toBe(false);
    expect(isUuidLike(undefined)).toBe(false);
  });
});
