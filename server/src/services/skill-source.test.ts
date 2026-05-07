import { describe, expect, it } from "vitest";
import {
  buildSkillRuntimeName,
  classifyInventoryKind,
  deriveCanonicalSkillKey,
  deriveImportedSkillSlug,
  deriveImportedSkillSource,
  deriveTrustLevel,
  hashSkillValue,
  normalizeGitHubSkillDirectory,
  normalizePortablePath,
  normalizeSkillKey,
  normalizeSkillSlug,
  parseSkillImportSourceInput,
  readCanonicalSkillKey,
  uniqueImportedSkillKey,
  uniqueSkillSlug,
} from "./skill-source.js";

describe("hashSkillValue", () => {
  it("returns 10 hex chars by default", () => {
    const hash = hashSkillValue("hello");
    expect(hash).toHaveLength(10);
    expect(hash).toMatch(/^[0-9a-f]{10}$/);
  });

  it("respects an explicit length", () => {
    expect(hashSkillValue("hello", 8)).toHaveLength(8);
    expect(hashSkillValue("hello", 16)).toHaveLength(16);
  });

  it("is deterministic for the same input + length", () => {
    expect(hashSkillValue("payload")).toBe(hashSkillValue("payload"));
    expect(hashSkillValue("payload", 8)).toBe(hashSkillValue("payload", 8));
  });
});

describe("normalizeSkillSlug / normalizeSkillKey", () => {
  it("preserves case on a single segment", () => {
    expect(normalizeSkillSlug("MyAwesomeSkill")).toBe("MyAwesomeSkill");
  });

  it("handles null/empty", () => {
    expect(normalizeSkillSlug(null)).toBeNull();
    expect(normalizeSkillSlug(undefined)).toBeNull();
    expect(normalizeSkillSlug("")).toBeNull();
  });

  it("preserves multi-segment keys", () => {
    expect(normalizeSkillKey("StreamDemon/mercury/mercury")).toBe("StreamDemon/mercury/mercury");
  });

  it("returns null for empty or all-separator keys", () => {
    expect(normalizeSkillKey("")).toBeNull();
    expect(normalizeSkillKey(null)).toBeNull();
    expect(normalizeSkillKey("///")).toBeNull();
  });
});

describe("normalizePortablePath", () => {
  it("normalizes backslashes and strips leading ./", () => {
    expect(normalizePortablePath(".\\skills\\foo\\SKILL.md")).toBe("skills/foo/SKILL.md");
  });

  it("collapses .. segments", () => {
    expect(normalizePortablePath("a/b/../c")).toBe("a/c");
  });

  it("strips leading slashes", () => {
    expect(normalizePortablePath("/a/b")).toBe("a/b");
  });
});

describe("normalizeGitHubSkillDirectory", () => {
  it("returns the directory when given a SKILL.md path", () => {
    expect(normalizeGitHubSkillDirectory("skills/foo/SKILL.md", "skills/fallback")).toBe("skills/foo");
  });

  it("returns the input directly when not a SKILL.md path", () => {
    expect(normalizeGitHubSkillDirectory("skills/foo", "skills/fallback")).toBe("skills/foo");
  });

  it("falls back when the input is empty", () => {
    expect(normalizeGitHubSkillDirectory(null, "skills/fallback")).toBe("skills/fallback");
    expect(normalizeGitHubSkillDirectory("", "skills/fallback")).toBe("skills/fallback");
  });
});

describe("uniqueSkillSlug", () => {
  it("returns the base when not used", () => {
    expect(uniqueSkillSlug("foo", new Set())).toBe("foo");
  });

  it("appends -2 on first collision", () => {
    expect(uniqueSkillSlug("foo", new Set(["foo"]))).toBe("foo-2");
  });

  it("walks past existing -2/-3 collisions", () => {
    expect(uniqueSkillSlug("foo", new Set(["foo", "foo-2", "foo-3"]))).toBe("foo-4");
  });
});

