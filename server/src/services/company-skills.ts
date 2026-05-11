import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@mercuryai/db";
import { companies, companySkills } from "@mercuryai/db";
import { readMercurySkillSyncPreference } from "@mercuryai/adapter-utils/server-utils";
import type { MercurySkillEntry } from "@mercuryai/adapter-utils/server-utils";
import type {
  CompanySkill,
  CompanySkillCreateRequest,
  CompanySkillCompatibility,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillImportResult,
  CompanySkillListItem,
  CompanySkillProjectScanConflict,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillProjectScanSkipped,
  CompanySkillSourceBadge,
  CompanySkillSourceType,
  CompanySkillTrustLevel,
  CompanySkillUpdateStatus,
  CompanySkillUsageAgent,
} from "@mercuryai/shared";
import { parseFrontmatterMarkdown } from "@mercuryai/shared/yaml-codec";
import { resolveMercuryInstanceRoot } from "../home-paths.js";
import { notFound, unprocessable } from "../errors.js";
import {
  fetchText,
  gitHubApiBase,
  resolveGitHubCommitSha,
  resolveRawGitHubUrl,
} from "./github-fetch.js";
import {
  asString,
  buildSkillRuntimeName,
  deriveCanonicalSkillKey,
  isPlainRecord,
  normalizeGitHubSkillDirectory,
  normalizePortablePath,
  normalizeSkillKey,
  normalizeSkillSlug,
  parseSkillImportSourceInput,
  uniqueImportedSkillKey,
  uniqueSkillSlug,
  type ImportedSkill,
} from "./skill-source.js";
import {
  discoverProjectWorkspaceSkillDirectories,
  normalizePackageFileMap,
  readInlineSkillImports,
  readLocalSkillImportFromDirectory,
  readLocalSkillImports,
  readUrlSkillImports,
  resolveBundledSkillsRoot,
  statPath,
  type LocalSkillInventoryMode,
  type ProjectSkillScanTarget,
} from "./skill-fetcher.js";
import { agentService } from "./agents.js";
import { projectService } from "./projects.js";

type CompanySkillRow = typeof companySkills.$inferSelect;
type CompanySkillListDbRow = Pick<
  CompanySkillRow,
  | "id"
  | "companyId"
  | "key"
  | "slug"
  | "name"
  | "description"
  | "sourceType"
  | "sourceLocator"
  | "sourceRef"
  | "trustLevel"
  | "compatibility"
  | "fileInventory"
  | "metadata"
  | "createdAt"
  | "updatedAt"
>;
type CompanySkillListRow = Pick<
  CompanySkill,
  | "id"
  | "companyId"
  | "key"
  | "slug"
  | "name"
  | "description"
  | "sourceType"
  | "sourceLocator"
  | "sourceRef"
  | "trustLevel"
  | "compatibility"
  | "fileInventory"
  | "metadata"
  | "createdAt"
  | "updatedAt"
>;
type CompanySkillReferenceRow = Pick<
  CompanySkillRow,
  | "id"
  | "key"
  | "slug"
>;
type SkillReferenceTarget = Pick<CompanySkill, "id" | "key" | "slug">;
type SkillSourceInfoTarget = Pick<
  CompanySkill,
  | "companyId"
  | "sourceType"
  | "sourceLocator"
  | "metadata"
>;

type PackageSkillConflictStrategy = "replace" | "rename" | "skip";

export type ImportPackageSkillResult = {
  skill: CompanySkill;
  action: "created" | "updated" | "skipped";
  originalKey: string;
  originalSlug: string;
  requestedRefs: string[];
  reason: string | null;
};

type SkillSourceMeta = {
  skillKey?: string;
  sourceKind?: string;
  hostname?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  trackingRef?: string;
  repoSkillDir?: string;
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceCwd?: string;
};

type RuntimeSkillEntryOptions = {
  materializeMissing?: boolean;
};

const skillInventoryRefreshPromises = new Map<string, Promise<void>>();

function selectCompanySkillColumns() {
  return {
    id: companySkills.id,
    companyId: companySkills.companyId,
    key: companySkills.key,
    slug: companySkills.slug,
    name: companySkills.name,
    description: companySkills.description,
    markdown: companySkills.markdown,
    sourceType: companySkills.sourceType,
    sourceLocator: companySkills.sourceLocator,
    sourceRef: companySkills.sourceRef,
    trustLevel: companySkills.trustLevel,
    compatibility: companySkills.compatibility,
    fileInventory: companySkills.fileInventory,
    metadata: companySkills.metadata,
    createdAt: companySkills.createdAt,
    updatedAt: companySkills.updatedAt,
  };
}

function toCompanySkill(row: CompanySkillRow): CompanySkill {
  return {
    ...row,
    description: row.description ?? null,
    sourceType: row.sourceType as CompanySkillSourceType,
    sourceLocator: row.sourceLocator ?? null,
    sourceRef: row.sourceRef ?? null,
    trustLevel: row.trustLevel as CompanySkillTrustLevel,
    compatibility: row.compatibility as CompanySkillCompatibility,
    fileInventory: Array.isArray(row.fileInventory)
      ? row.fileInventory.flatMap((entry) => {
        if (!isPlainRecord(entry)) return [];
        return [{
          path: String(entry.path ?? ""),
          kind: (String(entry.kind ?? "other") as CompanySkillFileInventoryEntry["kind"]),
        }];
      })
      : [],
    metadata: isPlainRecord(row.metadata) ? row.metadata : null,
  };
}

