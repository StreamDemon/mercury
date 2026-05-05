import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatEnvEntries,
  loadEnvFileIntoProcessEnv,
  parseEnvFile,
  readEnvEntries,
} from "./env-file.js";

describe("parseEnvFile", () => {
  it("parses bareword key=value", () => {
    expect(parseEnvFile("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("strips matching double quotes", () => {
    expect(parseEnvFile('FOO="bar baz"')).toEqual({ FOO: "bar baz" });
  });

  it("strips matching single quotes", () => {
    expect(parseEnvFile("FOO='bar baz'")).toEqual({ FOO: "bar baz" });
  });

  it("ignores blank lines and full-line comments", () => {
    const input = `
# header comment
FOO=bar

# another comment
BAZ=qux
`;
    expect(parseEnvFile(input)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips trailing comments after whitespace on bareword values", () => {
    expect(parseEnvFile("FOO=bar # trailing")).toEqual({ FOO: "bar" });
  });

  it("preserves # inside quoted values", () => {
    expect(parseEnvFile('FOO="bar#baz"')).toEqual({ FOO: "bar#baz" });
  });

  it("treats # immediately after = as an empty value (the dev-runner-worktree fix)", () => {
    expect(parseEnvFile("FOO=#bar")).toEqual({ FOO: "" });
  });

  it("treats blank value as empty string", () => {
    expect(parseEnvFile("FOO=")).toEqual({ FOO: "" });
  });

  it("supports leading 'export ' prefix", () => {
    expect(parseEnvFile("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("ignores lines that are not key=value", () => {
    expect(parseEnvFile("not a key value pair\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});

describe("readEnvEntries", () => {
  it("returns an empty object when the file does not exist", () => {
    const fakePath = path.join(os.tmpdir(), `mercury-env-missing-${Date.now()}.env`);
    expect(readEnvEntries(fakePath)).toEqual({});
  });

  it("reads and parses an existing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-env-read-"));
    const filePath = path.join(dir, ".env");
    fs.writeFileSync(filePath, 'FOO="bar baz"\nQUX=corge\n');
    expect(readEnvEntries(filePath)).toEqual({ FOO: "bar baz", QUX: "corge" });
  });
});

describe("loadEnvFileIntoProcessEnv", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("populates keys missing from the target env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-env-load-"));
    const filePath = path.join(dir, ".env");
    fs.writeFileSync(filePath, "MERCURY_TEST_LOAD_KEY=value\n");

    const env: NodeJS.ProcessEnv = {};
    loadEnvFileIntoProcessEnv(filePath, env);
    expect(env.MERCURY_TEST_LOAD_KEY).toBe("value");
  });

  it("does not override existing non-empty values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-env-load-"));
    const filePath = path.join(dir, ".env");
    fs.writeFileSync(filePath, "MERCURY_TEST_LOAD_KEY=from-file\n");

    const env: NodeJS.ProcessEnv = { MERCURY_TEST_LOAD_KEY: "preset" };
    loadEnvFileIntoProcessEnv(filePath, env);
    expect(env.MERCURY_TEST_LOAD_KEY).toBe("preset");
  });

  it("overrides whitespace-only existing values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-env-load-"));
    const filePath = path.join(dir, ".env");
    fs.writeFileSync(filePath, "MERCURY_TEST_LOAD_KEY=from-file\n");

    const env: NodeJS.ProcessEnv = { MERCURY_TEST_LOAD_KEY: "   " };
    loadEnvFileIntoProcessEnv(filePath, env);
    expect(env.MERCURY_TEST_LOAD_KEY).toBe("from-file");
  });

  it("is a no-op when the file does not exist", () => {
    const fakePath = path.join(os.tmpdir(), `mercury-env-missing-${Date.now()}.env`);
    const env: NodeJS.ProcessEnv = {};
    loadEnvFileIntoProcessEnv(fakePath, env);
    expect(env).toEqual({});
  });
});

describe("formatEnvEntries", () => {
  it("emits the default header", () => {
    expect(formatEnvEntries({ FOO: "bar" })).toBe('# Mercury environment variables\nFOO="bar"\n');
  });

  it("emits a custom multi-line header", () => {
    expect(
      formatEnvEntries({ FOO: "bar" }, { headerLines: ["# line 1", "# line 2"] }),
    ).toBe('# line 1\n# line 2\nFOO="bar"\n');
  });

  it("always wraps values in literal double-quotes without escape processing", () => {
    // Mercury's parser strips outer quotes verbatim; backslashes pass through unchanged
    // (intentional — preserves Windows paths through the roundtrip without JSON-style escape doubling).
    expect(formatEnvEntries({ HOME: "C:\\Users\\Reven\\.mercury" })).toContain(
      'HOME="C:\\Users\\Reven\\.mercury"',
    );
  });

  it("roundtrips Windows paths and postgres URLs through parseEnvFile", () => {
    const input = {
      MERCURY_HOME: "C:\\Users\\Reven\\.mercury",
      MERCURY_INSTANCE_ID: "default",
      MERCURY_AGENT_JWT_SECRET: "abc123",
      DATABASE_URL: "postgres://user:pass@host:5432/db",
    };
    const formatted = formatEnvEntries(input);
    expect(parseEnvFile(formatted)).toEqual(input);
  });
});
