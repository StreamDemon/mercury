import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OrphanProcess = {
  pid: number;
  parentPid: number | null;
  commandLine: string;
};

export type OrphanRecoveryAction =
  | { kind: "killed-by-pid-file"; pid: number }
  | { kind: "killed-by-data-dir-match"; pid: number; commandLine: string }
  | { kind: "killed-orphan-io-worker"; pid: number; parentPid: number | null; commandLine: string };

export type OrphanRecoveryOutcome =
  | { kind: "no-orphans"; postgresProcessesSeen: OrphanProcess[] }
  | { kind: "recovered"; actions: OrphanRecoveryAction[] }
  | { kind: "ambiguous"; candidates: OrphanProcess[] };

export type OrphanRecoveryLogger = {
  info: (ctx: Record<string, unknown>, msg: string) => void;
  warn: (ctx: Record<string, unknown>, msg: string) => void;
};

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a process exists but we can't signal it; treat as alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function readPostmasterPidFile(dataDir: string): number | null {
  const path = resolve(dataDir, "postmaster.pid");
  if (!existsSync(path)) return null;
  try {
    const first = readFileSync(path, "utf8").split("\n")[0]?.trim();
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function normalizeForCompare(value: string): string {
  return resolve(value).replace(/\\/g, "/").toLowerCase();
}

export function commandLineMatchesDataDir(commandLine: string, dataDir: string): boolean {
  if (!commandLine) return false;
  const haystack = commandLine.replace(/\\/g, "/").toLowerCase();
  const needle = normalizeForCompare(dataDir);
  // Match `-D <dir>`, `-D"<dir>"`, or `-D<dir>` (with or without surrounding quotes).
  const patterns = [
    `-d ${needle}`,
    `-d"${needle}"`,
    `-d'${needle}'`,
    `-d${needle}`,
  ];
  return patterns.some((pattern) => haystack.includes(pattern));
}

export function commandLineLooksLikeIoWorker(commandLine: string): boolean {
  return /--forkchild=/i.test(commandLine);
}

export function commandLineLooksLikeEmbeddedPostgres(commandLine: string): boolean {
  if (!commandLine) return false;
  const haystack = commandLine.replace(/\\/g, "/").toLowerCase();
  return haystack.includes("/embedded-postgres/") || haystack.includes("@embedded-postgres");
}

async function listPostgresProcessesWindows(): Promise<OrphanProcess[]> {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | " +
    "Select-Object @{n='pid';e={$_.ProcessId}},@{n='ppid';e={$_.ParentProcessId}},@{n='cmd';e={$_.CommandLine}} | " +
    "ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 15000 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries
    .map((entry): OrphanProcess | null => {
      if (typeof entry !== "object" || entry === null) return null;
      const e = entry as Record<string, unknown>;
      const pid = typeof e.pid === "number" ? e.pid : null;
      if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
      return {
        pid,
        parentPid:
          typeof e.ppid === "number" && Number.isInteger(e.ppid) && e.ppid > 0 ? e.ppid : null,
        commandLine: typeof e.cmd === "string" ? e.cmd : "",
      };
    })
    .filter((p): p is OrphanProcess => p !== null);
}

async function listPostgresProcessesUnix(): Promise<OrphanProcess[]> {
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,ppid=,command="], {
    timeout: 15000,
  });
  return stdout
    .split(/\r?\n/)
    .map((line): OrphanProcess | null => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      const command = match[3];
      // Filter to actual postgres binaries (not random scripts that mention "postgres").
      if (!/(?:^|\/)postgres(?:\s|$)/.test(command) && !/postgres\.exe/.test(command)) return null;
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]) || null,
        commandLine: command,
      };
    })
    .filter((p): p is OrphanProcess => p !== null);
}

export async function listPostgresProcesses(): Promise<OrphanProcess[]> {
  if (process.platform === "win32") return listPostgresProcessesWindows();
  return listPostgresProcessesUnix();
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(pid), "/f", "/t"], {
      timeout: 15000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Fall through to single-PID kill if process group kill fails.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone — that's fine.
  }
}

export type OrphanRecoveryOptions = {
  dataDir: string;
  logger: OrphanRecoveryLogger;
  killProcessTree?: (pid: number) => Promise<void>;
  listProcesses?: () => Promise<OrphanProcess[]>;
};

export async function recoverEmbeddedPostgresOrphans(
  opts: OrphanRecoveryOptions,
): Promise<OrphanRecoveryOutcome> {
  const kill = opts.killProcessTree ?? killProcessTree;
  const list = opts.listProcesses ?? listPostgresProcesses;
  const actions: OrphanRecoveryAction[] = [];

  const pidFromFile = readPostmasterPidFile(opts.dataDir);
  if (pidFromFile !== null && isPidAlive(pidFromFile)) {
    opts.logger.warn(
      { pid: pidFromFile, dataDir: opts.dataDir },
      "Found running postgres via postmaster.pid; killing before retry",
    );
    await kill(pidFromFile);
    actions.push({ kind: "killed-by-pid-file", pid: pidFromFile });
    return { kind: "recovered", actions };
  }

  const processes = await list();
  if (processes.length === 0) {
    return { kind: "no-orphans", postgresProcessesSeen: [] };
  }

  const matchingPostmasters = processes.filter((p) =>
    commandLineMatchesDataDir(p.commandLine, opts.dataDir),
  );
  if (matchingPostmasters.length > 0) {
    for (const p of matchingPostmasters) {
      opts.logger.warn(
        { pid: p.pid, commandLine: p.commandLine, dataDir: opts.dataDir },
        "Found postgres postmaster bound to our data dir; killing before retry",
      );
      await kill(p.pid);
      actions.push({ kind: "killed-by-data-dir-match", pid: p.pid, commandLine: p.commandLine });
    }
    return { kind: "recovered", actions };
  }

  const orphanWorkers = processes.filter((p) => {
    if (!commandLineLooksLikeIoWorker(p.commandLine)) return false;
    if (!commandLineLooksLikeEmbeddedPostgres(p.commandLine)) return false;
    if (p.parentPid === null) return true;
    return !isPidAlive(p.parentPid);
  });
  if (orphanWorkers.length > 0) {
    for (const p of orphanWorkers) {
      opts.logger.warn(
        {
          pid: p.pid,
          parentPid: p.parentPid,
          commandLine: p.commandLine,
          dataDir: opts.dataDir,
        },
        "Found orphan postgres io_worker (parent dead, no postmaster matched our data dir); " +
          "killing as last-resort cleanup. If this kills a sibling worktree's worker, restart that worktree's Mercury server.",
      );
      await kill(p.pid);
      actions.push({
        kind: "killed-orphan-io-worker",
        pid: p.pid,
        parentPid: p.parentPid,
        commandLine: p.commandLine,
      });
    }
    return { kind: "recovered", actions };
  }

  return { kind: "ambiguous", candidates: processes };
}

export function formatOrphanCandidatesForDiagnostic(candidates: OrphanProcess[]): string {
  return candidates
    .map((p) => `  pid=${p.pid} parent=${p.parentPid ?? "?"} cmd=${p.commandLine || "<unknown>"}`)
    .join("\n");
}
