import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findConfigFileFromAncestors,
  migrateLegacyConfig,
  resolveMercuryConfigPath,
  resolveMercuryEnvPath,
} from "./config-discovery.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  process.env = { ...ORIGINAL_ENV };
});

function makeTempRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-config-discovery-"));
  const repo = path.join(tempDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  return repo;
}

describe("findConfigFileFromAncestors", () => {
  it("returns null when no .mercury/config.json exists in any ancestor", () => {
    const repo = makeTempRepo();
    expect(findConfigFileFromAncestors(repo)).toBe(null);
  });

  it("finds a .mercury/config.json in the start directory", () => {
    const repo = makeTempRepo();
    const configPath = path.join(repo, ".mercury", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");

    expect(findConfigFileFromAncestors(repo)).toBe(configPath);
  });

  it("walks up to find a config in an ancestor directory", () => {
    const repo = makeTempRepo();
    const configPath = path.join(repo, ".mercury", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");

    const nested = path.join(repo, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    expect(findConfigFileFromAncestors(nested)).toBe(configPath);
  });
});

describe("resolveMercuryConfigPath", () => {
  it("uses an explicit override when provided", () => {
    const override = path.join(os.tmpdir(), "explicit.json");
    expect(resolveMercuryConfigPath(override)).toBe(path.resolve(override));
  });

  it("uses MERCURY_CONFIG when override is absent", () => {
    process.env.MERCURY_CONFIG = path.join(os.tmpdir(), "from-env.json");
    expect(resolveMercuryConfigPath()).toBe(path.resolve(process.env.MERCURY_CONFIG));
  });

  it("treats a whitespace-only MERCURY_CONFIG as unset", () => {
    delete process.env.MERCURY_HOME;
    delete process.env.MERCURY_INSTANCE_ID;
    process.env.MERCURY_CONFIG = "   ";

    const repo = makeTempRepo();
    process.chdir(repo);

    expect(resolveMercuryConfigPath()).toBe(
      path.resolve(os.homedir(), ".mercury", "instances", "default", "config.json"),
    );
  });

  it("walks up from cwd to find a project-local config", () => {
    delete process.env.MERCURY_CONFIG;
    const repo = makeTempRepo();
    const configPath = path.join(repo, ".mercury", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");

    const nested = path.join(repo, "deep", "nested");
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);

    expect(resolveMercuryConfigPath()).toBe(configPath);
  });

  it("falls back to the default instance config path when nothing else matches", () => {
    delete process.env.MERCURY_CONFIG;
    delete process.env.MERCURY_HOME;
    delete process.env.MERCURY_INSTANCE_ID;

    const repo = makeTempRepo();
    process.chdir(repo);

    expect(resolveMercuryConfigPath()).toBe(
      path.resolve(os.homedir(), ".mercury", "instances", "default", "config.json"),
    );
  });
});

describe("resolveMercuryEnvPath", () => {
  it("places .env next to the resolved config", () => {
    const override = path.join(os.tmpdir(), "instance", "config.json");
    expect(resolveMercuryEnvPath(override)).toBe(
      path.resolve(path.dirname(override), ".env"),
    );
  });
});

describe("migrateLegacyConfig", () => {
  it("returns non-object input unchanged", () => {
    expect(migrateLegacyConfig(null)).toBe(null);
    expect(migrateLegacyConfig("string")).toBe("string");
    expect(migrateLegacyConfig(42)).toBe(42);
    expect(migrateLegacyConfig([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("returns the config unchanged when database is missing or non-object", () => {
    expect(migrateLegacyConfig({ unrelated: true })).toEqual({ unrelated: true });
    expect(migrateLegacyConfig({ database: null })).toEqual({ database: null });
    expect(migrateLegacyConfig({ database: [1, 2] })).toEqual({ database: [1, 2] });
  });

  it("renames pglite mode to embedded-postgres and copies fields", () => {
    const result = migrateLegacyConfig({
      database: {
        mode: "pglite",
        pgliteDataDir: "/tmp/legacy",
        pglitePort: 12345,
      },
    }) as { database: Record<string, unknown> };

    expect(result.database.mode).toBe("embedded-postgres");
    expect(result.database.embeddedPostgresDataDir).toBe("/tmp/legacy");
    expect(result.database.embeddedPostgresPort).toBe(12345);
  });

  it("does not overwrite existing embedded-postgres fields when migrating", () => {
    const result = migrateLegacyConfig({
      database: {
        mode: "pglite",
        pgliteDataDir: "/tmp/legacy",
        pglitePort: 12345,
        embeddedPostgresDataDir: "/tmp/already",
        embeddedPostgresPort: 54329,
      },
    }) as { database: Record<string, unknown> };

    expect(result.database.embeddedPostgresDataDir).toBe("/tmp/already");
    expect(result.database.embeddedPostgresPort).toBe(54329);
  });

  it("leaves non-pglite modes alone", () => {
    const input = {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresPort: 54329,
      },
    };
    expect(migrateLegacyConfig(input)).toEqual(input);
  });
});