describe("uniqueImportedSkillKey", () => {
  it("uses company/<id>/<slug> namespace", () => {
    expect(uniqueImportedSkillKey("c1", "foo", new Set())).toBe("company/c1/foo");
  });

  it("appends -2 on collision", () => {
    expect(uniqueImportedSkillKey("c1", "foo", new Set(["company/c1/foo"]))).toBe("company/c1/foo-2");
  });
});

describe("buildSkillRuntimeName", () => {
  it("returns slug as-is for bundled Mercury keys", () => {
    expect(buildSkillRuntimeName("StreamDemon/mercury/mercury", "mercury")).toBe("mercury");
  });

  it("appends a hash for non-bundled keys", () => {
    const name = buildSkillRuntimeName("github.com/owner/repo/foo", "foo");
    expect(name).toMatch(/^foo--[0-9a-f]{10}$/);
  });
});

describe("readCanonicalSkillKey", () => {
  it("reads frontmatter.key first", () => {
    expect(readCanonicalSkillKey({ key: "Owner/Repo/Skill" }, null)).toBe("Owner/Repo/Skill");
  });

  it("falls back to metadata.skillKey", () => {
    expect(readCanonicalSkillKey({}, { skillKey: "Owner/Repo/Skill" })).toBe("Owner/Repo/Skill");
  });

  it("falls back to metadata.mercury.skillKey", () => {
    expect(readCanonicalSkillKey({}, { mercury: { skillKey: "Owner/Repo/Skill" } })).toBe("Owner/Repo/Skill");
  });

  it("returns null when no key sources are present", () => {
    expect(readCanonicalSkillKey({}, null)).toBeNull();
    expect(readCanonicalSkillKey({}, {})).toBeNull();
  });
});

describe("deriveCanonicalSkillKey", () => {
  it("returns the explicit canonical key when present", () => {
    expect(
      deriveCanonicalSkillKey("c1", {
        slug: "skill",
        sourceType: "github",
        sourceLocator: null,
        metadata: { skillKey: "Owner/Repo/Other" },
      }),
    ).toBe("Owner/Repo/Other");
  });

  it("returns StreamDemon/mercury/<slug> for mercury_bundled source kind", () => {
    expect(
      deriveCanonicalSkillKey("c1", {
        slug: "mercury",
        sourceType: "local_path",
        sourceLocator: null,
        metadata: { sourceKind: "mercury_bundled" },
      }),
    ).toBe("StreamDemon/mercury/mercury");
  });

  it("returns owner/repo/slug for github sources", () => {
    expect(
      deriveCanonicalSkillKey("c1", {
        slug: "my-skill",
        sourceType: "github",
        sourceLocator: "https://github.com/Owner/Repo",
        metadata: { owner: "Owner", repo: "Repo" },
      }),
    ).toBe("Owner/Repo/my-skill");
  });

  it("returns owner/repo/slug for skills_sh sources", () => {
    expect(
      deriveCanonicalSkillKey("c1", {
        slug: "my-skill",
        sourceType: "skills_sh",
        sourceLocator: "https://skills.sh/Owner/Repo/my-skill",
        metadata: { owner: "Owner", repo: "Repo" },
      }),
    ).toBe("Owner/Repo/my-skill");
  });

  it("returns url/<host>/<hash>/<slug> for valid url sources", () => {
    const key = deriveCanonicalSkillKey("c1", {
      slug: "my-skill",
      sourceType: "url",
      sourceLocator: "https://example.com/skill.md",
      metadata: null,
    });
    expect(key).toMatch(/^url\/example-com\/[0-9a-f]{10}\/my-skill$/);
  });

  it("returns url/unknown/<hash>/<slug> for unparsable url locators", () => {
    const key = deriveCanonicalSkillKey("c1", {
      slug: "my-skill",
      sourceType: "url",
      sourceLocator: "not-a-url",
      metadata: null,
    });
    expect(key).toMatch(/^url\/unknown\/[0-9a-f]{10}\/my-skill$/);
  });

  it("returns company/<id>/<slug> for managed_local local_path", () => {
    expect(
      deriveCanonicalSkillKey("c1", {
        slug: "my-skill",
        sourceType: "local_path",
        sourceLocator: "/some/path",
        metadata: { sourceKind: "managed_local" },
      }),
    ).toBe("company/c1/my-skill");
  });

  it("returns local/<hash>/<slug> for non-managed local_path", () => {
    const key = deriveCanonicalSkillKey("c1", {
      slug: "my-skill",
      sourceType: "local_path",
      sourceLocator: "/some/path",
      metadata: null,
    });
    expect(key).toMatch(/^local\/[0-9a-f]{10}\/my-skill$/);
  });

  it("falls back to company/<id>/<slug> when nothing else matches", () => {
    expect(
      deriveCanonicalSkillKey("c1", {
        slug: "my-skill",
        sourceType: "catalog",
        sourceLocator: null,
        metadata: null,
      }),
    ).toBe("company/c1/my-skill");
  });

  it("uses 'skill' as the slug fallback when slug is empty", () => {
    expect(
      deriveCanonicalSkillKey("c1", {
        slug: "",
        sourceType: "catalog",
        sourceLocator: null,
        metadata: null,
      }),
    ).toBe("company/c1/skill");
  });
});

