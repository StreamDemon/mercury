import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeAgentUrlKey } from "@mercuryai/shared";
import type {
  CompanySkillCompatibility,
  CompanySkillFileInventoryEntry,
  CompanySkillSourceType,
  CompanySkillTrustLevel,
} from "@mercuryai/shared";
import { unprocessable } from "../errors.js";

export type ImportedSkill = {
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  packageDir?: string | null;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  metadata: Record<string, unknown> | null;
};

export type ParsedSkillImportSource = {
  resolvedSource: string;
  requestedSkillSlug: string | null;
  originalSkillsShUrl: string | null;
  warnings: string[];
};

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePortablePath(input: string) {
  const parts: string[] = [];
  for (const segment of input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export function normalizeSkillSlug(value: string | null | undefined) {
  return value ? normalizeAgentUrlKey(value, { preserveCase: true }) ?? null : null;
}

export function normalizeSkillKey(value: string | null | undefined) {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}

export function normalizeGitHubSkillDirectory(
  value: string | null | undefined,
  fallback: string,
) {
  const normalized = normalizePortablePath(value ?? "");
  if (!normalized) return normalizePortablePath(fallback);
  if (path.posix.basename(normalized).toLowerCase() === "skill.md") {
    return normalizePortablePath(path.posix.dirname(normalized));
  }
  return normalized;
}

export function hashSkillValue(value: string, length = 10) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function uniqueSkillSlug(baseSlug: string, usedSlugs: Set<string>) {
  if (!usedSlugs.has(baseSlug)) return baseSlug;
  let attempt = 2;
  let candidate = `${baseSlug}-${attempt}`;
  while (usedSlugs.has(candidate)) {
    attempt += 1;
    candidate = `${baseSlug}-${attempt}`;
  }
  return candidate;
}

export function uniqueImportedSkillKey(companyId: string, baseSlug: string, usedKeys: Set<string>) {
  const initial = `company/${companyId}/${baseSlug}`;
  if (!usedKeys.has(initial)) return initial;
  let attempt = 2;
  let candidate = `company/${companyId}/${baseSlug}-${attempt}`;
  while (usedKeys.has(candidate)) {
    attempt += 1;
    candidate = `company/${companyId}/${baseSlug}-${attempt}`;
  }
  return candidate;
}

export function buildSkillRuntimeName(key: string, slug: string) {
  if (key.startsWith("StreamDemon/mercury/")) return slug;
  return `${slug}--${hashSkillValue(key)}`;
}

export function readCanonicalSkillKey(frontmatter: Record<string, unknown>, metadata: Record<string, unknown> | null) {
  const direct = normalizeSkillKey(
    asString(frontmatter.key)
    ?? asString(frontmatter.skillKey)
    ?? asString(metadata?.skillKey)
    ?? asString(metadata?.canonicalKey)
    ?? asString(metadata?.mercurySkillKey),
  );
  if (direct) return direct;
  const mercury = isPlainRecord(metadata?.mercury) ? metadata?.mercury as Record<string, unknown> : null;
  return normalizeSkillKey(
    asString(mercury?.skillKey)
    ?? asString(mercury?.key),
  );
}

export function deriveCanonicalSkillKey(
  companyId: string,
  input: Pick<ImportedSkill, "slug" | "sourceType" | "sourceLocator" | "metadata">,
) {
  const slug = normalizeSkillSlug(input.slug) ?? "skill";
  const metadata = isPlainRecord(input.metadata) ? input.metadata : null;
  const explicitKey = readCanonicalSkillKey({}, metadata);
  if (explicitKey) return explicitKey;

  const sourceKind = asString(metadata?.sourceKind);
  if (sourceKind === "mercury_bundled") {
    return `StreamDemon/mercury/${slug}`;
  }

  const owner = normalizeSkillSlug(asString(metadata?.owner));
  const repo = normalizeSkillSlug(asString(metadata?.repo));
  if ((input.sourceType === "github" || input.sourceType === "skills_sh" || sourceKind === "github" || sourceKind === "skills_sh") && owner && repo) {
    return `${owner}/${repo}/${slug}`;
  }

  if (input.sourceType === "url" || sourceKind === "url") {
    const locator = asString(input.sourceLocator);
    if (locator) {
      try {
        const url = new URL(locator);
        const host = normalizeSkillSlug(url.host) ?? "url";
        return `url/${host}/${hashSkillValue(locator)}/${slug}`;
      } catch {
        return `url/unknown/${hashSkillValue(locator)}/${slug}`;
      }
    }
  }

  if (input.sourceType === "local_path") {
    if (sourceKind === "managed_local") {
      return `company/${companyId}/${slug}`;
    }
    const locator = asString(input.sourceLocator);
    if (locator) {
      return `local/${hashSkillValue(path.resolve(locator))}/${slug}`;
    }
  }

  return `company/${companyId}/${slug}`;
}

export function deriveImportedSkillSlug(frontmatter: Record<string, unknown>, fallback: string) {
  return normalizeSkillSlug(asString(frontmatter.slug))
    ?? normalizeSkillSlug(asString(frontmatter.name))
    ?? normalizeAgentUrlKey(fallback, { preserveCase: true })
    ?? "skill";
}

export function deriveImportedSkillSource(
  frontmatter: Record<string, unknown>,
  fallbackSlug: string,
): Pick<ImportedSkill, "sourceType" | "sourceLocator" | "sourceRef" | "metadata"> {
  const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
  const canonicalKey = readCanonicalSkillKey(frontmatter, metadata);
  const rawSources = metadata && Array.isArray(metadata.sources) ? metadata.sources : [];
  const sourceEntry = rawSources.find((entry) => isPlainRecord(entry)) as Record<string, unknown> | undefined;
  const kind = asString(sourceEntry?.kind);

  if (kind === "github-dir" || kind === "github-file") {
    const repo = asString(sourceEntry?.repo);
    const repoPath = asString(sourceEntry?.path);
    const commit = asString(sourceEntry?.commit);
    const trackingRef = asString(sourceEntry?.trackingRef);
    const sourceHostname = asString(sourceEntry?.hostname) || "github.com";
    const url = asString(sourceEntry?.url)
      ?? (repo
        ? `https://${sourceHostname}/${repo}${repoPath ? `/tree/${trackingRef ?? commit ?? "main"}/${repoPath}` : ""}`
        : null);
    const [owner, repoName] = (repo ?? "").split("/");
    if (repo && owner && repoName) {
      return {
        sourceType: "github",
        sourceLocator: url,
        sourceRef: commit,
        metadata: {
          ...(canonicalKey ? { skillKey: canonicalKey } : {}),
          sourceKind: "github",
          ...(sourceHostname !== "github.com" ? { hostname: sourceHostname } : {}),
          owner,
          repo: repoName,
          ref: commit,
          trackingRef,
          repoSkillDir: repoPath ?? `skills/${fallbackSlug}`,
        },
      };
    }
  }

  if (kind === "url") {
    const url = asString(sourceEntry?.url) ?? asString(sourceEntry?.rawUrl);
    if (url) {
      return {
        sourceType: "url",
        sourceLocator: url,
        sourceRef: null,
        metadata: {
          ...(canonicalKey ? { skillKey: canonicalKey } : {}),
          sourceKind: "url",
        },
      };
    }
  }

  return {
    sourceType: "catalog",
    sourceLocator: null,
    sourceRef: null,
    metadata: {
      ...(canonicalKey ? { skillKey: canonicalKey } : {}),
      sourceKind: "catalog",
    },
  };
}

export function classifyInventoryKind(relativePath: string): CompanySkillFileInventoryEntry["kind"] {
  const normalized = normalizePortablePath(relativePath).toLowerCase();
  if (normalized.endsWith("/skill.md") || normalized === "skill.md") return "skill";
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  if (normalized.endsWith(".md")) return "markdown";
  const fileName = path.posix.basename(normalized);
  if (
    fileName.endsWith(".sh")
    || fileName.endsWith(".js")
    || fileName.endsWith(".mjs")
    || fileName.endsWith(".cjs")
    || fileName.endsWith(".ts")
    || fileName.endsWith(".py")
    || fileName.endsWith(".rb")
    || fileName.endsWith(".bash")
  ) {
    return "script";
  }
  if (
    fileName.endsWith(".png")
    || fileName.endsWith(".jpg")
    || fileName.endsWith(".jpeg")
    || fileName.endsWith(".gif")
    || fileName.endsWith(".svg")
    || fileName.endsWith(".webp")
    || fileName.endsWith(".pdf")
  ) {
    return "asset";
  }
  return "other";
}

export function deriveTrustLevel(fileInventory: CompanySkillFileInventoryEntry[]): CompanySkillTrustLevel {
  if (fileInventory.some((entry) => entry.kind === "script")) return "scripts_executables";
  if (fileInventory.some((entry) => entry.kind === "asset" || entry.kind === "other")) return "assets";
  return "markdown_only";
}

function extractCommandTokens(raw: string) {
  const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

export function parseSkillImportSourceInput(rawInput: string): ParsedSkillImportSource {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw unprocessable("Skill source is required.");
  }

  const warnings: string[] = [];
  let source = trimmed;
  let requestedSkillSlug: string | null = null;

  if (/^npx\s+skills\s+add\s+/i.test(trimmed)) {
    const tokens = extractCommandTokens(trimmed);
    const addIndex = tokens.findIndex(
      (token, index) =>
        token.toLowerCase() === "add"
        && index > 0
        && tokens[index - 1]?.toLowerCase() === "skills",
    );
    if (addIndex >= 0) {
      source = tokens[addIndex + 1] ?? "";
      for (let index = addIndex + 2; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token === "--skill") {
          requestedSkillSlug = normalizeSkillSlug(tokens[index + 1] ?? null);
          index += 1;
          continue;
        }
        if (token.startsWith("--skill=")) {
          requestedSkillSlug = normalizeSkillSlug(token.slice("--skill=".length));
        }
      }
    }
  }

  const normalizedSource = source.trim();
  if (!normalizedSource) {
    throw unprocessable("Skill source is required.");
  }

  // Key-style imports (org/repo/skill) originate from the skills.sh registry
  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    const [owner, repo, skillSlugRaw] = normalizedSource.split("/");
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: normalizeSkillSlug(skillSlugRaw),
      originalSkillsShUrl: `https://skills.sh/${owner}/${repo}/${skillSlugRaw}`,
      warnings,
    };
  }

  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    return {
      resolvedSource: `https://github.com/${normalizedSource}`,
      requestedSkillSlug,
      originalSkillsShUrl: null,
      warnings,
    };
  }

  // Detect skills.sh URLs and resolve to GitHub: https://skills.sh/org/repo/skill → org/repo/skill key
  const skillsShMatch = normalizedSource.match(/^https?:\/\/(?:www\.)?skills\.sh\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?(?:[?#].*)?$/i);
  if (skillsShMatch) {
    const [, owner, repo, skillSlugRaw] = skillsShMatch;
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: skillSlugRaw ? normalizeSkillSlug(skillSlugRaw) : requestedSkillSlug,
      originalSkillsShUrl: normalizedSource,
      warnings,
    };
  }

  return {
    resolvedSource: normalizedSource,
    requestedSkillSlug,
    originalSkillsShUrl: null,
    warnings,
  };
}
