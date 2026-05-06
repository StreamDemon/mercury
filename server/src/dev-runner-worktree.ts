import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvFileIntoProcessEnv } from "@mercuryai/shared";

type WorktreeEnvBootstrapResult =
  | { envPath: null; missingEnv: false }
  | { envPath: string; missingEnv: true }
  | { envPath: string; missingEnv: false };

export function isLinkedGitWorktreeCheckout(rootDir: string): boolean {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

export function resolveWorktreeEnvFilePath(rootDir: string): string {
  return path.resolve(rootDir, ".mercury", ".env");
}

export function bootstrapDevRunnerWorktreeEnv(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WorktreeEnvBootstrapResult {
  if (!isLinkedGitWorktreeCheckout(rootDir)) {
    return {
      envPath: null,
      missingEnv: false,
    };
  }

  const envPath = resolveWorktreeEnvFilePath(rootDir);
  if (!existsSync(envPath)) {
    return {
      envPath,
      missingEnv: true,
    };
  }

  loadEnvFileIntoProcessEnv(envPath, env);

  return {
    envPath,
    missingEnv: false,
  };
}
