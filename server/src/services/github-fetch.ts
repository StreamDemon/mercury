import path from "node:path";
import { unprocessable } from "../errors.js";

// ─── Host helpers ──────────────────────────────────────────────────────────

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

// ─── Wrapped fetch ─────────────────────────────────────────────────────────

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}

export async function fetchText(url: string): Promise<string> {
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

export async function fetchOptionalText(url: string): Promise<string | null> {
  const response = await ghFetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

export async function fetchBinary(url: string): Promise<Buffer> {
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await ghFetch(url, {
    headers: {
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// ─── URL parsing ───────────────────────────────────────────────────────────

export interface CompanyPackageGitHubSource {
  hostname: string;
  owner: string;
  repo: string;
  ref: string;
  basePath: string;
  companyPath: string;
}

export interface SkillSourceGitHubSource {
  hostname: string;
  owner: string;
  repo: string;
  ref: string;
  basePath: string;
  filePath: string | null;
  explicitRef: boolean;
}

function normalizeGitHubSourcePath(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Shared core: validate scheme, split path segments, extract repo identity
 * and any common path-segment shape (`/tree/<ref>/<...>` or `/blob/<ref>/<...>`).
 *
 * Each named parser layers its own defaults and query-param handling on top.
 */
function parseGitHubRepoUrlParts(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw unprocessable("GitHub source URL must use HTTPS");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  return {
    hostname: url.hostname,
    owner: parts[0]!,
    repo: parts[1]!.replace(/\.git$/i, ""),
    parts,
    searchParams: url.searchParams,
  };
}

/**
 * Parse a URL pointing to a portable company package — either a repo root
 * (defaults to `<repo>/COMPANY.md`), a `?path=`/`?companyPath=` query-param
 * shape, or a path-segment `/tree/<ref>/<dir>` / `/blob/<ref>/<file>` form.
 *
 * Always returns a non-empty `companyPath`.
 */
export function parseCompanyPackageGitHubUrl(rawUrl: string): CompanyPackageGitHubSource {
  const { hostname, owner, repo, parts, searchParams } = parseGitHubRepoUrlParts(rawUrl);

  const queryRef = searchParams.get("ref")?.trim();
  const queryPath = normalizeGitHubSourcePath(searchParams.get("path"));
  const queryCompanyPath = normalizeGitHubSourcePath(searchParams.get("companyPath"));
  if (queryRef || queryPath || queryCompanyPath) {
    const companyPath = queryCompanyPath || [queryPath, "COMPANY.md"].filter(Boolean).join("/") || "COMPANY.md";
    let basePath = queryPath;
    if (!basePath && companyPath !== "COMPANY.md") {
      basePath = path.posix.dirname(companyPath);
      if (basePath === ".") basePath = "";
    }
    return {
      hostname,
      owner,
      repo,
      ref: queryRef || "main",
      basePath,
      companyPath,
    };
  }

  let ref = "main";
  let basePath = "";
  let companyPath = "COMPANY.md";
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    const blobPath = parts.slice(4).join("/");
    if (!blobPath) {
      throw unprocessable("Invalid GitHub blob URL");
    }
    companyPath = blobPath;
    basePath = path.posix.dirname(blobPath);
    if (basePath === ".") basePath = "";
  }
  return { hostname, owner, repo, ref, basePath, companyPath };
}

/**
 * Parse a URL pointing to a skill source — either a repo root (no path),
 * `/tree/<ref>/<dir>` (a directory of skills), or `/blob/<ref>/<file>`
 * (a single skill file).
 *
 * Returns `filePath: null` for tree-form / no-path URLs, and tracks
 * `explicitRef` so callers can distinguish a user-supplied ref from the
 * `"main"` default — used by `resolveGitHubPinnedRef` to decide whether to
 * resolve the repo's default branch.
 */
export function parseSkillSourceGitHubUrl(rawUrl: string): SkillSourceGitHubSource {
  const { hostname, owner, repo, parts } = parseGitHubRepoUrlParts(rawUrl);

  let ref = "main";
  let basePath = "";
  let filePath: string | null = null;
  let explicitRef = false;
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
    explicitRef = true;
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    filePath = parts.slice(4).join("/");
    basePath = filePath ? path.posix.dirname(filePath) : "";
    explicitRef = true;
  }
  return { hostname, owner, repo, ref, basePath, filePath, explicitRef };
}

// ─── Ref resolution ────────────────────────────────────────────────────────

export async function resolveGitHubDefaultBranch(
  owner: string,
  repo: string,
  apiBase: string,
): Promise<string> {
  const response = await fetchJson<{ default_branch?: string }>(
    `${apiBase}/repos/${owner}/${repo}`,
  );
  const branch = typeof response.default_branch === "string" ? response.default_branch.trim() : "";
  return branch.length > 0 ? branch : "main";
}

export async function resolveGitHubCommitSha(
  owner: string,
  repo: string,
  ref: string,
  apiBase: string,
): Promise<string> {
  const response = await fetchJson<{ sha?: string }>(
    `${apiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
  );
  const sha = typeof response.sha === "string" ? response.sha.trim() : "";
  if (sha.length === 0) {
    throw unprocessable(`Failed to resolve GitHub ref ${ref}`);
  }
  return sha;
}

/**
 * Resolve a parsed skill-source URL into a `(pinnedRef, trackingRef)` pair.
 *
 * - If `parsed.ref` is already a 40-character SHA, it's pinned as-is and
 *   `trackingRef` is set only when the ref was explicit in the URL.
 * - Otherwise, `trackingRef` is the explicit ref (or the repo's default
 *   branch when no ref was supplied), and `pinnedRef` is that branch's
 *   current commit SHA.
 */
export async function resolveGitHubPinnedRef(
  parsed: SkillSourceGitHubSource,
): Promise<{ pinnedRef: string; trackingRef: string | null }> {
  const apiBase = gitHubApiBase(parsed.hostname);
  if (/^[0-9a-f]{40}$/i.test(parsed.ref.trim())) {
    return {
      pinnedRef: parsed.ref,
      trackingRef: parsed.explicitRef ? parsed.ref : null,
    };
  }

  const trackingRef = parsed.explicitRef
    ? parsed.ref
    : await resolveGitHubDefaultBranch(parsed.owner, parsed.repo, apiBase);
  const pinnedRef = await resolveGitHubCommitSha(parsed.owner, parsed.repo, trackingRef, apiBase);
  return { pinnedRef, trackingRef };
}
