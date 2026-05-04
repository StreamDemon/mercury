import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOpenCodeSkills,
  syncOpenCodeSkills,
} from "@mercuryai/adapter-opencode-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("opencode local skill sync", () => {
  const mercuryKey = "StreamDemon/mercury/mercury";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Mercury skills and installs them into the shared Claude/OpenCode skills home", async () => {
    const home = await makeTempDir("mercury-opencode-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        mercurySkillSync: {
          desiredSkills: [mercuryKey],
        },
      },
    } as const;

    const before = await listOpenCodeSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.warnings).toContain("OpenCode currently uses the shared Claude skills home (~/.claude/skills).");
    expect(before.desiredSkills).toContain(mercuryKey);
    expect(before.entries.find((entry) => entry.key === mercuryKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === mercuryKey)?.state).toBe("missing");

    const after = await syncOpenCodeSkills(ctx, [mercuryKey]);
    expect(after.entries.find((entry) => entry.key === mercuryKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "mercury"))).isSymbolicLink()).toBe(true);
  });

  it("keeps required bundled Mercury skills installed even when the desired set is emptied", async () => {
    const home = await makeTempDir("mercury-opencode-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        mercurySkillSync: {
          desiredSkills: [mercuryKey],
        },
      },
    } as const;

    await syncOpenCodeSkills(configuredCtx, [mercuryKey]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          HOME: home,
        },
        mercurySkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncOpenCodeSkills(clearedCtx, []);
    expect(after.desiredSkills).toContain(mercuryKey);
    expect(after.entries.find((entry) => entry.key === mercuryKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "mercury"))).isSymbolicLink()).toBe(true);
  });
});
