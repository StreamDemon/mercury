import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@mercuryai/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createMercuryRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"mercury"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

describe("codex local adapter skill injection", () => {
  const mercuryKey = "StreamDemon/mercury/mercury";
  const createAgentKey = "StreamDemon/mercury/mercury-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex Mercury skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("mercury-codex-current-");
    const oldRepo = await makeTempDir("mercury-codex-old-");
    const skillsHome = await makeTempDir("mercury-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createMercuryRepoSkill(currentRepo, "mercury");
    await createMercuryRepoSkill(currentRepo, "mercury-create-agent");
    await createMercuryRepoSkill(oldRepo, "mercury");
    await fs.symlink(path.join(oldRepo, "skills", "mercury"), path.join(skillsHome, "mercury"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [
          {
            key: mercuryKey,
            runtimeName: "mercury",
            source: path.join(currentRepo, "skills", "mercury"),
          },
          {
            key: createAgentKey,
            runtimeName: "mercury-create-agent",
            source: path.join(currentRepo, "skills", "mercury-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "mercury"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "mercury")),
    );
    expect(await fs.realpath(path.join(skillsHome, "mercury-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "mercury-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "mercury"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "mercury-create-agent"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside Mercury repo checkouts", async () => {
    const currentRepo = await makeTempDir("mercury-codex-current-");
    const customRoot = await makeTempDir("mercury-codex-custom-");
    const skillsHome = await makeTempDir("mercury-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createMercuryRepoSkill(currentRepo, "mercury");
    await createCustomSkill(customRoot, "mercury");
    await fs.symlink(path.join(customRoot, "custom", "mercury"), path.join(skillsHome, "mercury"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: mercuryKey,
        runtimeName: "mercury",
        source: path.join(currentRepo, "skills", "mercury"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "mercury"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "mercury")),
    );
  });

  it("prunes broken symlinks for unavailable Mercury repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("mercury-codex-current-");
    const oldRepo = await makeTempDir("mercury-codex-old-");
    const skillsHome = await makeTempDir("mercury-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createMercuryRepoSkill(currentRepo, "mercury");
    await createMercuryRepoSkill(oldRepo, "agent-browser");
    const staleTarget = path.join(oldRepo, "skills", "agent-browser");
    await fs.symlink(staleTarget, path.join(skillsHome, "agent-browser"));
    await fs.rm(staleTarget, { recursive: true, force: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: mercuryKey,
          runtimeName: "mercury",
          source: path.join(currentRepo, "skills", "mercury"),
        }],
      },
    );

    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex skill "agent-browser"'),
      }),
    );
  });

  it("preserves other live Mercury skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("mercury-codex-current-");
    const skillsHome = await makeTempDir("mercury-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createMercuryRepoSkill(currentRepo, "mercury");
    await createMercuryRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: mercuryKey,
        runtimeName: "mercury",
        source: path.join(currentRepo, "skills", "mercury"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "mercury"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
