import { describe, expect, it } from "vitest";
import { orgNodeSchema, type OrgNode } from "./agent.js";

const leaf: OrgNode = {
  id: "node-leaf",
  name: "Leaf",
  role: "general",
  status: "active",
  reports: [],
};

describe("orgNodeSchema", () => {
  it("accepts a leaf node with empty reports", () => {
    const parsed = orgNodeSchema.parse(leaf);
    expect(parsed.reports).toEqual([]);
  });

  it("accepts a one-level tree", () => {
    const parsed = orgNodeSchema.parse({
      id: "root",
      name: "Root",
      role: "ceo",
      status: "active",
      reports: [leaf, { ...leaf, id: "node-leaf-2", name: "Leaf 2" }],
    });
    expect(parsed.reports).toHaveLength(2);
  });

  it("round-trips a three-level deep tree", () => {
    const tree: OrgNode = {
      id: "ceo",
      name: "CEO",
      role: "ceo",
      status: "active",
      reports: [
        {
          id: "vp",
          name: "VP",
          role: "manager",
          status: "active",
          reports: [
            {
              id: "ic",
              name: "IC",
              role: "general",
              status: "active",
              reports: [],
            },
          ],
        },
      ],
    };
    const parsed = orgNodeSchema.parse(tree);
    expect(parsed.reports[0].reports[0].id).toBe("ic");
  });

  it("rejects a node missing the id field", () => {
    const result = orgNodeSchema.safeParse({
      name: "No ID",
      role: "general",
      status: "active",
      reports: [],
    });
    expect(result.success).toBe(false);
  });

  it("parses a tree where the same node object appears at multiple positions (shared identity)", () => {
    // Note: zod doesn't natively detect cycles. We don't construct a true
    // cycle (which would infinite-loop) — we just verify shared identity at
    // multiple sibling positions parses fine.
    const shared: OrgNode = { ...leaf, id: "shared" };
    const parsed = orgNodeSchema.parse({
      id: "root",
      name: "Root",
      role: "ceo",
      status: "active",
      reports: [shared, shared, shared],
    });
    expect(parsed.reports).toHaveLength(3);
    expect(parsed.reports.every((r) => r.id === "shared")).toBe(true);
  });
});