describe("deriveImportedSkillSlug", () => {
  it("prefers frontmatter.slug", () => {
    expect(deriveImportedSkillSlug({ slug: "MySlug", name: "MyName" }, "fallback")).toBe("MySlug");
  });

  it("falls back to frontmatter.name", () => {
    expect(deriveImportedSkillSlug({ name: "MyName" }, "fallback")).toBe("MyName");
  });

  it("falls back to the fallback parameter", () => {
    expect(deriveImportedSkillSlug({}, "MyFallback")).toBe("MyFallback");
  });

  it("returns 'skill' when nothing usable is provided", () => {
    expect(deriveImportedSkillSlug({}, "")).toBe("skill");
  });
});

describe("deriveImportedSkillSource", () => {
  it("returns a github descriptor for github-dir source kind", () => {
    const source = deriveImportedSkillSource(
      {
        metadata: {
          sources: [{
            kind: "github-dir",
            repo: "Owner/Repo",
            path: "skills/my-skill",
            commit: "abc123",
            trackingRef: "main",
          }],
        },
      },
      "fallback",
    );
    expect(source.sourceType).toBe("github");
    expect(source.sourceLocator).toBe("https://github.com/Owner/Repo/tree/main/skills/my-skill");
    expect(source.sourceRef).toBe("abc123");
    expect(source.metadata?.sourceKind).toBe("github");
    expect(source.metadata?.owner).toBe("Owner");
    expect(source.metadata?.repo).toBe("Repo");
  });

  it("returns a github descriptor for github-file source kind", () => {
    const source = deriveImportedSkillSource(
      {
        metadata: {
          sources: [{ kind: "github-file", repo: "Owner/Repo", path: "skills/my-skill/SKILL.md" }],
        },
      },
      "fallback",
    );
    expect(source.sourceType).toBe("github");
    expect(source.metadata?.repoSkillDir).toBe("skills/my-skill/SKILL.md");
  });

  it("preserves a non-default hostname in metadata", () => {
    const source = deriveImportedSkillSource(
      {
        metadata: {
          sources: [{ kind: "github-dir", repo: "Owner/Repo", hostname: "ghe.example.com" }],
        },
      },
      "fallback",
    );
    expect(source.metadata?.hostname).toBe("ghe.example.com");
  });

  it("returns a url descriptor for url source kind", () => {
    const source = deriveImportedSkillSource(
      { metadata: { sources: [{ kind: "url", url: "https://example.com/SKILL.md" }] } },
      "fallback",
    );
    expect(source.sourceType).toBe("url");
    expect(source.sourceLocator).toBe("https://example.com/SKILL.md");
    expect(source.metadata?.sourceKind).toBe("url");
  });

  it("falls back to catalog when source kind is unknown", () => {
    const source = deriveImportedSkillSource({}, "fallback");
    expect(source.sourceType).toBe("catalog");
    expect(source.sourceLocator).toBeNull();
    expect(source.metadata?.sourceKind).toBe("catalog");
  });

  it("propagates an explicit canonical key into metadata", () => {
    const source = deriveImportedSkillSource(
      { key: "Owner/Repo/Skill" },
      "fallback",
    );
    expect(source.metadata?.skillKey).toBe("Owner/Repo/Skill");
  });
});

