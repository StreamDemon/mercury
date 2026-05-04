import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveMercuryHomeDir,
  resolveMercuryInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.mercury and default instance", () => {
    delete process.env.MERCURY_HOME;
    delete process.env.MERCURY_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(path.resolve(os.homedir(), ".mercury"));
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(os.homedir(), ".mercury", "instances", "default", "config.json"));
  });

  it("supports MERCURY_HOME and explicit instance ids", () => {
    process.env.MERCURY_HOME = "~/mercury-home";

    const home = resolveMercuryHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "mercury-home"));
    expect(resolveMercuryInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveMercuryInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
