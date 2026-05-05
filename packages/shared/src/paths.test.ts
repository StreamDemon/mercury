import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
} from "./paths.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("expandHomePrefix", () => {
  it("expands bare ~ to the home directory", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
  });

  it("expands ~/ prefixes", () => {
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });

  it("returns absolute paths unchanged", () => {
    const absolute = path.resolve("/tmp/example");
    expect(expandHomePrefix(absolute)).toBe(absolute);
  });
});

describe("resolveHomeAwarePath", () => {
  it("resolves ~/ prefixes against the home directory", () => {
    expect(resolveHomeAwarePath("~/mercury-test")).toBe(path.resolve(os.homedir(), "mercury-test"));
  });
});

describe("resolveMercuryHomeDir", () => {
  it("defaults to ~/.mercury when MERCURY_HOME is unset", () => {
    delete process.env.MERCURY_HOME;
    expect(resolveMercuryHomeDir()).toBe(path.resolve(os.homedir(), ".mercury"));
  });

  it("respects MERCURY_HOME with a ~ prefix", () => {
    process.env.MERCURY_HOME = "~/mercury-home";
    expect(resolveMercuryHomeDir()).toBe(path.resolve(os.homedir(), "mercury-home"));
  });
});

describe("resolveMercuryInstanceId", () => {
  it("defaults to 'default' when no override or env is set", () => {
    delete process.env.MERCURY_INSTANCE_ID;
    expect(resolveMercuryInstanceId()).toBe("default");
  });

  it("reads MERCURY_INSTANCE_ID from the environment", () => {
    process.env.MERCURY_INSTANCE_ID = "from-env";
    expect(resolveMercuryInstanceId()).toBe("from-env");
  });

  it("prefers an explicit override over the environment", () => {
    process.env.MERCURY_INSTANCE_ID = "from-env";
    expect(resolveMercuryInstanceId("explicit")).toBe("explicit");
  });

  it("rejects ids containing disallowed characters", () => {
    expect(() => resolveMercuryInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });
});

describe("instance-rooted path helpers", () => {
  it("compose the standard ~/.mercury/instances/<id>/... layout", () => {
    delete process.env.MERCURY_HOME;
    delete process.env.MERCURY_INSTANCE_ID;
    const root = path.resolve(os.homedir(), ".mercury", "instances", "default");

    expect(resolveMercuryInstanceRoot()).toBe(root);
    expect(resolveDefaultConfigPath()).toBe(path.resolve(root, "config.json"));
    expect(resolveDefaultEmbeddedPostgresDir()).toBe(path.resolve(root, "db"));
    expect(resolveDefaultLogsDir()).toBe(path.resolve(root, "logs"));
    expect(resolveDefaultSecretsKeyFilePath()).toBe(path.resolve(root, "secrets", "master.key"));
    expect(resolveDefaultStorageDir()).toBe(path.resolve(root, "data", "storage"));
    expect(resolveDefaultBackupDir()).toBe(path.resolve(root, "data", "backups"));
  });

  it("honors an explicit instance-id override", () => {
    delete process.env.MERCURY_HOME;
    delete process.env.MERCURY_INSTANCE_ID;
    expect(resolveMercuryInstanceRoot("dev_1")).toBe(
      path.resolve(os.homedir(), ".mercury", "instances", "dev_1"),
    );
    expect(resolveDefaultConfigPath("dev_1")).toBe(
      path.resolve(os.homedir(), ".mercury", "instances", "dev_1", "config.json"),
    );
  });
});
