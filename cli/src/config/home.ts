import path from "node:path";
import {
  DEFAULT_INSTANCE_ID,
  INSTANCE_ID_RE,
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolveDefaultConfigPath,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
  resolveMercuryHomeDir,
  resolveMercuryInstanceId,
  resolveMercuryInstanceRoot,
} from "@mercuryai/shared";

export {
  DEFAULT_INSTANCE_ID,
  INSTANCE_ID_RE,
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolveDefaultConfigPath,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
  resolveMercuryHomeDir,
  resolveMercuryInstanceId,
  resolveMercuryInstanceRoot,
};

export function resolveDefaultContextPath(): string {
  return path.resolve(resolveMercuryHomeDir(), "context.json");
}

export function resolveDefaultCliAuthPath(): string {
  return path.resolve(resolveMercuryHomeDir(), "auth.json");
}

export function describeLocalInstancePaths(instanceId?: string) {
  const resolvedInstanceId = resolveMercuryInstanceId(instanceId);
  const instanceRoot = resolveMercuryInstanceRoot(resolvedInstanceId);
  return {
    homeDir: resolveMercuryHomeDir(),
    instanceId: resolvedInstanceId,
    instanceRoot,
    configPath: resolveDefaultConfigPath(resolvedInstanceId),
    embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(resolvedInstanceId),
    backupDir: resolveDefaultBackupDir(resolvedInstanceId),
    logDir: resolveDefaultLogsDir(resolvedInstanceId),
    secretsKeyFilePath: resolveDefaultSecretsKeyFilePath(resolvedInstanceId),
    storageDir: resolveDefaultStorageDir(resolvedInstanceId),
  };
}
