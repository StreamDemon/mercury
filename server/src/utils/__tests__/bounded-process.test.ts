import { describe, expect, it } from "vitest";
import { runBoundedProcess } from "../bounded-process.js";

describe("runBoundedProcess", () => {
  it("decodes multi-byte UTF-8 codepoints split across data events", async () => {
    // 漢 is the three-byte UTF-8 sequence 0xE6 0xBC 0xA2. Splitting the
    // bytes across separate writes forces Node to emit them as distinct
    // `data` events; without stream-level UTF-8 decoding, a per-chunk
    // `Buffer.toString("utf8")` would yield `�` for the lone 0xE6
    // and corrupt the codepoint.
    const script = `
      process.stdout.write(Buffer.from([0xE6]));
      setTimeout(() => process.stdout.write(Buffer.from([0xBC, 0xA2])), 25);
      setTimeout(() => process.exit(0), 75);
    `;
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("漢");
    expect(result.stdout).not.toContain("�");
  });

  it("reports timedOut=true when timeoutMs elapses", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: process.cwd(),
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal === "SIGTERM" || result.code !== 0).toBe(true);
  });
});
