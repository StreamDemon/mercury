import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRuntimePortSelectionToConfig,
  maybePersistWorktreeRuntimePorts,
  maybeRepairLegacyWorktreeConfigAndEnvFiles,
} from "../worktree-config.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);

  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

function buildLegacyConfig(sharedRoot: string, publicBaseUrl = "http://127.0.0.1:3100") {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-03-26T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres" as const,
      embeddedPostgresDataDir: path.join(sharedRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(sharedRoot, "data", "backups"),
      },
    },
    logging: {
      mode: "file" as const,
      logDir: path.join(sharedRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted" as const,
      exposure: "private" as const,
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "explicit" as const,
      publicBaseUrl,
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk" as const,
      localDisk: {
        baseDir: path.join(sharedRoot, "data", "storage"),
      },
      s3: {
        bucket: "mercury",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted" as const,
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(sharedRoot, "secrets", "master.key"),
      },
    },
  };
}

describe("worktree config repair", () => {
  it("repairs legacy repo-local worktree config and env files into an isolated instance", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-worktree-repair-"));
    const worktreeRoot = path.join(tempRoot, "PAP-884-ai-commits-component");
    const mercuryDir = path.join(worktreeRoot, ".mercury");
    const configPath = path.join(mercuryDir, "config.json");
    const envPath = path.join(mercuryDir, ".env");
    const sharedRoot = path.join(tempRoot, ".mercury", "instances", "default");
    const isolatedHome = path.join(tempRoot, ".mercury-worktrees");

    await fs.mkdir(mercuryDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Mercury environment variables",
        "MERCURY_IN_WORKTREE=true",
        "MERCURY_WORKTREE_NAME=PAP-884-ai-commits-component",
        "MERCURY_AGENT_JWT_SECRET=shared-secret",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.MERCURY_IN_WORKTREE = "true";
    process.env.MERCURY_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.MERCURY_WORKTREES_DIR = isolatedHome;
    delete process.env.MERCURY_HOME;
    delete process.env.MERCURY_INSTANCE_ID;
    delete process.env.MERCURY_CONFIG;
    delete process.env.MERCURY_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({
      repairedConfig: true,
      repairedEnv: true,
    });

    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-884-ai-commits-component");

    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(instanceRoot, "db"));
    expect(repairedConfig.database.backup.dir).toBe(path.join(instanceRoot, "data", "backups"));
    expect(repairedConfig.logging.logDir).toBe(path.join(instanceRoot, "logs"));
    expect(repairedConfig.storage.localDisk.baseDir).toBe(path.join(instanceRoot, "data", "storage"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(path.join(instanceRoot, "secrets", "master.key"));
    expect(repairedEnv).toContain(`MERCURY_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).toContain('MERCURY_INSTANCE_ID="pap-884-ai-commits-component"');
    expect(repairedEnv).toContain(`MERCURY_CONFIG=${JSON.stringify(await fs.realpath(configPath))}`);
    expect(repairedEnv).toContain(`MERCURY_CONTEXT=${JSON.stringify(path.join(isolatedHome, "context.json"))}`);
    expect(repairedEnv).toContain('MERCURY_AGENT_JWT_SECRET="shared-secret"');
    expect(process.env.MERCURY_HOME).toBe(isolatedHome);
    expect(process.env.MERCURY_INSTANCE_ID).toBe("pap-884-ai-commits-component");
  });

  it("avoids sibling worktree ports when repairing legacy configs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-worktree-repair-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-880-thumbs-capture-for-evals-feature");
    const mercuryDir = path.join(worktreeRoot, ".mercury");
    const configPath = path.join(mercuryDir, "config.json");
    const envPath = path.join(mercuryDir, ".env");
    const sharedRoot = path.join(tempRoot, ".mercury", "instances", "default");
    const isolatedHome = path.join(tempRoot, ".mercury-worktrees");
    const siblingInstanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");

    await fs.mkdir(mercuryDir, { recursive: true });
    await fs.mkdir(siblingInstanceRoot, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Mercury environment variables",
        "MERCURY_IN_WORKTREE=true",
        "MERCURY_WORKTREE_NAME=PAP-880-thumbs-capture-for-evals-feature",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(siblingInstanceRoot, "config.json"),
      JSON.stringify(
        {
          ...buildLegacyConfig(siblingInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(siblingInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(siblingInstanceRoot, "data", "backups"),
            },
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.MERCURY_IN_WORKTREE = "true";
    process.env.MERCURY_WORKTREE_NAME = "PAP-880-thumbs-capture-for-evals-feature";
    process.env.MERCURY_WORKTREES_DIR = isolatedHome;
    delete process.env.MERCURY_HOME;
    delete process.env.MERCURY_INSTANCE_ID;
    delete process.env.MERCURY_CONFIG;
    delete process.env.MERCURY_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3102);
    expect(repairedConfig.database.embeddedPostgresPort).toBe(54331);
  });

  it("does not persist transient runtime home overrides over repo-local worktree env", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-worktree-runtime-override-"));
    const isolatedHome = path.join(tempRoot, ".mercury-worktrees");
    const transientHome = path.join(tempRoot, "tests", "e2e", ".tmp", "multiuser-authenticated");
    const worktreeRoot = path.join(tempRoot, "PAP-989-multi-user-implementation-using-plan-from-pap-958");
    const mercuryDir = path.join(worktreeRoot, ".mercury");
    const configPath = path.join(mercuryDir, "config.json");
    const envPath = path.join(mercuryDir, ".env");
    const instanceId = "pap-989-multi-user-implementation-using-plan-from-pap-958";
    const stableInstanceRoot = path.join(isolatedHome, "instances", instanceId);

    await fs.mkdir(mercuryDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(transientHome),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(transientHome, "instances", instanceId, "db"),
            embeddedPostgresPort: 54334,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(transientHome, "instances", instanceId, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(transientHome, "instances", instanceId, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3104,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(transientHome, "instances", instanceId, "data", "storage"),
            },
            s3: {
              bucket: "mercury",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(transientHome, "instances", instanceId, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      envPath,
      [
        "# Mercury environment variables",
        `MERCURY_HOME=${JSON.stringify(isolatedHome)}`,
        `MERCURY_INSTANCE_ID=${JSON.stringify(instanceId)}`,
        `MERCURY_CONFIG=${JSON.stringify(configPath)}`,
        `MERCURY_CONTEXT=${JSON.stringify(path.join(isolatedHome, "context.json"))}`,
        'MERCURY_IN_WORKTREE="true"',
        'MERCURY_WORKTREE_NAME="PAP-989-multi-user-implementation-using-plan-from-pap-958"',
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.MERCURY_IN_WORKTREE = "true";
    process.env.MERCURY_WORKTREE_NAME = "PAP-989-multi-user-implementation-using-plan-from-pap-958";
    process.env.MERCURY_HOME = transientHome;
    process.env.MERCURY_INSTANCE_ID = instanceId;
    process.env.MERCURY_CONFIG = configPath;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");

    expect(result).toEqual({
      repairedConfig: true,
      repairedEnv: false,
    });
    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(stableInstanceRoot, "db"));
    expect(repairedConfig.database.backup.dir).toBe(path.join(stableInstanceRoot, "data", "backups"));
    expect(repairedConfig.logging.logDir).toBe(path.join(stableInstanceRoot, "logs"));
    expect(repairedConfig.storage.localDisk.baseDir).toBe(path.join(stableInstanceRoot, "data", "storage"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(
      path.join(stableInstanceRoot, "secrets", "master.key"),
    );
    expect(repairedEnv).toContain(`MERCURY_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).not.toContain(`MERCURY_HOME=${JSON.stringify(transientHome)}`);
    expect(process.env.MERCURY_HOME).toBe(isolatedHome);
  });

  it("rebalances duplicate ports for already isolated worktree configs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-worktree-rebalance-"));
    const isolatedHome = path.join(tempRoot, ".mercury-worktrees");
    const repoWorktreesRoot = path.join(tempRoot, "repo", ".mercury", "worktrees");
    const siblingWorktreeRoot = path.join(repoWorktreesRoot, "PAP-878-create-a-mine-tab-in-inbox");
    const siblingInstanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");
    const currentWorktreeRoot = path.join(repoWorktreesRoot, "PAP-884-ai-commits-component");
    const mercuryDir = path.join(currentWorktreeRoot, ".mercury");
    const configPath = path.join(mercuryDir, "config.json");
    const envPath = path.join(mercuryDir, ".env");
    const currentInstanceRoot = path.join(isolatedHome, "instances", "pap-884-ai-commits-component");
    const siblingConfigPath = path.join(siblingWorktreeRoot, ".mercury", "config.json");

    await fs.mkdir(mercuryDir, { recursive: true });
    await fs.mkdir(path.dirname(siblingConfigPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(currentInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(currentInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(currentInstanceRoot, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(currentInstanceRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(currentInstanceRoot, "data", "storage"),
            },
            s3: {
              bucket: "mercury",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(currentInstanceRoot, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      envPath,
      [
        "# Mercury environment variables",
        "MERCURY_IN_WORKTREE=true",
        "MERCURY_WORKTREE_NAME=PAP-884-ai-commits-component",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      siblingConfigPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(siblingInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(siblingInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(siblingInstanceRoot, "data", "backups"),
            },
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(currentWorktreeRoot);
    process.env.MERCURY_IN_WORKTREE = "true";
    process.env.MERCURY_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.MERCURY_WORKTREES_DIR = isolatedHome;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3102);
    expect(repairedConfig.database.embeddedPostgresPort).toBe(54331);
  });

  it("persists runtime-selected worktree ports back into explicit-port auth URLs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-worktree-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-878-create-a-mine-tab-in-inbox");
    const mercuryDir = path.join(worktreeRoot, ".mercury");
    const configPath = path.join(mercuryDir, "config.json");
    const isolatedHome = path.join(tempRoot, ".mercury-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");

    await fs.mkdir(mercuryDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(instanceRoot, "http://my-host.ts.net:3100"),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(instanceRoot, "db"),
            embeddedPostgresPort: 54331,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(instanceRoot, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(instanceRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(instanceRoot, "data", "storage"),
            },
            s3: {
              bucket: "mercury",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(instanceRoot, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.MERCURY_IN_WORKTREE = "true";
    process.env.MERCURY_WORKTREE_NAME = "PAP-878-create-a-mine-tab-in-inbox";
    process.env.MERCURY_HOME = isolatedHome;
    process.env.MERCURY_INSTANCE_ID = "pap-878-create-a-mine-tab-in-inbox";
    process.env.MERCURY_CONFIG = configPath;

    maybePersistWorktreeRuntimePorts({
      serverPort: 3103,
      databasePort: 54335,
    });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(writtenConfig.server.port).toBe(3103);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54335);
    expect(writtenConfig.auth.publicBaseUrl).toBe("http://my-host.ts.net:3103/");
  });

  it("does not rewrite no-port public auth URLs when persisting runtime-selected ports", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-worktree-public-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-125-public-base-url");
    const mercuryDir = path.join(worktreeRoot, ".mercury");
    const configPath = path.join(mercuryDir, "config.json");
    const isolatedHome = path.join(tempRoot, ".mercury-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-125-public-base-url");

    await fs.mkdir(mercuryDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(instanceRoot, "https://mercury.example"),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(instanceRoot, "db"),
            embeddedPostgresPort: 54331,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(instanceRoot, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(instanceRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(instanceRoot, "data", "storage"),
            },
            s3: {
              bucket: "mercury",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(instanceRoot, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.MERCURY_IN_WORKTREE = "true";
    process.env.MERCURY_WORKTREE_NAME = "PAP-125-public-base-url";
    process.env.MERCURY_HOME = isolatedHome;
    process.env.MERCURY_INSTANCE_ID = "pap-125-public-base-url";
    process.env.MERCURY_CONFIG = configPath;

    maybePersistWorktreeRuntimePorts({
      serverPort: 3103,
      databasePort: 54335,
    });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(writtenConfig.server.port).toBe(3103);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54335);
    expect(writtenConfig.auth.publicBaseUrl).toBe("https://mercury.example");
  });

  it("can update the in-memory config when auth URL already includes a port", () => {
    const { config, changed } = applyRuntimePortSelectionToConfig(
      buildLegacyConfig("/tmp/shared", "http://my-host.ts.net:3100"),
      {
        serverPort: 3104,
        databasePort: 54340,
        allowServerPortWrite: false,
        allowDatabasePortWrite: true,
      },
    );

    expect(changed).toBe(true);
    expect(config.server.port).toBe(3100);
    expect(config.database.embeddedPostgresPort).toBe(54340);
    expect(config.auth.publicBaseUrl).toBe("http://my-host.ts.net:3104/");
  });

  it("does not rewrite the in-memory config when auth URL has no explicit port", () => {
    const { config, changed } = applyRuntimePortSelectionToConfig(
      buildLegacyConfig("/tmp/shared", "https://mercury.example"),
      {
        serverPort: 3104,
        databasePort: 54340,
        allowServerPortWrite: false,
        allowDatabasePortWrite: true,
      },
    );

    expect(changed).toBe(true);
    expect(config.server.port).toBe(3100);
    expect(config.database.embeddedPostgresPort).toBe(54340);
    expect(config.auth.publicBaseUrl).toBe("https://mercury.example");
  });
});
