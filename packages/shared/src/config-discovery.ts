import { existsSync } from "node:fs";
import path from "node:path";
import { resolveDefaultConfigPath } from "./paths.js";

const MERCURY_CONFIG_BASENAME = "config.json";
const MERCURY_ENV_FILENAME = ".env";

export function findConfigFileFromAncestors(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.resolve(currentDir, ".mercury", MERCURY_CONFIG_BASENAME);
    if (existsSync(candidate)) return candidate;

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) return null;
    currentDir = nextDir;
  }
}

export function resolveMercuryConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  const envConfig = process.env.MERCURY_CONFIG?.trim();
  if (envConfig) return path.resolve(envConfig);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath();
}

export function resolveMercuryEnvPath(overrideConfigPath?: string): string {
  return path.resolve(
    path.dirname(resolveMercuryConfigPath(overrideConfigPath)),
    MERCURY_ENV_FILENAME,
  );
}

export function migrateLegacyConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;

  const config = { ...(raw as Record<string, unknown>) };
  const databaseRaw = config.database;
  if (typeof databaseRaw !== "object" || databaseRaw === null || Array.isArray(databaseRaw)) {
    return config;
  }

  const database = { ...(databaseRaw as Record<string, unknown>) };
  if (database.mode === "pglite") {
    database.mode = "embedded-postgres";

    if (
      typeof database.embeddedPostgresDataDir !== "string" &&
      typeof database.pgliteDataDir === "string"
    ) {
      database.embeddedPostgresDataDir = database.pgliteDataDir;
    }
    if (
      typeof database.embeddedPostgresPort !== "number" &&
      typeof database.pglitePort === "number" &&
      Number.isFinite(database.pglitePort)
    ) {
      database.embeddedPostgresPort = database.pglitePort;
    }
  }

  config.database = database;
  return config;
}