describe("classifyInventoryKind", () => {
  it("classifies skill, reference, script, asset, and markdown directories", () => {
    expect(classifyInventoryKind("SKILL.md")).toBe("skill");
    expect(classifyInventoryKind("nested/SKILL.md")).toBe("skill");
    expect(classifyInventoryKind("references/foo.md")).toBe("reference");
    expect(classifyInventoryKind("scripts/foo.sh")).toBe("script");
    expect(classifyInventoryKind("assets/foo.png")).toBe("asset");
    expect(classifyInventoryKind("notes.md")).toBe("markdown");
  });

  it("classifies by file extension as a fallback", () => {
    expect(classifyInventoryKind("foo.py")).toBe("script");
    expect(classifyInventoryKind("foo.png")).toBe("asset");
    expect(classifyInventoryKind("foo.unknown")).toBe("other");
  });
});

describe("deriveTrustLevel", () => {
  it("returns scripts_executables when any script is present", () => {
    expect(deriveTrustLevel([
      { path: "SKILL.md", kind: "skill" },
      { path: "scripts/run.sh", kind: "script" },
    ])).toBe("scripts_executables");
  });

  it("returns assets when assets/other are present without scripts", () => {
    expect(deriveTrustLevel([
      { path: "SKILL.md", kind: "skill" },
      { path: "assets/icon.png", kind: "asset" },
    ])).toBe("assets");
  });

  it("returns markdown_only when only markdown content is present", () => {
    expect(deriveTrustLevel([
      { path: "SKILL.md", kind: "skill" },
      { path: "notes.md", kind: "markdown" },
    ])).toBe("markdown_only");
  });
});

describe("parseSkillImportSourceInput", () => {
  it("parses an org/repo/skill key as skills.sh", () => {
    const parsed = parseSkillImportSourceInput("Owner/Repo/my-skill");
    expect(parsed.resolvedSource).toBe("https://github.com/Owner/Repo");
    expect(parsed.requestedSkillSlug).toBe("my-skill");
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/Owner/Repo/my-skill");
  });

  it("parses an org/repo shorthand as plain GitHub", () => {
    const parsed = parseSkillImportSourceInput("Owner/Repo");
    expect(parsed.resolvedSource).toBe("https://github.com/Owner/Repo");
    expect(parsed.requestedSkillSlug).toBeNull();
    expect(parsed.originalSkillsShUrl).toBeNull();
  });

  it("recognizes a skills.sh URL", () => {
    const parsed = parseSkillImportSourceInput("https://skills.sh/Owner/Repo/my-skill");
    expect(parsed.resolvedSource).toBe("https://github.com/Owner/Repo");
    expect(parsed.requestedSkillSlug).toBe("my-skill");
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/Owner/Repo/my-skill");
  });

  it("returns the URL as-is when it is not a recognized shorthand", () => {
    const parsed = parseSkillImportSourceInput("https://example.com/skill.md");
    expect(parsed.resolvedSource).toBe("https://example.com/skill.md");
    expect(parsed.requestedSkillSlug).toBeNull();
  });

  it("parses an `npx skills add <repo> --skill <slug>` invocation", () => {
    const parsed = parseSkillImportSourceInput('npx skills add "Owner/Repo" --skill my-skill');
    expect(parsed.resolvedSource).toBe("https://github.com/Owner/Repo");
    expect(parsed.requestedSkillSlug).toBe("my-skill");
  });

  it("parses --skill=<slug> equals syntax", () => {
    const parsed = parseSkillImportSourceInput("npx skills add Owner/Repo --skill=my-skill");
    expect(parsed.requestedSkillSlug).toBe("my-skill");
  });

  it("throws on empty input", () => {
    expect(() => parseSkillImportSourceInput("")).toThrow();
    expect(() => parseSkillImportSourceInput("   ")).toThrow();
  });
});
