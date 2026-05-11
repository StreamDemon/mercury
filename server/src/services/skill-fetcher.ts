import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CompanySkillFileInventoryEntry } from "@mercuryai/shared";
import { parseFrontmatterMarkdown } from "@mercuryai/shared/yaml-codec";

import { unprocessable } from "../errors.js";
import {
  fetchJson,
  fetchText,
  gitHubApiBase,
  parseSkillSourceGitHubUrl,
  resolveGitHubPinnedRef,
  resolveRawGitHubUrl,
} from "./github-fetch.js";
import {
  asString,
  classifyInventoryKind,
  deriveCanonicalSkillKey,
  deriveImportedSkillSlug,
  deriveImportedSkillSource,
  deriveTrustLevel,
  isPlainRecord,
  normalizeGitHubSkillDirectory,
  normalizePortablePath,
  normalizeSkillSlug,
  readCanonicalSkillKey,
  type ImportedSkill,
} from "./skill-source.js";

export type LocalSkillInventoryMode = "full" | "project_root";

export type ProjectSkillScanTarget = {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
};

const PROJECT_SCAN_DIRECTORY_ROOTS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".agent/skills",
  ".augment/skills",
  ".claude/skills",
  ".codebuddy/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".factory/skills",
  ".goose/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilocode/skills",
  ".kiro/skills",
  ".kode/skills",
  ".mcpjam/skills",
  ".vibe/skills",
  ".mux/skills",
  ".openhands/skills",
  ".pi/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".roo/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
] as const;

const PROJECT_ROOT_SKILL_SUBDIRECTORIES = [
  "references",
  "scripts",
  "assets",
] as const;

export function normalizePackageFileMap(files: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    const nextPath = normalizePortablePath(rawPath);
    if (!nextPath) continue;
    out[nextPath] = content;
  }
  return out;
}

export function resolveBundledSkillsRoot() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "../../skills"),
    path.resolve(process.cwd(), "skills"),
    path.resolve(moduleDir, "../../../skills"),
  ];
}

function matchesRequestedSkill(relativeSkillPath: string, requestedSkillSlug: string | null) {
  if (!requestedSkillSlug) return true;
  const skillDir = path.posix.dirname(relativeSkillPath);
  return normalizeSkillSlug(path.posix.basename(skillDir)) === requestedSkillSlug;
}

