import { describe, expect, it } from "vitest";
import {
  availableSkillSchema,
  availableSkillsResponseSchema,
} from "./skill-discovery.js";

describe("availableSkillSchema", () => {
  it("accepts a fully-populated skill", () => {
    const parsed = availableSkillSchema.parse({
      name: "design-guide",
      description: "Mercury UI design system guide",
      isMercuryManaged: true,
    });
    expect(parsed.name).toBe("design-guide");
    expect(parsed.isMercuryManaged).toBe(true);
  });

  it("rejects a skill missing the description field", () => {
    expect(() =>
      availableSkillSchema.parse({
        name: "ship",
        isMercuryManaged: false,
      }),
    ).toThrow();
  });

  it("rejects a skill where isMercuryManaged is the wrong type", () => {
    const result = availableSkillSchema.safeParse({
      name: "ship",
      description: "Ship workflow",
      isMercuryManaged: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown extra fields by default", () => {
    const parsed = availableSkillSchema.parse({
      name: "ship",
      description: "Ship workflow",
      isMercuryManaged: false,
      extra: "ignored",
    } as unknown);
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed).toEqual({
      name: "ship",
      description: "Ship workflow",
      isMercuryManaged: false,
    });
  });
});

describe("availableSkillsResponseSchema", () => {
  it("accepts an empty skills array", () => {
    const parsed = availableSkillsResponseSchema.parse({ skills: [] });
    expect(parsed.skills).toEqual([]);
  });

  it("accepts a populated skills array", () => {
    const parsed = availableSkillsResponseSchema.parse({
      skills: [
        { name: "ship", description: "Ship workflow", isMercuryManaged: false },
        { name: "design-guide", description: "Design guide", isMercuryManaged: true },
      ],
    });
    expect(parsed.skills).toHaveLength(2);
  });

  it("rejects a missing skills envelope key", () => {
    const result = availableSkillsResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects when skills entries are malformed", () => {
    const result = availableSkillsResponseSchema.safeParse({
      skills: [{ name: "broken" }],
    });
    expect(result.success).toBe(false);
  });
});