function toCompanySkillListRow(row: CompanySkillListDbRow): CompanySkillListRow {
  return {
    ...row,
    description: row.description ?? null,
    sourceType: row.sourceType as CompanySkillSourceType,
    sourceLocator: row.sourceLocator ?? null,
    sourceRef: row.sourceRef ?? null,
    trustLevel: row.trustLevel as CompanySkillTrustLevel,
    compatibility: row.compatibility as CompanySkillCompatibility,
    fileInventory: Array.isArray(row.fileInventory)
      ? row.fileInventory.flatMap((entry) => {
        if (!isPlainRecord(entry)) return [];
        return [{
          path: String(entry.path ?? ""),
          kind: (String(entry.kind ?? "other") as CompanySkillFileInventoryEntry["kind"]),
        }];
      })
      : [],
    metadata: isPlainRecord(row.metadata) ? row.metadata : null,
  };
}

function serializeFileInventory(
  fileInventory: CompanySkillFileInventoryEntry[],
): Array<Record<string, unknown>> {
  return fileInventory.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
  }));
}

function getSkillMeta(skill: Pick<CompanySkill, "metadata">): SkillSourceMeta {
  return isPlainRecord(skill.metadata) ? skill.metadata as SkillSourceMeta : {};
}

function resolveSkillReference(
  skills: SkillReferenceTarget[],
  reference: string,
): { skill: SkillReferenceTarget | null; ambiguous: boolean } {
  const trimmed = reference.trim();
  if (!trimmed) {
    return { skill: null, ambiguous: false };
  }

  const byId = skills.find((skill) => skill.id === trimmed);
  if (byId) {
    return { skill: byId, ambiguous: false };
  }

  const normalizedKey = normalizeSkillKey(trimmed);
  if (normalizedKey) {
    const byKey = skills.find((skill) => skill.key === normalizedKey);
    if (byKey) {
      return { skill: byKey, ambiguous: false };
    }
  }

  const normalizedSlug = normalizeSkillSlug(trimmed);
  if (!normalizedSlug) {
    return { skill: null, ambiguous: false };
  }

  const bySlug = skills.filter((skill) => skill.slug === normalizedSlug);
  if (bySlug.length === 1) {
    return { skill: bySlug[0] ?? null, ambiguous: false };
  }
  if (bySlug.length > 1) {
    return { skill: null, ambiguous: true };
  }

  return { skill: null, ambiguous: false };
}

function resolveRequestedSkillKeysOrThrow(
  skills: CompanySkill[],
  requestedReferences: string[],
) {
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const resolved = new Set<string>();

  for (const reference of requestedReferences) {
    const trimmed = reference.trim();
    if (!trimmed) continue;

    const match = resolveSkillReference(skills, trimmed);
    if (match.skill) {
      resolved.add(match.skill.key);
      continue;
    }

    if (match.ambiguous) {
      ambiguous.add(trimmed);
      continue;
    }

    missing.add(trimmed);
  }

  if (ambiguous.size > 0 || missing.size > 0) {
    const problems: string[] = [];
    if (ambiguous.size > 0) {
      problems.push(`ambiguous references: ${Array.from(ambiguous).sort().join(", ")}`);
    }
    if (missing.size > 0) {
      problems.push(`unknown references: ${Array.from(missing).sort().join(", ")}`);
    }
    throw unprocessable(`Invalid company skill selection (${problems.join("; ")}).`);
  }

  return Array.from(resolved);
}

function resolveDesiredSkillKeys(
  skills: SkillReferenceTarget[],
  config: Record<string, unknown>,
) {
  const preference = readMercurySkillSyncPreference(config);
  return Array.from(new Set(
    preference.desiredSkills
      .map((reference) => resolveSkillReference(skills, reference).skill?.key ?? normalizeSkillKey(reference))
      .filter((value): value is string => Boolean(value)),
  ));
}

function normalizeSkillDirectory(skill: SkillSourceInfoTarget) {
  if ((skill.sourceType !== "local_path" && skill.sourceType !== "catalog") || !skill.sourceLocator) return null;
  const resolved = path.resolve(skill.sourceLocator);
  if (path.basename(resolved).toLowerCase() === "skill.md") {
    return path.dirname(resolved);
  }
  return resolved;
}

function normalizeSourceLocatorDirectory(sourceLocator: string | null) {
  if (!sourceLocator) return null;
  const resolved = path.resolve(sourceLocator);
  return path.basename(resolved).toLowerCase() === "skill.md" ? path.dirname(resolved) : resolved;
}

export async function findMissingLocalSkillIds(
  skills: Array<Pick<CompanySkill, "id" | "sourceType" | "sourceLocator">>,
) {
  const missingIds: string[] = [];

  for (const skill of skills) {
    if (skill.sourceType !== "local_path") continue;
    const skillDir = normalizeSourceLocatorDirectory(skill.sourceLocator);
    if (!skillDir) {
      missingIds.push(skill.id);
      continue;
    }

    const skillDirStat = await statPath(skillDir);
    const skillFileStat = await statPath(path.join(skillDir, "SKILL.md"));
    if (!skillDirStat?.isDirectory() || !skillFileStat?.isFile()) {
      missingIds.push(skill.id);
    }
  }

  return missingIds;
}

function resolveManagedSkillsRoot(companyId: string) {
  return path.resolve(resolveMercuryInstanceRoot(), "skills", companyId);
}

function resolveLocalSkillFilePath(skill: CompanySkill, relativePath: string) {
  const normalized = normalizePortablePath(relativePath);
  const skillDir = normalizeSkillDirectory(skill);
  if (skillDir) {
    return path.resolve(skillDir, normalized);
  }

  if (!skill.sourceLocator) return null;
  const fallbackRoot = path.resolve(skill.sourceLocator);
  const directPath = path.resolve(fallbackRoot, normalized);
  return directPath;
}

function inferLanguageFromPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  if (fileName === "skill.md" || fileName.endsWith(".md")) return "markdown";
  if (fileName.endsWith(".ts")) return "typescript";
  if (fileName.endsWith(".tsx")) return "tsx";
  if (fileName.endsWith(".js")) return "javascript";
  if (fileName.endsWith(".jsx")) return "jsx";
  if (fileName.endsWith(".json")) return "json";
  if (fileName.endsWith(".yml") || fileName.endsWith(".yaml")) return "yaml";
  if (fileName.endsWith(".sh")) return "bash";
  if (fileName.endsWith(".py")) return "python";
  if (fileName.endsWith(".html")) return "html";
  if (fileName.endsWith(".css")) return "css";
  return null;
}

function isMarkdownPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  return fileName === "skill.md" || fileName.endsWith(".md");
}

function deriveSkillSourceInfo(skill: SkillSourceInfoTarget): {
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
  sourcePath: string | null;
} {
  const metadata = getSkillMeta(skill);
  const localSkillDir = normalizeSkillDirectory(skill);
  if (metadata.sourceKind === "mercury_bundled") {
    return {
      editable: false,
      editableReason: "Bundled Mercury skills are read-only.",
      sourceLabel: "Mercury bundled",
      sourceBadge: "mercury",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "skills_sh") {
    const owner = asString(metadata.owner) ?? null;
    const repo = asString(metadata.repo) ?? null;
    return {
      editable: false,
      editableReason: "Skills.sh-managed skills are read-only.",
      sourceLabel: skill.sourceLocator ?? (owner && repo ? `${owner}/${repo}` : null),
      sourceBadge: "skills_sh",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "github") {
    const owner = asString(metadata.owner) ?? null;
    const repo = asString(metadata.repo) ?? null;
    return {
      editable: false,
      editableReason: "Remote GitHub skills are read-only. Fork or import locally to edit them.",
      sourceLabel: owner && repo ? `${owner}/${repo}` : skill.sourceLocator,
      sourceBadge: "github",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "url") {
    return {
      editable: false,
      editableReason: "URL-based skills are read-only. Save them locally to edit them.",
      sourceLabel: skill.sourceLocator,
      sourceBadge: "url",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "local_path") {
    const managedRoot = resolveManagedSkillsRoot(skill.companyId);
    const projectName = asString(metadata.projectName);
    const workspaceName = asString(metadata.workspaceName);
    const isProjectScan = metadata.sourceKind === "project_scan";
    if (localSkillDir && localSkillDir.startsWith(managedRoot)) {
      return {
        editable: true,
        editableReason: null,
        sourceLabel: "Mercury workspace",
        sourceBadge: "mercury",
        sourcePath: managedRoot,
      };
    }

    return {
      editable: true,
      editableReason: null,
      sourceLabel: isProjectScan
        ? [projectName, workspaceName].filter((value): value is string => Boolean(value)).join(" / ")
          || skill.sourceLocator
        : skill.sourceLocator,
      sourceBadge: "local",
      sourcePath: null,
    };
  }

  return {
    editable: false,
    editableReason: "This skill source is read-only.",
    sourceLabel: skill.sourceLocator,
    sourceBadge: "catalog",
    sourcePath: null,
  };
}

function enrichSkill(skill: CompanySkill, attachedAgentCount: number, usedByAgents: CompanySkillUsageAgent[] = []) {
  const source = deriveSkillSourceInfo(skill);
  return {
    ...skill,
    attachedAgentCount,
    usedByAgents,
    ...source,
  };
}

function toCompanySkillListItem(skill: CompanySkillListRow, attachedAgentCount: number): CompanySkillListItem {
  const source = deriveSkillSourceInfo(skill);
  return {
    id: skill.id,
    companyId: skill.companyId,
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    sourceType: skill.sourceType,
    sourceLocator: skill.sourceLocator,
    sourceRef: skill.sourceRef,
    trustLevel: skill.trustLevel,
    compatibility: skill.compatibility,
    fileInventory: skill.fileInventory,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    attachedAgentCount,
    editable: source.editable,
    editableReason: source.editableReason,
    sourceLabel: source.sourceLabel,
    sourceBadge: source.sourceBadge,
    sourcePath: source.sourcePath,
  };
}

export function companySkillService(db: Db) {
  const agents = agentService(db);
  const projects = projectService(db);

  async function ensureBundledSkills(companyId: string) {
    for (const skillsRoot of resolveBundledSkillsRoot()) {
      const stats = await fs.stat(skillsRoot).catch(() => null);
      if (!stats?.isDirectory()) continue;
      const bundledSkills = await readLocalSkillImports(companyId, skillsRoot)
        .then((skills) => skills.map((skill) => ({
          ...skill,
          key: deriveCanonicalSkillKey(companyId, {
            ...skill,
            metadata: {
              ...(skill.metadata ?? {}),
              sourceKind: "mercury_bundled",
            },
          }),
          metadata: {
            ...(skill.metadata ?? {}),
            sourceKind: "mercury_bundled",
          },
        })))
        .catch(() => [] as ImportedSkill[]);
      if (bundledSkills.length === 0) continue;
      return upsertImportedSkills(companyId, bundledSkills);
    }
    return [];
  }

  async function pruneMissingLocalPathSkills(companyId: string) {
    const rows = await db
      .select({
        id: companySkills.id,
        key: companySkills.key,
        slug: companySkills.slug,
        sourceType: companySkills.sourceType,
        sourceLocator: companySkills.sourceLocator,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    const skills = rows.map((row) => ({
      ...row,
      sourceType: row.sourceType as CompanySkillSourceType,
    }));
    const missingIds = new Set(await findMissingLocalSkillIds(skills));
    if (missingIds.size === 0) return;

    for (const skill of skills) {
      if (!missingIds.has(skill.id)) continue;
      await db
        .delete(companySkills)
        .where(eq(companySkills.id, skill.id));
      await fs.rm(resolveRuntimeSkillMaterializedPath(companyId, skill), { recursive: true, force: true });
    }
  }

  async function ensureSkillInventoryCurrent(companyId: string) {
    const existingRefresh = skillInventoryRefreshPromises.get(companyId);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    const refreshPromise = (async () => {
      const companyExists = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows.length > 0);
      if (!companyExists) {
        throw notFound("Company not found");
      }
      await ensureBundledSkills(companyId);
      await pruneMissingLocalPathSkills(companyId);
    })();

    skillInventoryRefreshPromises.set(companyId, refreshPromise);
    try {
      await refreshPromise;
    } finally {
      if (skillInventoryRefreshPromises.get(companyId) === refreshPromise) {
        skillInventoryRefreshPromises.delete(companyId);
      }
    }
  }

  async function list(companyId: string): Promise<CompanySkillListItem[]> {
    await ensureSkillInventoryCurrent(companyId);
    const rows = await db
      .select({
        id: companySkills.id,
        companyId: companySkills.companyId,
        key: companySkills.key,
        slug: companySkills.slug,
        name: companySkills.name,
        description: companySkills.description,
        sourceType: companySkills.sourceType,
        sourceLocator: companySkills.sourceLocator,
        sourceRef: companySkills.sourceRef,
        trustLevel: companySkills.trustLevel,
        compatibility: companySkills.compatibility,
        fileInventory: companySkills.fileInventory,
        metadata: companySkills.metadata,
        createdAt: companySkills.createdAt,
        updatedAt: companySkills.updatedAt,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.name), asc(companySkills.key))
      .then((entries) => entries.map((entry) => toCompanySkillListRow(entry as CompanySkillListDbRow)));
    const agentRows = await agents.list(companyId);
    return rows.map((skill) => {
      const attachedAgentCount = agentRows.filter((agent) => {
        const desiredSkills = resolveDesiredSkillKeys(rows, agent.adapterConfig as Record<string, unknown>);
        return desiredSkills.includes(skill.key);
      }).length;
      return toCompanySkillListItem(skill, attachedAgentCount);
    });
  }

  async function listFull(companyId: string): Promise<CompanySkill[]> {
    await ensureSkillInventoryCurrent(companyId);
    const rows = await db
      .select(selectCompanySkillColumns())
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.name), asc(companySkills.key));
    return rows.map((row) => toCompanySkill(row));
  }

  async function listReferenceTargets(companyId: string): Promise<SkillReferenceTarget[]> {
    const rows = await db
      .select({
        id: companySkills.id,
        key: companySkills.key,
        slug: companySkills.slug,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    return rows as CompanySkillReferenceRow[];
  }

  async function getById(companyId: string, id: string) {
    const row = await db
      .select(selectCompanySkillColumns())
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, id)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function getByKey(companyId: string, key: string) {
    const row = await db
      .select(selectCompanySkillColumns())
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, key)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function usage(companyId: string, key: string): Promise<CompanySkillUsageAgent[]> {
    const skills = await listReferenceTargets(companyId);
    const agentRows = await agents.list(companyId);
    const desiredAgents = agentRows.filter((agent) => {
      const desiredSkills = resolveDesiredSkillKeys(skills, agent.adapterConfig as Record<string, unknown>);
      return desiredSkills.includes(key);
    });

    return desiredAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      urlKey: agent.urlKey,
      adapterType: agent.adapterType,
      desired: true,
      // Runtime adapter state is intentionally omitted from this bounded metadata read.
      actualState: null,
    }));
  }

  async function detail(companyId: string, id: string): Promise<CompanySkillDetail | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, id);
    if (!skill) return null;
    const usedByAgents = await usage(companyId, skill.key);
    return enrichSkill(skill, usedByAgents.length, usedByAgents);
  }

  async function updateStatus(companyId: string, skillId: string): Promise<CompanySkillUpdateStatus | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;

    if (skill.sourceType !== "github" && skill.sourceType !== "skills_sh") {
      return {
        supported: false,
        reason: "Only GitHub-managed skills support update checks.",
        trackingRef: null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const metadata = getSkillMeta(skill);
    const owner = asString(metadata.owner);
    const repo = asString(metadata.repo);
    const trackingRef = asString(metadata.trackingRef) ?? asString(metadata.ref);
    if (!owner || !repo || !trackingRef) {
      return {
        supported: false,
        reason: "This GitHub skill does not have enough metadata to track updates.",
        trackingRef: trackingRef ?? null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const hostname = asString(metadata.hostname) || "github.com";
    const apiBase = gitHubApiBase(hostname);
    const latestRef = await resolveGitHubCommitSha(owner, repo, trackingRef, apiBase);
    return {
      supported: true,
      reason: null,
      trackingRef,
      currentRef: skill.sourceRef ?? null,
      latestRef,
      hasUpdate: latestRef !== (skill.sourceRef ?? null),
    };
  }

  async function readFile(companyId: string, skillId: string, relativePath: string): Promise<CompanySkillFileDetail | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;

    const normalizedPath = normalizePortablePath(relativePath || "SKILL.md");
    const fileEntry = skill.fileInventory.find((entry) => entry.path === normalizedPath);
    if (!fileEntry) {
      throw notFound("Skill file not found");
    }

    const source = deriveSkillSourceInfo(skill);
    let content = "";

    if (skill.sourceType === "local_path" || skill.sourceType === "catalog") {
      const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
      if (absolutePath) {
        content = await fs.readFile(absolutePath, "utf8");
      } else if (normalizedPath === "SKILL.md") {
        content = skill.markdown;
      } else {
        throw notFound("Skill file not found");
      }
    } else if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
      const metadata = getSkillMeta(skill);
      const owner = asString(metadata.owner);
      const repo = asString(metadata.repo);
      const hostname = asString(metadata.hostname) || "github.com";
      const ref = skill.sourceRef ?? asString(metadata.ref) ?? "main";
      const repoSkillDir = normalizeGitHubSkillDirectory(asString(metadata.repoSkillDir), skill.slug);
      if (!owner || !repo) {
        throw unprocessable("Skill source metadata is incomplete.");
      }
      const repoPath = normalizePortablePath(path.posix.join(repoSkillDir, normalizedPath));
      content = await fetchText(resolveRawGitHubUrl(hostname, owner, repo, ref, repoPath));
    } else if (skill.sourceType === "url") {
      if (normalizedPath !== "SKILL.md") {
        throw notFound("This skill source only exposes SKILL.md");
      }
      content = skill.markdown;
    } else {
      throw unprocessable("Unsupported skill source.");
    }

    return {
      skillId: skill.id,
      path: normalizedPath,
      kind: fileEntry.kind,
      content,
      language: inferLanguageFromPath(normalizedPath),
      markdown: isMarkdownPath(normalizedPath),
      editable: source.editable,
    };
  }

  async function createLocalSkill(companyId: string, input: CompanySkillCreateRequest): Promise<CompanySkill> {
    const slug = normalizeSkillSlug(input.slug ?? input.name) ?? "skill";
    const managedRoot = resolveManagedSkillsRoot(companyId);
    const skillDir = path.resolve(managedRoot, slug);
    const skillFilePath = path.resolve(skillDir, "SKILL.md");

    await fs.mkdir(skillDir, { recursive: true });

    const markdown = (input.markdown?.trim().length
      ? input.markdown
      : [
        "---",
        `name: ${input.name}`,
        ...(input.description?.trim() ? [`description: ${input.description.trim()}`] : []),
        "---",
        "",
        `# ${input.name}`,
        "",
        input.description?.trim() ? input.description.trim() : "Describe what this skill does.",
        "",
      ].join("\n"));

    await fs.writeFile(skillFilePath, markdown, "utf8");

    const parsed = parseFrontmatterMarkdown(markdown);
    const imported = await upsertImportedSkills(companyId, [{
      key: `company/${companyId}/${slug}`,
      slug,
      name: asString(parsed.frontmatter.name) ?? input.name,
      description: asString(parsed.frontmatter.description) ?? input.description?.trim() ?? null,
      markdown,
      sourceType: "local_path",
      sourceLocator: skillDir,
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "managed_local" },
    }]);

    return imported[0]!;
  }

  async function updateFile(companyId: string, skillId: string, relativePath: string, content: string): Promise<CompanySkillFileDetail> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");

    const source = deriveSkillSourceInfo(skill);
    if (!source.editable || skill.sourceType !== "local_path") {
      throw unprocessable(source.editableReason ?? "This skill cannot be edited.");
    }

    const normalizedPath = normalizePortablePath(relativePath);
    const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
    if (!absolutePath) throw notFound("Skill file not found");

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    if (normalizedPath === "SKILL.md") {
      const parsed = parseFrontmatterMarkdown(content);
      await db
        .update(companySkills)
        .set({
          name: asString(parsed.frontmatter.name) ?? skill.name,
          description: asString(parsed.frontmatter.description) ?? skill.description,
          markdown: content,
          updatedAt: new Date(),
        })
        .where(eq(companySkills.id, skill.id));
    } else {
      await db
        .update(companySkills)
        .set({ updatedAt: new Date() })
        .where(eq(companySkills.id, skill.id));
    }

    const detail = await readFile(companyId, skillId, normalizedPath);
    if (!detail) throw notFound("Skill file not found");
    return detail;
  }

  async function installUpdate(companyId: string, skillId: string): Promise<CompanySkill | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;

    const status = await updateStatus(companyId, skillId);
    if (!status?.supported) {
      throw unprocessable(status?.reason ?? "This skill does not support updates.");
    }
    if (!skill.sourceLocator) {
      throw unprocessable("Skill source locator is missing.");
    }

    const result = await readUrlSkillImports(companyId, skill.sourceLocator, skill.slug);
    const matching = result.skills.find((entry) => entry.key === skill.key) ?? result.skills[0] ?? null;
    if (!matching) {
      throw unprocessable(`Skill ${skill.key} could not be re-imported from its source.`);
    }

    const imported = await upsertImportedSkills(companyId, [matching]);
    return imported[0] ?? null;
  }

  async function scanProjectWorkspaces(
    companyId: string,
    input: CompanySkillProjectScanRequest = {},
  ): Promise<CompanySkillProjectScanResult> {
    await ensureSkillInventoryCurrent(companyId);
    const projectRows = input.projectIds?.length
      ? await projects.listByIds(companyId, input.projectIds)
      : await projects.list(companyId);
    const workspaceFilter = new Set(input.workspaceIds ?? []);
    const skipped: CompanySkillProjectScanSkipped[] = [];
    const conflicts: CompanySkillProjectScanConflict[] = [];
    const warnings: string[] = [];
    const imported: CompanySkill[] = [];
    const updated: CompanySkill[] = [];
    const availableSkills = await listFull(companyId);
    const acceptedSkills = [...availableSkills];
    const acceptedByKey = new Map(acceptedSkills.map((skill) => [skill.key, skill]));
    const scanTargets: ProjectSkillScanTarget[] = [];
    const scannedProjectIds = new Set<string>();
    let discovered = 0;

    const trackWarning = (message: string) => {
      warnings.push(message);
      return message;
    };
    const upsertAcceptedSkill = (skill: CompanySkill) => {
      const nextIndex = acceptedSkills.findIndex((entry) => entry.id === skill.id || entry.key === skill.key);
      if (nextIndex >= 0) acceptedSkills[nextIndex] = skill;
      else acceptedSkills.push(skill);
      acceptedByKey.set(skill.key, skill);
    };

    for (const project of projectRows) {
      for (const workspace of project.workspaces) {
        if (workspaceFilter.size > 0 && !workspaceFilter.has(workspace.id)) continue;
        const workspaceCwd = asString(workspace.cwd);
        if (!workspaceCwd) {
          skipped.push({
            projectId: project.id,
            projectName: project.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            path: null,
            reason: trackWarning(`Skipped ${project.name} / ${workspace.name}: no local workspace path is configured.`),
          });
          continue;
        }

        const workspaceStat = await statPath(workspaceCwd);
        if (!workspaceStat?.isDirectory()) {
          skipped.push({
            projectId: project.id,
            projectName: project.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            path: workspaceCwd,
            reason: trackWarning(`Skipped ${project.name} / ${workspace.name}: local workspace path is not available at ${workspaceCwd}.`),
          });
          continue;
        }

        scanTargets.push({
          projectId: project.id,
          projectName: project.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceCwd,
        });
      }
    }

    for (const target of scanTargets) {
      scannedProjectIds.add(target.projectId);
      const directories = await discoverProjectWorkspaceSkillDirectories(target);

      for (const directory of directories) {
        discovered += 1;

        let nextSkill: ImportedSkill;
        try {
          nextSkill = await readLocalSkillImportFromDirectory(companyId, directory.skillDir, {
            inventoryMode: directory.inventoryMode,
            metadata: {
              sourceKind: "project_scan",
              projectId: target.projectId,
              projectName: target.projectName,
              workspaceId: target.workspaceId,
              workspaceName: target.workspaceName,
              workspaceCwd: target.workspaceCwd,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: directory.skillDir,
            reason: trackWarning(`Skipped ${directory.skillDir}: ${message}`),
          });
          continue;
        }

        const normalizedSourceDir = normalizeSourceLocatorDirectory(nextSkill.sourceLocator);
        const existingByKey = acceptedByKey.get(nextSkill.key) ?? null;
        if (existingByKey) {
          const existingSourceDir = normalizeSkillDirectory(existingByKey);
          if (
            existingByKey.sourceType !== "local_path"
            || !existingSourceDir
            || !normalizedSourceDir
            || existingSourceDir !== normalizedSourceDir
          ) {
            conflicts.push({
              slug: nextSkill.slug,
              key: nextSkill.key,
              projectId: target.projectId,
              projectName: target.projectName,
              workspaceId: target.workspaceId,
              workspaceName: target.workspaceName,
              path: directory.skillDir,
              existingSkillId: existingByKey.id,
              existingSkillKey: existingByKey.key,
              existingSourceLocator: existingByKey.sourceLocator,
              reason: `Skill key ${nextSkill.key} already points at ${existingByKey.sourceLocator ?? "another source"}.`,
            });
            continue;
          }

          const persisted = (await upsertImportedSkills(companyId, [nextSkill]))[0];
          if (!persisted) continue;
          updated.push(persisted);
          upsertAcceptedSkill(persisted);
          continue;
        }

        const slugConflict = acceptedSkills.find((skill) => {
          if (skill.slug !== nextSkill.slug) return false;
          return normalizeSkillDirectory(skill) !== normalizedSourceDir;
        });
        if (slugConflict) {
          conflicts.push({
            slug: nextSkill.slug,
            key: nextSkill.key,
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: directory.skillDir,
            existingSkillId: slugConflict.id,
            existingSkillKey: slugConflict.key,
            existingSourceLocator: slugConflict.sourceLocator,
            reason: `Slug ${nextSkill.slug} is already in use by ${slugConflict.sourceLocator ?? slugConflict.key}.`,
          });
          continue;
        }

        const persisted = (await upsertImportedSkills(companyId, [nextSkill]))[0];
        if (!persisted) continue;
        imported.push(persisted);
        upsertAcceptedSkill(persisted);
      }
    }

    return {
      scannedProjects: scannedProjectIds.size,
      scannedWorkspaces: scanTargets.length,
      discovered,
      imported,
      updated,
      skipped,
      conflicts,
      warnings,
    };
  }

  async function materializeCatalogSkillFiles(
    companyId: string,
    skill: ImportedSkill,
    normalizedFiles: Record<string, string>,
  ) {
    const packageDir = skill.packageDir ? normalizePortablePath(skill.packageDir) : null;
    if (!packageDir) return null;
    const catalogRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__catalog__");
    const skillDir = path.resolve(catalogRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    for (const entry of skill.fileInventory) {
      const sourcePath = entry.path === "SKILL.md"
        ? `${packageDir}/SKILL.md`
        : `${packageDir}/${entry.path}`;
      const content = normalizedFiles[sourcePath];
      if (typeof content !== "string") continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
    }

    return skillDir;
  }

  async function materializeRuntimeSkillFiles(companyId: string, skill: CompanySkill) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__runtime__");
    const skillDir = path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    for (const entry of skill.fileInventory) {
      const detail = await readFile(companyId, skill.id, entry.path).catch(() => null);
      if (!detail) continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, detail.content, "utf8");
    }

    return skillDir;
  }

  function resolveRuntimeSkillMaterializedPath(companyId: string, skill: Pick<CompanySkill, "key" | "slug">) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__runtime__");
    return path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
  }

  async function listRuntimeSkillEntries(
    companyId: string,
    options: RuntimeSkillEntryOptions = {},
  ): Promise<MercurySkillEntry[]> {
    const skills = await listFull(companyId);

    const out: MercurySkillEntry[] = [];
    for (const skill of skills) {
      const sourceKind = asString(getSkillMeta(skill).sourceKind);
      let source = normalizeSkillDirectory(skill);
      if (!source) {
        source = options.materializeMissing === false
          ? resolveRuntimeSkillMaterializedPath(companyId, skill)
          : await materializeRuntimeSkillFiles(companyId, skill).catch(() => null);
      }
      if (!source) continue;

      const required = sourceKind === "mercury_bundled";
      out.push({
        key: skill.key,
        runtimeName: buildSkillRuntimeName(skill.key, skill.slug),
        source,
        required,
        requiredReason: required
          ? "Bundled Mercury skills are always available for local adapters."
          : null,
      });
    }

    out.sort((left, right) => left.key.localeCompare(right.key));
    return out;
  }

  async function importPackageFiles(
    companyId: string,
    files: Record<string, string>,
    options?: {
      onConflict?: PackageSkillConflictStrategy;
    },
  ): Promise<ImportPackageSkillResult[]> {
    await ensureSkillInventoryCurrent(companyId);
    const normalizedFiles = normalizePackageFileMap(files);
    const importedSkills = readInlineSkillImports(companyId, normalizedFiles);
    if (importedSkills.length === 0) return [];

    for (const skill of importedSkills) {
      if (skill.sourceType !== "catalog") continue;
      const materializedDir = await materializeCatalogSkillFiles(companyId, skill, normalizedFiles);
      if (materializedDir) {
        skill.sourceLocator = materializedDir;
      }
    }

    const conflictStrategy = options?.onConflict ?? "replace";
    const existingSkills = await listFull(companyId);
    const existingByKey = new Map(existingSkills.map((skill) => [skill.key, skill]));
    const existingBySlug = new Map(
      existingSkills.map((skill) => [normalizeSkillSlug(skill.slug) ?? skill.slug, skill]),
    );
    const usedSlugs = new Set(existingBySlug.keys());
    const usedKeys = new Set(existingByKey.keys());

    const toPersist: ImportedSkill[] = [];
    const prepared: Array<{
      skill: ImportedSkill;
      originalKey: string;
      originalSlug: string;
      existingBefore: CompanySkill | null;
      actionHint: "created" | "updated";
      reason: string | null;
    }> = [];
    const out: ImportPackageSkillResult[] = [];

    for (const importedSkill of importedSkills) {
      const originalKey = importedSkill.key;
      const originalSlug = importedSkill.slug;
      const normalizedSlug = normalizeSkillSlug(importedSkill.slug) ?? importedSkill.slug;
      const existingByIncomingKey = existingByKey.get(importedSkill.key) ?? null;
      const existingByIncomingSlug = existingBySlug.get(normalizedSlug) ?? null;
      const conflict = existingByIncomingKey ?? existingByIncomingSlug;

      if (!conflict || conflictStrategy === "replace") {
        toPersist.push(importedSkill);
        prepared.push({
          skill: importedSkill,
          originalKey,
          originalSlug,
          existingBefore: existingByIncomingKey,
          actionHint: existingByIncomingKey ? "updated" : "created",
          reason: existingByIncomingKey ? "Existing skill key matched; replace strategy." : null,
        });
        usedSlugs.add(normalizedSlug);
        usedKeys.add(importedSkill.key);
        continue;
      }

      if (conflictStrategy === "skip") {
        out.push({
          skill: conflict,
          action: "skipped",
          originalKey,
          originalSlug,
          requestedRefs: Array.from(new Set([originalKey, originalSlug])),
          reason: "Existing skill matched; skip strategy.",
        });
        continue;
      }

      const renamedSlug = uniqueSkillSlug(normalizedSlug || "skill", usedSlugs);
      const renamedKey = uniqueImportedSkillKey(companyId, renamedSlug, usedKeys);
      const renamedSkill: ImportedSkill = {
        ...importedSkill,
        slug: renamedSlug,
        key: renamedKey,
        metadata: {
          ...(importedSkill.metadata ?? {}),
          skillKey: renamedKey,
          importedFromSkillKey: originalKey,
          importedFromSkillSlug: originalSlug,
        },
      };
      toPersist.push(renamedSkill);
      prepared.push({
        skill: renamedSkill,
        originalKey,
        originalSlug,
        existingBefore: null,
        actionHint: "created",
        reason: `Existing skill matched; renamed to ${renamedSlug}.`,
      });
      usedSlugs.add(renamedSlug);
      usedKeys.add(renamedKey);
    }

    if (toPersist.length === 0) return out;

    const persisted = await upsertImportedSkills(companyId, toPersist);
    for (let index = 0; index < prepared.length; index += 1) {
      const persistedSkill = persisted[index];
      const preparedSkill = prepared[index];
      if (!persistedSkill || !preparedSkill) continue;
      out.push({
        skill: persistedSkill,
        action: preparedSkill.actionHint,
        originalKey: preparedSkill.originalKey,
        originalSlug: preparedSkill.originalSlug,
        requestedRefs: Array.from(new Set([preparedSkill.originalKey, preparedSkill.originalSlug])),
        reason: preparedSkill.reason,
      });
    }

    return out;
  }

  async function upsertImportedSkills(companyId: string, imported: ImportedSkill[]): Promise<CompanySkill[]> {
    const out: CompanySkill[] = [];
    for (const skill of imported) {
      const existing = await getByKey(companyId, skill.key);
      const existingMeta = existing ? getSkillMeta(existing) : {};
      const incomingMeta = skill.metadata && isPlainRecord(skill.metadata) ? skill.metadata : {};
      const incomingOwner = asString(incomingMeta.owner);
      const incomingRepo = asString(incomingMeta.repo);
      const incomingKind = asString(incomingMeta.sourceKind);
      if (
        existing
        && existingMeta.sourceKind === "mercury_bundled"
        && incomingKind === "github"
        && incomingOwner === "StreamDemon"
        && incomingRepo === "mercury"
      ) {
        out.push(existing);
        continue;
      }

      const metadata = {
        ...(skill.metadata ?? {}),
        skillKey: skill.key,
      };
      const values = {
        companyId,
        key: skill.key,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        markdown: skill.markdown,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator,
        sourceRef: skill.sourceRef,
        trustLevel: skill.trustLevel,
        compatibility: skill.compatibility,
        fileInventory: serializeFileInventory(skill.fileInventory),
        metadata,
        updatedAt: new Date(),
      };
      const row = existing
        ? await db
          .update(companySkills)
          .set(values)
          .where(eq(companySkills.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null)
        : await db
          .insert(companySkills)
          .values(values)
          .returning()
          .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Failed to persist company skill");
      out.push(toCompanySkill(row));
    }
    return out;
  }

  async function importFromSource(companyId: string, source: string): Promise<CompanySkillImportResult> {
    await ensureSkillInventoryCurrent(companyId);
    const parsed = parseSkillImportSourceInput(source);
    const local = !/^https?:\/\//i.test(parsed.resolvedSource);
    const { skills, warnings } = local
      ? {
        skills: (await readLocalSkillImports(companyId, parsed.resolvedSource))
          .filter((skill) => !parsed.requestedSkillSlug || skill.slug === parsed.requestedSkillSlug),
        warnings: parsed.warnings,
      }
      : await readUrlSkillImports(companyId, parsed.resolvedSource, parsed.requestedSkillSlug)
        .then((result) => ({
          skills: result.skills,
          warnings: [...parsed.warnings, ...result.warnings],
        }));
    const filteredSkills = parsed.requestedSkillSlug
      ? skills.filter((skill) => skill.slug === parsed.requestedSkillSlug)
      : skills;
    if (filteredSkills.length === 0) {
      throw unprocessable(
        parsed.requestedSkillSlug
          ? `Skill ${parsed.requestedSkillSlug} was not found in the provided source.`
          : "No skills were found in the provided source.",
      );
    }
    // Override sourceType/sourceLocator for skills imported via skills.sh
    if (parsed.originalSkillsShUrl) {
      for (const skill of filteredSkills) {
        skill.sourceType = "skills_sh";
        skill.sourceLocator = parsed.originalSkillsShUrl;
        if (skill.metadata) {
          (skill.metadata as Record<string, unknown>).sourceKind = "skills_sh";
        }
        skill.key = deriveCanonicalSkillKey(companyId, skill);
      }
    }
    const imported = await upsertImportedSkills(companyId, filteredSkills);
    return { imported, warnings };
  }

  async function deleteSkill(companyId: string, skillId: string): Promise<CompanySkill | null> {
    const row = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.id, skillId), eq(companySkills.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;

    const skill = toCompanySkill(row);
    const usedByAgents = await usage(companyId, skill.key);

    if (usedByAgents.length > 0) {
      const agentNames = usedByAgents.map((agent) => agent.name).sort((left, right) => left.localeCompare(right));
      throw unprocessable(
        `Cannot delete skill "${skill.name}" while it is still used by ${agentNames.join(", ")}. Detach it from those agents first.`,
        {
          skillId: skill.id,
          skillKey: skill.key,
          usedByAgents: usedByAgents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            urlKey: agent.urlKey,
            adapterType: agent.adapterType,
          })),
        },
      );
    }

    // Delete DB row
    await db
      .delete(companySkills)
      .where(eq(companySkills.id, skillId));

    // Clean up materialized runtime files
    await fs.rm(resolveRuntimeSkillMaterializedPath(companyId, skill), { recursive: true, force: true });

    return skill;
  }

  return {
    list,
    listFull,
    getById,
    getByKey,
    resolveRequestedSkillKeys: async (companyId: string, requestedReferences: string[]) => {
      const skills = await listFull(companyId);
      return resolveRequestedSkillKeysOrThrow(skills, requestedReferences);
    },
    detail,
    updateStatus,
    readFile,
    updateFile,
    createLocalSkill,
    deleteSkill,
    importFromSource,
    scanProjectWorkspaces,
    importPackageFiles,
    installUpdate,
    listRuntimeSkillEntries,
  };
}
