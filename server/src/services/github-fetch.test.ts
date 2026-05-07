import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchJson,
  fetchOptionalText,
  parseCompanyPackageGitHubUrl,
  parseSkillSourceGitHubUrl,
  resolveGitHubPinnedRef,
  type SkillSourceGitHubSource,
} from "./github-fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── parseCompanyPackageGitHubUrl ──────────────────────────────────────────
// First two tests ported verbatim from server/src/__tests__/company-portability.test.ts:393–419
// to keep the existing assertions as a behavior pin.

describe("parseCompanyPackageGitHubUrl", () => {
  it("parses canonical GitHub import URLs with explicit ref and package path", () => {
    expect(
      parseCompanyPackageGitHubUrl(
        "https://github.com/StreamDemon/companies?ref=feature%2Fdemo&path=gstack",
      ),
    ).toEqual({
      hostname: "github.com",
      owner: "StreamDemon",
      repo: "companies",
      ref: "feature/demo",
      basePath: "gstack",
      companyPath: "gstack/COMPANY.md",
    });
  });

  it("parses canonical GitHub import URLs with explicit companyPath", () => {
    expect(
      parseCompanyPackageGitHubUrl(
        "https://github.com/StreamDemon/companies?ref=abc123&companyPath=gstack%2FCOMPANY.md",
      ),
    ).toEqual({
      hostname: "github.com",
      owner: "StreamDemon",
      repo: "companies",
      ref: "abc123",
      basePath: "gstack",
      companyPath: "gstack/COMPANY.md",
    });
  });

  it("parses /tree/<ref>/<dir> path-segment URLs", () => {
    expect(
      parseCompanyPackageGitHubUrl("https://github.com/StreamDemon/companies/tree/main/gstack"),
    ).toEqual({
      hostname: "github.com",
      owner: "StreamDemon",
      repo: "companies",
      ref: "main",
      basePath: "gstack",
      companyPath: "COMPANY.md",
    });
  });

  it("parses /blob/<ref>/<file> path-segment URLs and derives basePath", () => {
    expect(
      parseCompanyPackageGitHubUrl(
        "https://github.com/StreamDemon/companies/blob/main/gstack/COMPANY.md",
      ),
    ).toEqual({
      hostname: "github.com",
      owner: "StreamDemon",
      repo: "companies",
      ref: "main",
      basePath: "gstack",
      companyPath: "gstack/COMPANY.md",
    });
  });

  it("rejects non-https URLs", () => {
    expect(() => parseCompanyPackageGitHubUrl("http://github.com/foo/bar")).toThrow(
      /must use HTTPS/i,
    );
  });

  it("rejects URLs without an owner/repo", () => {
    expect(() => parseCompanyPackageGitHubUrl("https://github.com/foo")).toThrow(/Invalid GitHub URL/);
  });

  it("rejects /blob/<ref>/ with no file path", () => {
    expect(() =>
      parseCompanyPackageGitHubUrl("https://github.com/StreamDemon/companies/blob/main/"),
    ).toThrow(/Invalid GitHub blob URL/);
  });
});

// ─── parseSkillSourceGitHubUrl ─────────────────────────────────────────────

describe("parseSkillSourceGitHubUrl", () => {
  it("parses a repo root URL with no path (filePath null, explicitRef false)", () => {
    expect(parseSkillSourceGitHubUrl("https://github.com/StreamDemon/mercury")).toEqual({
      hostname: "github.com",
      owner: "StreamDemon",
      repo: "mercury",
      ref: "main",
      basePath: "",
      filePath: null,
      explicitRef: false,
    });
  });

  it("parses /tree/<ref>/<dir> as a directory of skills", () => {
    expect(
      parseSkillSourceGitHubUrl("https://github.com/StreamDemon/mercury/tree/main/skills"),
    ).toEqual({
      hostname: "github.com",
      owner: "StreamDemon",
      repo: "mercury",
      ref: "main",
      basePath: "skills",
      filePath: null,
      explicitRef: true,
    });
  });

  it("parses /blob/<ref>/<file> as a single skill file with derived basePath", () => {
    expect(
      parseSkillSourceGitHubUrl(
        "https://github.com/StreamDemon/mercury/blob/main/skills/my/SKILL.md",
      ),
    ).toEqual({
      hostname: "github.com",
      owner: "StreamDemon",
      repo: "mercury",
      ref: "main",
      basePath: "skills/my",
      filePath: "skills/my/SKILL.md",
      explicitRef: true,
    });
  });

  it("strips a .git suffix from the repo segment", () => {
    expect(parseSkillSourceGitHubUrl("https://github.com/StreamDemon/mercury.git")).toMatchObject({
      repo: "mercury",
    });
  });

  it("rejects non-https URLs", () => {
    expect(() => parseSkillSourceGitHubUrl("http://github.com/foo/bar")).toThrow(/must use HTTPS/i);
  });
});

// ─── fetchOptionalText ─────────────────────────────────────────────────────

describe("fetchOptionalText", () => {
  it("returns the body text on a 2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello", { status: 200 })),
    );
    expect(await fetchOptionalText("https://example.test/x")).toBe("hello");
  });

  it("returns null on a 404 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    expect(await fetchOptionalText("https://example.test/x")).toBeNull();
  });

  it("throws on any non-2xx, non-404 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(fetchOptionalText("https://example.test/x")).rejects.toThrow(/500/);
  });
});

// ─── fetchJson ─────────────────────────────────────────────────────────────

describe("fetchJson", () => {
  it("sends the lowercase 'accept: application/vnd.github+json' header and returns parsed JSON", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchJson<{ ok: boolean }>("https://example.test/json");
    expect(result).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1];
    expect(init?.headers).toEqual({ accept: "application/vnd.github+json" });
  });

  it("throws on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 422 })),
    );
    await expect(fetchJson("https://example.test/x")).rejects.toThrow(/422/);
  });
});

// ─── resolveGitHubPinnedRef ────────────────────────────────────────────────

const SHA40 = "1234567890abcdef1234567890abcdef12345678";

function source(overrides: Partial<SkillSourceGitHubSource> = {}): SkillSourceGitHubSource {
  return {
    hostname: "github.com",
    owner: "StreamDemon",
    repo: "mercury",
    ref: "main",
    basePath: "",
    filePath: null,
    explicitRef: true,
    ...overrides,
  };
}

describe("resolveGitHubPinnedRef", () => {
  it("returns SHA-shaped refs as-is without any fetch (explicitRef true)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveGitHubPinnedRef(source({ ref: SHA40, explicitRef: true }));
    expect(result).toEqual({ pinnedRef: SHA40, trackingRef: SHA40 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a SHA-shaped ref with trackingRef null when explicitRef is false", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveGitHubPinnedRef(source({ ref: SHA40, explicitRef: false }));
    expect(result).toEqual({ pinnedRef: SHA40, trackingRef: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with explicitRef=true and a floating branch, resolves the SHA without fetching the default branch", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/commits/")) {
        return new Response(JSON.stringify({ sha: SHA40 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveGitHubPinnedRef(source({ ref: "develop", explicitRef: true }));
    expect(result).toEqual({ pinnedRef: SHA40, trackingRef: "develop" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain("/commits/develop");
  });

  it("with explicitRef=false, fetches the default branch first then resolves its SHA", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/repos/StreamDemon/mercury")) {
        return new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 });
      }
      if (url.includes("/commits/trunk")) {
        return new Response(JSON.stringify({ sha: SHA40 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveGitHubPinnedRef(source({ ref: "main", explicitRef: false }));
    expect(result).toEqual({ pinnedRef: SHA40, trackingRef: "trunk" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