export function readInlineSkillImports(companyId: string, files: Record<string, string>): ImportedSkill[] {
  const normalizedFiles = normalizePackageFileMap(files);
  const skillPaths = Object.keys(normalizedFiles).filter(
    (entry) => path.posix.basename(entry).toLowerCase() === "skill.md",
  );
  const imports: ImportedSkill[] = [];

  for (const skillPath of skillPaths) {
    const dir = path.posix.dirname(skillPath);
    const skillDir = dir === "." ? "" : dir;
    const slugFallback = path.posix.basename(skillDir || path.posix.dirname(skillPath));
    const markdown = normalizedFiles[skillPath]!;
    const parsed = parseFrontmatterMarkdown(markdown);
    const slug = deriveImportedSkillSlug(parsed.frontmatter, slugFallback);
    const source = deriveImportedSkillSource(parsed.frontmatter, slug);
    const inventory = Object.keys(normalizedFiles)
      .filter((entry) => entry === skillPath || (skillDir ? entry.startsWith(`${skillDir}/`) : false))
      .map((entry) => {
        const relative = entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1);
        return {
          path: normalizePortablePath(relative),
          kind: classifyInventoryKind(relative),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    imports.push({
      key: "",
      slug,
      name: asString(parsed.frontmatter.name) ?? slug,
      description: asString(parsed.frontmatter.description),
      markdown,
      packageDir: skillDir,
      sourceType: source.sourceType,
      sourceLocator: source.sourceLocator,
      sourceRef: source.sourceRef,
      trustLevel: deriveTrustLevel(inventory),
      compatibility: "compatible",
      fileInventory: inventory,
      metadata: source.metadata,
    });
    imports[imports.length - 1]!.key = deriveCanonicalSkillKey(companyId, imports[imports.length - 1]!);
  }

  return imports;
}

async function walkLocalFiles(root: string, current: string, out: string[]) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkLocalFiles(root, absolutePath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(normalizePortablePath(path.relative(root, absolutePath)));
  }
}

export async function statPath(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function collectLocalSkillInventory(
  skillDir: string,
  mode: LocalSkillInventoryMode = "full",
): Promise<CompanySkillFileInventoryEntry[]> {
  const skillFilePath = path.join(skillDir, "SKILL.md");
  const skillFileStat = await statPath(skillFilePath);
  if (!skillFileStat?.isFile()) {
    throw unprocessable(`No SKILL.md file was found in ${skillDir}.`);
  }

  const allFiles = new Set<string>(["SKILL.md"]);
  if (mode === "full") {
    const discoveredFiles: string[] = [];
    await walkLocalFiles(skillDir, skillDir, discoveredFiles);
    for (const relativePath of discoveredFiles) {
      allFiles.add(relativePath);
    }
  } else {
    for (const relativeDir of PROJECT_ROOT_SKILL_SUBDIRECTORIES) {
      const absoluteDir = path.join(skillDir, relativeDir);
      const dirStat = await statPath(absoluteDir);
      if (!dirStat?.isDirectory()) continue;
      const discoveredFiles: string[] = [];
      await walkLocalFiles(skillDir, absoluteDir, discoveredFiles);
      for (const relativePath of discoveredFiles) {
        allFiles.add(relativePath);
      }
    }
  }

  return Array.from(allFiles)
    .map((relativePath) => ({
      path: normalizePortablePath(relativePath),
      kind: classifyInventoryKind(relativePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function readLocalSkillImportFromDirectory(
  companyId: string,
  skillDir: string,
  options?: {
    inventoryMode?: LocalSkillInventoryMode;
    metadata?: Record<string, unknown> | null;
  },
): Promise<ImportedSkill> {
  const resolvedSkillDir = path.resolve(skillDir);
  const skillFilePath = path.join(resolvedSkillDir, "SKILL.md");
  const markdown = await fs.readFile(skillFilePath, "utf8");
  const parsed = parseFrontmatterMarkdown(markdown);
  const slug = deriveImportedSkillSlug(parsed.frontmatter, path.basename(resolvedSkillDir));
  const parsedMetadata = isPlainRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : null;
  const skillKey = readCanonicalSkillKey(parsed.frontmatter, parsedMetadata);
  const metadata = {
    ...(skillKey ? { skillKey } : {}),
    ...(parsedMetadata ?? {}),
    sourceKind: "local_path",
    ...(options?.metadata ?? {}),
  };
  const inventory = await collectLocalSkillInventory(resolvedSkillDir, options?.inventoryMode ?? "full");

  return {
    key: deriveCanonicalSkillKey(companyId, {
      slug,
      sourceType: "local_path",
      sourceLocator: resolvedSkillDir,
      metadata,
    }),
    slug,
    name: asString(parsed.frontmatter.name) ?? slug,
    description: asString(parsed.frontmatter.description),
    markdown,
    packageDir: resolvedSkillDir,
    sourceType: "local_path",
    sourceLocator: resolvedSkillDir,
    sourceRef: null,
    trustLevel: deriveTrustLevel(inventory),
    compatibility: "compatible",
    fileInventory: inventory,
    metadata,
  };
}

export async function discoverProjectWorkspaceSkillDirectories(target: ProjectSkillScanTarget): Promise<Array<{
  skillDir: string;
  inventoryMode: LocalSkillInventoryMode;
}>> {
  const discovered = new Map<string, LocalSkillInventoryMode>();
  const rootSkillPath = path.join(target.workspaceCwd, "SKILL.md");
  if ((await statPath(rootSkillPath))?.isFile()) {
    discovered.set(path.resolve(target.workspaceCwd), "project_root");
  }

  for (const relativeRoot of PROJECT_SCAN_DIRECTORY_ROOTS) {
    const absoluteRoot = path.join(target.workspaceCwd, relativeRoot);
    const rootStat = await statPath(absoluteRoot);
    if (!rootStat?.isDirectory()) continue;

    const entries = await fs.readdir(absoluteRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absoluteSkillDir = path.resolve(absoluteRoot, entry.name);
      if (!(await statPath(path.join(absoluteSkillDir, "SKILL.md")))?.isFile()) continue;
      discovered.set(absoluteSkillDir, "full");
    }
  }

  return Array.from(discovered.entries())
    .map(([skillDir, inventoryMode]) => ({ skillDir, inventoryMode }))
    .sort((left, right) => left.skillDir.localeCompare(right.skillDir));
}

export async function readLocalSkillImports(companyId: string, sourcePath: string): Promise<ImportedSkill[]> {
  const resolvedPath = path.resolve(sourcePath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat) {
    throw unprocessable(`Skill source path does not exist: ${sourcePath}`);
  }

  if (stat.isFile()) {
    const markdown = await fs.readFile(resolvedPath, "utf8");
    const parsed = parseFrontmatterMarkdown(markdown);
    const slug = deriveImportedSkillSlug(parsed.frontmatter, path.basename(path.dirname(resolvedPath)));
    const parsedMetadata = isPlainRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : null;
    const skillKey = readCanonicalSkillKey(parsed.frontmatter, parsedMetadata);
    const metadata = {
      ...(skillKey ? { skillKey } : {}),
      ...(parsedMetadata ?? {}),
      sourceKind: "local_path",
    };
    const inventory: CompanySkillFileInventoryEntry[] = [
      { path: "SKILL.md", kind: "skill" },
    ];
    return [{
      key: deriveCanonicalSkillKey(companyId, {
        slug,
        sourceType: "local_path",
        sourceLocator: path.dirname(resolvedPath),
        metadata,
      }),
      slug,
      name: asString(parsed.frontmatter.name) ?? slug,
      description: asString(parsed.frontmatter.description),
      markdown,
      packageDir: path.dirname(resolvedPath),
      sourceType: "local_path",
      sourceLocator: path.dirname(resolvedPath),
      sourceRef: null,
      trustLevel: deriveTrustLevel(inventory),
      compatibility: "compatible",
      fileInventory: inventory,
      metadata,
    }];
  }

  const root = resolvedPath;
  const allFiles: string[] = [];
  await walkLocalFiles(root, root, allFiles);
  const skillPaths = allFiles.filter((entry) => path.posix.basename(entry).toLowerCase() === "skill.md");
  if (skillPaths.length === 0) {
    throw unprocessable("No SKILL.md files were found in the provided path.");
  }

  const imports: ImportedSkill[] = [];
  for (const skillPath of skillPaths) {
    const skillDir = path.posix.dirname(skillPath);
    const inventory = allFiles
      .filter((entry) => entry === skillPath || entry.startsWith(`${skillDir}/`))
      .map((entry) => {
        const relative = entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1);
        return {
          path: normalizePortablePath(relative),
          kind: classifyInventoryKind(relative),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    const imported = await readLocalSkillImportFromDirectory(companyId, path.join(root, skillDir));
    imported.fileInventory = inventory;
    imported.trustLevel = deriveTrustLevel(inventory);
    imports.push(imported);
  }

  return imports;
}

export async function readUrlSkillImports(
  companyId: string,
  sourceUrl: string,
  requestedSkillSlug: string | null = null,
): Promise<{ skills: ImportedSkill[]; warnings: string[] }> {
  const url = sourceUrl.trim();
  const warnings: string[] = [];
  const looksLikeRepoUrl = (() => { try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const h = parsed.hostname.toLowerCase();
    if (h.endsWith(".githubusercontent.com") || h === "gist.github.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length >= 2 && !parsed.pathname.endsWith(".md");
  } catch { return false; } })();
  if (looksLikeRepoUrl) {
    const parsed = parseSkillSourceGitHubUrl(url);
    const apiBase = gitHubApiBase(parsed.hostname);
    const { pinnedRef, trackingRef } = await resolveGitHubPinnedRef(parsed);
    let ref = pinnedRef;
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => {
      throw unprocessable(`Failed to read GitHub tree for ${url}`);
    });
    const allPaths = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === "string");
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const scopedPaths = basePrefix
      ? allPaths.filter((entry) => entry.startsWith(basePrefix))
      : allPaths;
    const relativePaths = scopedPaths.map((entry) => basePrefix ? entry.slice(basePrefix.length) : entry);
    const filteredPaths = parsed.filePath
      ? relativePaths.filter((entry) => entry === path.posix.relative(parsed.basePath || ".", parsed.filePath!))
      : relativePaths;
    const skillPaths = filteredPaths.filter(
      (entry) => path.posix.basename(entry).toLowerCase() === "skill.md",
    );
    if (skillPaths.length === 0) {
      throw unprocessable(
        "No SKILL.md files were found in the provided GitHub source.",
      );
    }
    const skills: ImportedSkill[] = [];
    for (const relativeSkillPath of skillPaths) {
      const repoSkillPath = basePrefix ? `${basePrefix}${relativeSkillPath}` : relativeSkillPath;
      const markdown = await fetchText(resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoSkillPath));
      const parsedMarkdown = parseFrontmatterMarkdown(markdown);
      const skillDir = path.posix.dirname(relativeSkillPath);
      const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, path.posix.basename(skillDir));
      const skillKey = readCanonicalSkillKey(
        parsedMarkdown.frontmatter,
        isPlainRecord(parsedMarkdown.frontmatter.metadata) ? parsedMarkdown.frontmatter.metadata : null,
      );
      if (requestedSkillSlug && !matchesRequestedSkill(relativeSkillPath, requestedSkillSlug) && slug !== requestedSkillSlug) {
        continue;
      }
      const metadata = {
        ...(skillKey ? { skillKey } : {}),
        sourceKind: "github",
        ...(parsed.hostname !== "github.com" ? { hostname: parsed.hostname } : {}),
        owner: parsed.owner,
        repo: parsed.repo,
        ref,
        trackingRef,
        repoSkillDir: normalizeGitHubSkillDirectory(
          basePrefix ? `${basePrefix}${skillDir}` : skillDir,
          slug,
        ),
      };
      const inventory = filteredPaths
        .filter((entry) => entry === relativeSkillPath || entry.startsWith(`${skillDir}/`))
        .map((entry) => ({
          path: entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
          kind: classifyInventoryKind(entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1)),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      skills.push({
        key: deriveCanonicalSkillKey(companyId, {
          slug,
          sourceType: "github",
          sourceLocator: sourceUrl,
          metadata,
        }),
        slug,
        name: asString(parsedMarkdown.frontmatter.name) ?? slug,
        description: asString(parsedMarkdown.frontmatter.description),
        markdown,
        sourceType: "github",
        sourceLocator: sourceUrl,
        sourceRef: ref,
        trustLevel: deriveTrustLevel(inventory),
        compatibility: "compatible",
        fileInventory: inventory,
        metadata,
      });
    }
    if (skills.length === 0) {
      throw unprocessable(
        requestedSkillSlug
          ? `Skill ${requestedSkillSlug} was not found in the provided GitHub source.`
          : "No SKILL.md files were found in the provided GitHub source.",
      );
    }
    return { skills, warnings };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    const markdown = await fetchText(url);
    const parsedMarkdown = parseFrontmatterMarkdown(markdown);
    const urlObj = new URL(url);
    const fileName = path.posix.basename(urlObj.pathname);
    const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, fileName.replace(/\.md$/i, ""));
    const skillKey = readCanonicalSkillKey(
      parsedMarkdown.frontmatter,
      isPlainRecord(parsedMarkdown.frontmatter.metadata) ? parsedMarkdown.frontmatter.metadata : null,
    );
    const metadata = {
      ...(skillKey ? { skillKey } : {}),
      sourceKind: "url",
    };
    const inventory: CompanySkillFileInventoryEntry[] = [{ path: "SKILL.md", kind: "skill" }];
    return {
      skills: [{
        key: deriveCanonicalSkillKey(companyId, {
          slug,
          sourceType: "url",
          sourceLocator: url,
          metadata,
        }),
        slug,
        name: asString(parsedMarkdown.frontmatter.name) ?? slug,
        description: asString(parsedMarkdown.frontmatter.description),
        markdown,
        sourceType: "url",
        sourceLocator: url,
        sourceRef: null,
        trustLevel: deriveTrustLevel(inventory),
        compatibility: "compatible",
        fileInventory: inventory,
        metadata,
      }],
      warnings,
    };
  }

  throw unprocessable("Unsupported skill source. Use a local path or URL.");
}
