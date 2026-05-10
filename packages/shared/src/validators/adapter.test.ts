import { describe, expect, it } from "vitest";
import {
  adapterCapabilitiesSchema,
  adapterInfoSchema,
} from "./adapter.js";

const validCapabilities = {
  supportsInstructionsBundle: true,
  supportsSkills: true,
  supportsLocalAgentJwt: false,
  requiresMaterializedRuntimeSkills: false,
};

describe("adapterCapabilitiesSchema", () => {
  it("accepts a fully-populated capabilities block", () => {
    expect(adapterCapabilitiesSchema.parse(validCapabilities)).toEqual(
      validCapabilities,
    );
  });

  it("rejects a capabilities block missing a required boolean", () => {
    const result = adapterCapabilitiesSchema.safeParse({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("adapterInfoSchema", () => {
  it("accepts a minimum-required builtin adapter", () => {
    const parsed = adapterInfoSchema.parse({
      type: "claude_local",
      label: "Claude (Local)",
      source: "builtin",
      modelsCount: 0,
      loaded: true,
      disabled: false,
      capabilities: validCapabilities,
    });
    expect(parsed.type).toBe("claude_local");
    expect(parsed.source).toBe("builtin");
    expect(parsed.version).toBeUndefined();
    expect(parsed.packageName).toBeUndefined();
  });

  it("accepts an external adapter with all optionals populated", () => {
    const parsed = adapterInfoSchema.parse({
      type: "custom_thing",
      label: "Custom Thing",
      source: "external",
      modelsCount: 3,
      loaded: true,
      disabled: false,
      capabilities: validCapabilities,
      version: "1.2.3",
      packageName: "@mercuryai/adapter-custom-thing",
      isLocalPath: true,
      overriddenBuiltin: true,
      overridePaused: false,
    });
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.overriddenBuiltin).toBe(true);
  });

  it("rejects a missing required field (label)", () => {
    const result = adapterInfoSchema.safeParse({
      type: "claude_local",
      source: "builtin",
      modelsCount: 0,
      loaded: true,
      disabled: false,
      capabilities: validCapabilities,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid source enum value", () => {
    const result = adapterInfoSchema.safeParse({
      type: "claude_local",
      label: "Claude (Local)",
      source: "third-party",
      modelsCount: 0,
      loaded: true,
      disabled: false,
      capabilities: validCapabilities,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative modelsCount", () => {
    const result = adapterInfoSchema.safeParse({
      type: "claude_local",
      label: "Claude (Local)",
      source: "builtin",
      modelsCount: -1,
      loaded: true,
      disabled: false,
      capabilities: validCapabilities,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when capabilities subobject is malformed", () => {
    const result = adapterInfoSchema.safeParse({
      type: "claude_local",
      label: "Claude (Local)",
      source: "builtin",
      modelsCount: 0,
      loaded: true,
      disabled: false,
      capabilities: { supportsSkills: true },
    });
    expect(result.success).toBe(false);
  });
});
