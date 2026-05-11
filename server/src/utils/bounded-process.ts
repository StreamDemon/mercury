import { spawn } from "node:child_process";

const DEFAULT_BOUNDED_PROCESS_OUTPUT_BYTES = 256 * 1024;

type ProcessOutputCapture = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

type ProcessOutputAccumulator = {
  append(chunk: string): void;
  finish(): ProcessOutputCapture;
};

function trimToLastBytes(value: string, limit: number) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= limit) return value;
  return Buffer.from(value, "utf8").subarray(byteLength - limit).toString("utf8");
}

function createProcessOutputCapture(maxBytes: number): ProcessOutputAccumulator {
  const limit = Math.max(1, Math.trunc(maxBytes));
  let text = "";
  let truncated = false;
  let totalBytes = 0;

  return {
    append(chunk: string) {
      if (!chunk) return;
      totalBytes += Buffer.byteLength(chunk, "utf8");

      const combined = text + chunk;
      if (Buffer.byteLength(combined, "utf8") <= limit) {
        text = combined;
        return;
      }

      text = trimToLastBytes(combined, limit);
      truncated = true;
    },
    finish(): ProcessOutputCapture {
      if (!truncated) {
        return {
          text,
          truncated: false,
          totalBytes,
        };
      }
      return {
        text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${text}`,
        truncated: true,
        totalBytes,
      };
    },
  };
}

export type BoundedProcessInput = {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  timeoutMs?: number;
};

export type BoundedProcessResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
};

export async function runBoundedProcess(input: BoundedProcessInput): Promise<BoundedProcessResult> {
  const proc = await new Promise<{
    stdout: ProcessOutputAccumulator;
    stderr: ProcessOutputAccumulator;
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.env ?? process.env,
    });
    // Decode at the stream level so UTF-8 codepoints split across `data`
    // events are buffered by Node's StringDecoder instead of being mangled
    // by per-chunk `Buffer.toString("utf8")` calls.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const stdout = createProcessOutputCapture(input.maxStdoutBytes ?? DEFAULT_BOUNDED_PROCESS_OUTPUT_BYTES);
    const stderr = createProcessOutputCapture(input.maxStderrBytes ?? DEFAULT_BOUNDED_PROCESS_OUTPUT_BYTES);
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, input.timeoutMs);
    }
    child.stdout?.on("data", (chunk: string) => {
      stdout.append(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr.append(chunk);
    });
    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
  const stdout = proc.stdout.finish();
  const stderr = proc.stderr.finish();
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: proc.code,
    signal: proc.signal,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    timedOut: proc.timedOut,
  };
}
