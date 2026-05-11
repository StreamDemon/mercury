import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverProjectWorkspaceSkillDirectories,
  readInlineSkillImports,
  readLocalSkillImportFromDirectory,
  readLocalSkillImports,
  readUrlSkillImports,
  resolveBundledSkillsRoot,
  statPath,
} from "./skill-fetcher.js";

const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const SHA40 = "1234567890abcdef1234567890abcdef12345678";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
  vi.unstubAllGlobals();
});

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

async function writeSkillDir(skillDir: string, name: string) {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`, "utf8");
}

describe("resolveBundledSkillsRoot", () => {
  it("returns three absolute candidate paths in dev/cwd/prod order", () => {
    const result = resolveBundledSkillsRoot();
    expect(result).toHaveLength(3);
    expect(result.every((p) => path.isAbsolute(p))).toBe(true);
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    expect(result[0]).toBe(path.resolve(moduleDir, "../../skills"));
    expect(result[1]).toBe(path.resolve(process.cwd(), "skills"));
    expect(result[2]).toBe(path.resolve(moduleDir, "../../../skills"));
  });
});

describe("statPath", () => {
  it("returns Stats for an existing path and null for a missing one", async () => {
    const dir = await makeTempDir("mercury-statpath-");
    const stats = await statPath(dir);
    expect(stats?.isDirectory()).toBe(true);
    const missing = await statPath(path.join(dir, "nope"));
    expect(missing).toBeNull();
  });
});

describe("discoverProjectWorkspaceSkillDirectories", () => {
  it("finds bounded skill roots under supported workspace paths", async () => {
    const workspace = await makeTempDir("mercury-skill-workspace-");
    await writeSkillDir(workspace, "Workspace Root");
    await writeSkillDir(path.join(workspace, "skills", "find-skills"), "Find Skills");
    await writeSkillDir(path.join(workspace, ".agents", "skills", "release"), "Release");
    await writeSkillDir(path.join(workspace, "skills", ".system", "mercury"), "Mercury");
    await fs.writeFile(path.join(workspace, "README.md"), "# ignore\n", "utf8");

    const discovered = await discoverProjectWorkspaceSkillDirectories({
      projectId: "11111111-1111-1111-1111-111111111111",
      projectName: "Repo",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      workspaceName: "Main",
      workspaceCwd: workspace,
    });

    expect(discovered).toEqual([
      { skillDir: path.resolve(workspace), inventoryMode: "project_root" },
      { skillDir: path.resolve(workspace, ".agents", "skills", "release"), inventoryMode: "full" },
      { skillDir: path.resolve(workspace, "skills", ".system", "mercury"), inventoryMode: "full" },
      { skillDir: path.resolve(workspace, "skills", "find-skills"), inventoryMode: "full" },
    ]);
  });

  it("returns an empty array when no SKILL.md is present", async () => {
    const workspace = await makeTempDir("mercury-empty-workspace-");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "# nope\n", "utf8");

    const discovered = await discoverProjectWorkspaceSkillDirectories({
      projectId: "11111111-1111-1111-1111-111111111111",
      projectName: "Repo",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      workspaceName: "Main",
      workspaceCwd: workspace,
    });

    expect(discovered).toEqual([]);
  });
});

describe("readLocalSkillImportFromDirectory", () => {
  it("limits root SKILL.md imports to skill-related support folders", async () => {
    const workspace = await makeTempDir("mercury-root-skill-");
    await writeSkillDir(workspace, "Workspace Skill");
    await fs.mkdir(path.join(workspace, "references"), { recursive: true });
    await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "references", "checklist.md"), "# Checklist\n", "utf8");
    await fs.writeFile(path.join(workspace, "scripts", "run.sh"), "echo ok\n", "utf8");
    await fs.writeFile(path.join(workspace, "assets", "logo.svg"), "<svg />\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# Repo\n", "utf8");
    await fs.writeFile(path.join(workspace, "src", "index.ts"), "export {};\n", "utf8");

    const imported = await readLocalSkillImportFromDirectory(
      COMPANY_ID,
      workspace,
      { inventoryMode: "project_root", metadata: { sourceKind: "project_scan" } },
    );

    expect(new Set(imported.fileInventory.map((entry) => entry.path))).toEqual(new Set([
      "assets/logo.svg",
      "references/checklist.md",
      "scripts/run.sh",
      "SKILL.md",
    ]));
    expect(imported.fileInventory.map((entry) => entry.kind)).toContain("script");
    expect(imported.metadata?.sourceKind).toBe("project_scan");
  });

  it("parses inline object array items in skill frontmatter metadata", async () => {
    const workspace = await makeTempDir("mercury-inline-skill-yaml-");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "SKILL.md"),
      [
        "---",
        "name: Inline Metadata Skill",
        "metadata:",
        "  sources:",
        "    - kind: github-dir",
        "      repo: StreamDemon/mercury",
        "      path: skills/mercury",
        "---",
        "",
        "# Inline Metadata Skill",
        "",
      ].join("\n"),
      "utf8",
    );

    const imported = await readLocalSkillImportFromDirectory(
      COMPANY_ID,
      workspace,
      { inventoryMode: "full" },
    );

    expect(imported.metadata).toMatchObject({
      sourceKind: "local_path",
      sources: [
        {
          kind: "github-dir",
          repo: "StreamDemon/mercury",
          path: "skills/mercury",
        },
      ],
    });
  });
});

describe("readLocalSkillImports", () => {
  it("returns a single import for a SKILL.md file path", async () => {
    const workspace = await makeTempDir("mercury-local-skill-file-");
    await writeSkillDir(workspace, "Solo Skill");
    const skillFilePath = path.join(workspace, "SKILL.md");

    const imports = await readLocalSkillImports(COMPANY_ID, skillFilePath);

    expect(imports).toHaveLength(1);
    expect(imports[0]!.name).toBe("Solo Skill");
    expect(imports[0]!.sourceType).toBe("local_path");
    expect(imports[0]!.fileInventory).toEqual([{ path: "SKILL.md", kind: "skill" }]);
  });

  it("returns multiple sorted imports for a directory tree with nested SKILL.md files", async () => {
    const workspace = await makeTempDir("mercury-local-skill-tree-");
    await writeSkillDir(path.join(workspace, "alpha"), "Alpha Skill");
    await writeSkillDir(path.join(workspace, "beta"), "Beta Skill");

    const imports = await readLocalSkillImports(COMPANY_ID, workspace);

    expect(imports).toHaveLength(2);
    const slugs = imports.map((skill) => skill.slug).sort();
    expect(slugs).toEqual(["Alpha-Skill", "Beta-Skill"]);
  });

  it("throws when the path is missing", async () => {
    const workspace = await makeTempDir("mercury-local-skill-missing-");
    await expect(
      readLocalSkillImports(COMPANY_ID, path.join(workspace, "does-not-exist")),
    ).rejects.toThrow(/does not exist/);
  });

  it("throws when a directory tree contains no SKILL.md", async () => {
    const workspace = await makeTempDir("mercury-local-skill-empty-");
    await fs.writeFile(path.join(workspace, "README.md"), "# nope\n", "utf8");
    await expect(
      readLocalSkillImports(COMPANY_ID, workspace),
    ).rejects.toThrow(/No SKILL\.md files were found/);
  });
});

describe("readInlineSkillImports", () => {
  it("derives slug and inventory from an inline files map with one SKILL.md", () => {
    const files = {
      "my-skill/SKILL.md": "---\nname: My Skill\n---\n\n# My Skill\n",
      "my-skill/references/notes.md": "# Notes\n",
    };

    const imports = readInlineSkillImports(COMPANY_ID, files);

    expect(imports).toHaveLength(1);
    expect(imports[0]!.slug).toBe("My-Skill");
    expect(imports[0]!.name).toBe("My Skill");
    expect(imports[0]!.fileInventory.map((entry) => entry.path).sort()).toEqual([
      "SKILL.md",
      "references/notes.md",
    ]);
  });

  it("returns an empty array when no SKILL.md is present in the files map", () => {
    const files = {
      "README.md": "# nope\n",
      "src/index.ts": "export {};\n",
    };

    expect(readInlineSkillImports(COMPANY_ID, files)).toEqual([]);
  });
});

describe("readUrlSkillImports", () => {
  it("fetches a GitHub repo URL via the trees + raw APIs", async () => {
    const skillPath = "skills/find-skills/SKILL.md";
    const markdownBody = "---\nname: Find Skills\n---\n\n# Find Skills\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/git/trees/")) {
          return new Response(
            JSON.stringify({
              tree: [
                { type: "blob", path: skillPath },
                { type: "blob", path: "skills/find-skills/references/notes.md" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(`/${SHA40}/${skillPath}`)) {
          return new Response(markdownBody, { status: 200 });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }),
    );

    const result = await readUrlSkillImports(
      COMPANY_ID,
      `https://github.com/StreamDemon/mercury/tree/${SHA40}`,
    );

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.slug).toBe("Find-Skills");
    expect(result.skills[0]!.sourceType).toBe("github");
    expect(result.skills[0]!.sourceRef).toBe(SHA40);
    expect(result.skills[0]!.metadata).toMatchObject({
      sourceKind: "github",
      owner: "StreamDemon",
      repo: "mercury",
      ref: SHA40,
    });
  });

  it("returns a single import for a raw .md URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("---\nname: Direct Skill\n---\n\n# Direct\n", { status: 200 })),
    );

    const result = await readUrlSkillImports(
      COMPANY_ID,
      "https://example.test/skills/direct/SKILL.md",
    );

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.sourceType).toBe("url");
    expect(result.skills[0]!.name).toBe("Direct Skill");
  });

  it("throws when the URL scheme is unsupported", async () => {
    await expect(
      readUrlSkillImports(COMPANY_ID, "ftp://example.test/skills"),
    ).rejects.toThrow(/Unsupported skill source/);
  });

  it("rejects plain http URLs (TLS is required for skill imports)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readUrlSkillImports(COMPANY_ID, "http://example.test/skills/direct/SKILL.md"),
    ).rejects.toThrow(/Unsupported skill source/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Pins current behavior of the requestedSkillSlug fallback at the body of
  // readUrlSkillImports (the "slug !== requestedSkillSlug" OR-clause).
  // When the requested slug does not match the folder name but DOES match
  // the frontmatter-derived slug, the skill is still included.
  // Identified as a possible pre-existing bug; not addressed in this slice.
  it("requestedSkillSlug fallback: includes a skill whose folder name differs but whose frontmatter slug matches", async () => {
    const folderSkillPath = "skills/old-folder-name/SKILL.md";
    const markdownBody = "---\nname: renamed-skill\n---\n\n# renamed-skill\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/git/trees/")) {
          return new Response(
            JSON.stringify({ tree: [{ type: "blob", path: folderSkillPath }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(folderSkillPath)) {
          return new Response(markdownBody, { status: 200 });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }),
    );

    const result = await readUrlSkillImports(
      COMPANY_ID,
      `https://github.com/StreamDemon/mercury/tree/${SHA40}`,
      "renamed-skill",
    );

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.slug).toBe("renamed-skill");
  });
});
