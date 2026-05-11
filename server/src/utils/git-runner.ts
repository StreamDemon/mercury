import { runBoundedProcess, type BoundedProcessResult } from "./bounded-process.js";

export type GitRunOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  // When true, `runGit` resolves with the raw result on any exit code instead
  // of throwing `GitCommandError`. The `gitOutput*` helpers ignore this flag.
  allowNonZero?: boolean;
};

export class GitCommandError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timedOut: boolean;

  constructor(result: BoundedProcessResult, args: readonly string[], cwd: string) {
    const detail = result.stderr.trim() || result.stdout.trim();
    const message = result.timedOut
      ? `git ${args.join(" ")} timed out`
      : detail.length > 0
        ? detail
        : `git ${args.join(" ")} failed with exit code ${result.code ?? -1}`;
    super(message);
    this.name = "GitCommandError";
    this.code = result.code;
    this.signal = result.signal;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.args = args;
    this.cwd = cwd;
    this.timedOut = result.timedOut;
  }
}

export async function runGit(
  args: readonly string[],
  cwd: string,
  opts: GitRunOptions = {},
): Promise<BoundedProcessResult> {
  const result = await runBoundedProcess({
    command: "git",
    args: ["-C", cwd, ...args],
    cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    maxStdoutBytes: opts.maxStdoutBytes,
    maxStderrBytes: opts.maxStderrBytes,
  });
  if (!opts.allowNonZero && (result.timedOut || result.code !== 0)) {
    throw new GitCommandError(result, args, cwd);
  }
  return result;
}

export async function gitOutput(
  args: readonly string[],
  cwd: string,
  opts?: Omit<GitRunOptions, "allowNonZero">,
): Promise<string> {
  const result = await runGit(args, cwd, opts);
  return result.stdout.trim();
}

export async function gitOutputOrNull(
  args: readonly string[],
  cwd: string,
  opts?: Omit<GitRunOptions, "allowNonZero">,
): Promise<string | null> {
  const trimmed = await gitOutput(args, cwd, opts);
  return trimmed.length > 0 ? trimmed : null;
}
