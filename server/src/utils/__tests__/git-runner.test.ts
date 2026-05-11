import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCommandError, gitOutput, gitOutputOrNull, runGit } from "../git-runner.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-git-runner-"));
  await runGit(["init"], repoRoot);
  await runGit(["config", "user.email", "test@mercury.local"], repoRoot);
  await runGit(["config", "user.name", "Mercury Test"], repoRoot);
});

afterEach(async () => {
  // Windows can briefly hold a lock on git index/objects after a chain of
  // operations — retry a few times before giving up rather than fail the
  // test on cleanup noise.
  await fs
    .rm(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch(() => {});
});

describe("runGit", () => {
  it("prepends -C cwd so callers do not repeat it", async () => {
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], repoRoot);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  }, 10_000);

  it("throws GitCommandError on non-zero exit with exit code preserved", async () => {
    const error = await runGit(["merge-base", "--is-ancestor", "HEAD", "HEAD~1"], repoRoot).catch(
      (err) => err,
    );
    expect(error).toBeInstanceOf(GitCommandError);
    // `merge-base --is-ancestor` returns 128 here (no HEAD~1) — what matters
    // is that `code` is exposed on the instance so duck-typed
    // `"code" in error` checks continue to work after migration.
    expect(typeof (error as GitCommandError).code).toBe("number");
    expect((error as GitCommandError).args).toEqual(["merge-base", "--is-ancestor", "HEAD", "HEAD~1"]);
    expect((error as GitCommandError).cwd).toBe(repoRoot);
  }, 10_000);

  it("preserves exit code 1 on a clean non-ancestor merge-base check", async () => {
    await fs.writeFile(path.join(repoRoot, "a.txt"), "a\n", "utf8");
    await runGit(["add", "a.txt"], repoRoot);
    await runGit(["commit", "-m", "first"], repoRoot);
    await runGit(["checkout", "-b", "branch-b"], repoRoot);
    await fs.writeFile(path.join(repoRoot, "b.txt"), "b\n", "utf8");
    await runGit(["add", "b.txt"], repoRoot);
    await runGit(["commit", "-m", "second"], repoRoot);
    await runGit(["checkout", "-b", "branch-c", "HEAD~1"], repoRoot);

    // branch-c is NOT an ancestor of branch-b → git exits 1.
    const error = await runGit(
      ["merge-base", "--is-ancestor", "branch-b", "branch-c"],
      repoRoot,
    ).catch((err) => err);
    expect(error).toBeInstanceOf(GitCommandError);
    expect((error as GitCommandError).code).toBe(1);
  }, 30_000);

  it("does not throw when allowNonZero is true", async () => {
    const result = await runGit(
      ["merge-base", "--is-ancestor", "HEAD", "HEAD~1"],
      repoRoot,
      { allowNonZero: true },
    );
    expect(result.code).not.toBe(0);
  }, 10_000);
});

describe("gitOutput", () => {
  it("returns the trimmed stdout on success", async () => {
    await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
    await runGit(["add", "README.md"], repoRoot);
    await runGit(["commit", "-m", "first"], repoRoot);
    const top = await gitOutput(["rev-parse", "--show-toplevel"], repoRoot);
    expect(top.length).toBeGreaterThan(0);
    expect(top.endsWith("\n")).toBe(false);
  }, 10_000);

  it("throws GitCommandError on non-zero exit", async () => {
    await expect(gitOutput(["rev-parse", "definitely-not-a-ref"], repoRoot)).rejects.toBeInstanceOf(
      GitCommandError,
    );
  }, 10_000);
});

describe("gitOutputOrNull", () => {
  it("returns null on empty stdout but still throws on non-zero exit", async () => {
    await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
    await runGit(["add", "README.md"], repoRoot);
    await runGit(["commit", "-m", "first"], repoRoot);

    // `git remote` with no remotes configured exits 0 with empty stdout.
    const remotes = await gitOutputOrNull(["remote"], repoRoot);
    expect(remotes).toBeNull();

    // But a failure still throws — preserves the fallback semantics in
    // company-portability.ts that depend on catching this throw.
    await expect(
      gitOutputOrNull(["remote", "get-url", "missing-remote"], repoRoot),
    ).rejects.toBeInstanceOf(GitCommandError);
  }, 10_000);
});
