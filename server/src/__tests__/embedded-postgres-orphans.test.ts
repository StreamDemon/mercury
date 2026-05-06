import { describe, expect, it, vi } from "vitest";
import {
  commandLineLooksLikeEmbeddedPostgres,
  commandLineLooksLikeIoWorker,
  commandLineMatchesDataDir,
  formatOrphanCandidatesForDiagnostic,
  recoverEmbeddedPostgresOrphans,
  type OrphanProcess,
  type OrphanRecoveryLogger,
} from "../embedded-postgres-orphans.js";

const dataDir = "C:/Users/test/.mercury/instances/default/db";
const otherDataDir = "C:/Users/test/.mercury/instances/worktree-a/db";
const embeddedBinary =
  "D:/Projects/Mercury/node_modules/.pnpm/@embedded-postgres+windows-x64@18.1.0-beta.16/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe";

function silentLogger(): OrphanRecoveryLogger & { entries: Array<{ level: string; ctx: unknown; msg: string }> } {
  const entries: Array<{ level: string; ctx: unknown; msg: string }> = [];
  return {
    entries,
    info: (ctx, msg) => entries.push({ level: "info", ctx, msg }),
    warn: (ctx, msg) => entries.push({ level: "warn", ctx, msg }),
  };
}

describe("commandLineMatchesDataDir", () => {
  it("matches `-D <dir>` with spaces and forward slashes", () => {
    const cmd = `${embeddedBinary} -D ${dataDir} -p 54329`;
    expect(commandLineMatchesDataDir(cmd, dataDir)).toBe(true);
  });

  it("matches `-D<dir>` without separator", () => {
    const cmd = `${embeddedBinary} -D${dataDir} -p 54329`;
    expect(commandLineMatchesDataDir(cmd, dataDir)).toBe(true);
  });

  it("matches when command line uses backslashes but data dir uses forward slashes", () => {
    const cmd = `${embeddedBinary} -D ${dataDir.replace(/\//g, "\\")} -p 54329`;
    expect(commandLineMatchesDataDir(cmd, dataDir)).toBe(true);
  });

  it("does not match a different data dir", () => {
    const cmd = `${embeddedBinary} -D ${otherDataDir} -p 54329`;
    expect(commandLineMatchesDataDir(cmd, dataDir)).toBe(false);
  });

  it("does not match an io_worker command line (no -D flag)", () => {
    const cmd = `${embeddedBinary} --forkchild="io_worker" 5944`;
    expect(commandLineMatchesDataDir(cmd, dataDir)).toBe(false);
  });

  it("returns false for empty command lines", () => {
    expect(commandLineMatchesDataDir("", dataDir)).toBe(false);
  });
});

describe("commandLineLooksLikeIoWorker / EmbeddedPostgres", () => {
  it("identifies forkchild io_worker", () => {
    expect(commandLineLooksLikeIoWorker(`${embeddedBinary} --forkchild="io_worker" 5944`)).toBe(true);
  });

  it("does not flag postmaster as io_worker", () => {
    expect(commandLineLooksLikeIoWorker(`${embeddedBinary} -D ${dataDir}`)).toBe(false);
  });

  it("recognizes embedded-postgres binary path", () => {
    expect(commandLineLooksLikeEmbeddedPostgres(embeddedBinary)).toBe(true);
  });

  it("does not flag system postgres binary", () => {
    expect(commandLineLooksLikeEmbeddedPostgres("/usr/local/bin/postgres -D /var/db")).toBe(false);
  });
});

describe("recoverEmbeddedPostgresOrphans", () => {
  it("reports no-orphans when no postgres processes exist and no pidfile", async () => {
    const logger = silentLogger();
    const outcome = await recoverEmbeddedPostgresOrphans({
      dataDir,
      logger,
      listProcesses: async () => [],
      killProcessTree: vi.fn(),
    });
    expect(outcome.kind).toBe("no-orphans");
  });

  it("kills postmaster matched by data dir in command line", async () => {
    const logger = silentLogger();
    const kill = vi.fn(async () => {});
    const postmaster: OrphanProcess = {
      pid: 13268,
      parentPid: 9999,
      commandLine: `${embeddedBinary} -D ${dataDir} -p 54329`,
    };
    const ioWorker: OrphanProcess = {
      pid: 47592,
      parentPid: 13268,
      commandLine: `${embeddedBinary} --forkchild="io_worker" 5972`,
    };
    const outcome = await recoverEmbeddedPostgresOrphans({
      dataDir,
      logger,
      listProcesses: async () => [postmaster, ioWorker],
      killProcessTree: kill,
    });
    expect(outcome).toEqual({
      kind: "recovered",
      actions: [
        { kind: "killed-by-data-dir-match", pid: 13268, commandLine: postmaster.commandLine },
      ],
    });
    expect(kill).toHaveBeenCalledWith(13268);
    // Workers killed transitively by taskkill /t — we don't kill them explicitly.
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("ignores a postmaster bound to another data dir even if other postgres processes exist", async () => {
    const logger = silentLogger();
    const kill = vi.fn(async () => {});
    const otherPostmaster: OrphanProcess = {
      pid: 22222,
      parentPid: 1,
      commandLine: `${embeddedBinary} -D ${otherDataDir} -p 54339`,
    };
    const outcome = await recoverEmbeddedPostgresOrphans({
      dataDir,
      logger,
      listProcesses: async () => [otherPostmaster],
      killProcessTree: kill,
    });
    expect(outcome.kind).toBe("ambiguous");
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills orphan io_worker when no postmaster found and binary path matches", async () => {
    const logger = silentLogger();
    const kill = vi.fn(async () => {});
    // Use a parent PID we know is dead. PID 1 is alive on Unix but kill(pid, 0) on Windows
    // for a non-existent PID throws ESRCH. We rely on our isPidAlive returning false here
    // by passing parentPid: null which is the "definitely orphaned" case.
    const ioWorker: OrphanProcess = {
      pid: 47592,
      parentPid: null,
      commandLine: `${embeddedBinary} --forkchild="io_worker" 5972`,
    };
    const outcome = await recoverEmbeddedPostgresOrphans({
      dataDir,
      logger,
      listProcesses: async () => [ioWorker],
      killProcessTree: kill,
    });
    expect(outcome.kind).toBe("recovered");
    expect(kill).toHaveBeenCalledWith(47592);
    const warning = logger.entries.find((e) => e.msg.includes("orphan postgres io_worker"));
    expect(warning).toBeDefined();
  });

  it("returns ambiguous when only a system postgres is running", async () => {
    const logger = silentLogger();
    const kill = vi.fn(async () => {});
    const systemPostgres: OrphanProcess = {
      pid: 9000,
      parentPid: 1,
      commandLine: "/usr/local/bin/postgres -D /var/lib/postgresql/data",
    };
    const outcome = await recoverEmbeddedPostgresOrphans({
      dataDir,
      logger,
      listProcesses: async () => [systemPostgres],
      killProcessTree: kill,
    });
    expect(outcome.kind).toBe("ambiguous");
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("formatOrphanCandidatesForDiagnostic", () => {
  it("formats candidates one per line with pid/parent/cmd", () => {
    const text = formatOrphanCandidatesForDiagnostic([
      { pid: 100, parentPid: 1, commandLine: "/usr/local/bin/postgres" },
      { pid: 200, parentPid: null, commandLine: "" },
    ]);
    expect(text).toContain("pid=100");
    expect(text).toContain("parent=1");
    expect(text).toContain("/usr/local/bin/postgres");
    expect(text).toContain("pid=200");
    expect(text).toContain("parent=?");
    expect(text).toContain("<unknown>");
  });
});
