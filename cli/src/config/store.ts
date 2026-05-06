import fs from "node:fs";
import path from "node:path";
import { migrateLegacyConfig, resolveMercuryConfigPath } from "@mercuryai/shared";
import { mercuryConfigSchema, type MercuryConfig } from "./schema.js";

export {
  findConfigFileFromAncestors,
  migrateLegacyConfig,
  resolveMercuryConfigPath,
  resolveMercuryEnvPath,
} from "@mercuryai/shared";

function parseJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatValidationError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: unknown; message?: unknown }> })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue) => {
        const pathParts = Array.isArray(issue.path) ? issue.path.map(String) : [];
        const issuePath = pathParts.length > 0 ? pathParts.join(".") : "config";
        const message = typeof issue.message === "string" ? issue.message : "Invalid value";
        return `${issuePath}: ${message}`;
      })
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

export function readConfig(configPath?: string): MercuryConfig | null {
  const filePath = resolveMercuryConfigPath(configPath);
  if (!fs.existsSync(filePath)) return null;
  const raw = parseJson(filePath);
  const migrated = migrateLegacyConfig(raw);
  const parsed = mercuryConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${filePath}: ${formatValidationError(parsed.error)}`);
  }
  return parsed.data;
}

export function writeConfig(
  config: MercuryConfig,
  configPath?: string,
): void {
  const filePath = resolveMercuryConfigPath(configPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    const backupPath = filePath + ".backup";
    fs.copyFileSync(filePath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function configExists(configPath?: string): boolean {
  return fs.existsSync(resolveMercuryConfigPath(configPath));
}
