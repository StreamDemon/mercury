import os from "node:os";
import path from "node:path";

export const DEFAULT_INSTANCE_ID = "default";
export const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}

export function resolveMercuryHomeDir(): string {
  const envHome = process.env.MERCURY_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  return path.resolve(os.homedir(), ".mercury");
}

export function resolveMercuryInstanceId(override?: string): string {
  const raw = override?.trim() || process.env.MERCURY_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(
      `Invalid instance id '${raw}'. Allowed characters: letters, numbers, '_' and '-'.`,
    );
  }
  return raw;
}

export function resolveMercuryInstanceRoot(instanceId?: string): string {
  return path.resolve(resolveMercuryHomeDir(), "instances", resolveMercuryInstanceId(instanceId));
}

export function resolveDefaultConfigPath(instanceId?: string): string {
  return path.resolve(resolveMercuryInstanceRoot(instanceId), "config.json");
}

export function resolveDefaultEmbeddedPostgresDir(instanceId?: string): string {
  return path.resolve(resolveMercuryInstanceRoot(instanceId), "db");
}

export function resolveDefaultLogsDir(instanceId?: string): string {
  return path.resolve(resolveMercuryInstanceRoot(instanceId), "logs");
}

export function resolveDefaultSecretsKeyFilePath(instanceId?: string): string {
  return path.resolve(resolveMercuryInstanceRoot(instanceId), "secrets", "master.key");
}

export function resolveDefaultStorageDir(instanceId?: string): string {
  return path.resolve(resolveMercuryInstanceRoot(instanceId), "data", "storage");
}

export function resolveDefaultBackupDir(instanceId?: string): string {
  return path.resolve(resolveMercuryInstanceRoot(instanceId), "data", "backups");
}
