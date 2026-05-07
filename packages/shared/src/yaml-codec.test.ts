import { describe, expect, it } from "vitest";
import {
  parseFrontmatterMarkdown,
  parseYamlFrontmatter,
  type MarkdownDoc,
} from "./yaml-codec.js";

describe("parseYamlFrontmatter — scalars", () => {
  it("parses booleans, null, and the ~ alias", () => {
    expect(parseYamlFrontmatter("a: true\nb: false\nc: null\nd: ~")).toEqual({
      a: true,
      b: false,
      c: null,
      d: null,
    });
  });

  it("parses integers and floats", () => {
    expect(parseYamlFrontmatter("count: 42\nratio: 3.14\nnegative: -7")).toEqual({
      count: 42,
      ratio: 3.14,
      negative: -7,
    });
  });

  it("parses inline empty array and object literals", () => {
    expect(parseYamlFrontmatter("items: []\nmeta: {}")).toEqual({
      items: [],
      meta: {},
    });
  });

  it("parses JSON-quoted strings", () => {
    expect(parseYamlFrontmatter('label: "hello world"')).toEqual({
      label: "hello world",
    });
  });

  it("parses inline JSON arrays and objects", () => {
    expect(
      parseYamlFrontmatter('tags: ["a","b","c"]\nopts: {"k":1}'),
    ).toEqual({
      tags: ["a", "b", "c"],
      opts: { k: 1 },
    });
  });

  it("falls back to the raw string when JSON-looking content fails to parse", () => {
    expect(parseYamlFrontmatter("malformed: [unbalanced")).toEqual({
      malformed: "[unbalanced",
    });
  });

  it("treats unquoted strings as plain strings", () => {
    expect(parseYamlFrontmatter("label: hello")).toEqual({ label: "hello" });
  });

  it("returns empty object for empty input", () => {
    expect(parseYamlFrontmatter("")).toEqual({});
    expect(parseYamlFrontmatter("\n\n")).toEqual({});
  });
});

describe("parseYamlFrontmatter — block parser", () => {
  it("strips `#` comments and tolerates blank lines", () => {
    const raw = [
      "# heading comment",
      "",
      "name: Mercury",
      "  # indented comment",
      "version: 1",
      "",
    ].join("\n");
    expect(parseYamlFrontmatter(raw)).toEqual({
      name: "Mercury",
      version: 1,
    });
  });

  it("parses nested records by indentation", () => {
    const raw = [
      "owner:",
      "  name: alice",
      "  role: ceo",
      "  budget:",
      "    monthlyCents: 5000",
    ].join("\n");
    expect(parseYamlFrontmatter(raw)).toEqual({
      owner: {
        name: "alice",
        role: "ceo",
        budget: { monthlyCents: 5000 },
      },
    });
  });

  it("parses nested arrays of scalars", () => {
    const raw = [
      "skills:",
      "  - reading",
      "  - writing",
      "  - planning",
    ].join("\n");
    expect(parseYamlFrontmatter(raw)).toEqual({
      skills: ["reading", "writing", "planning"],
    });
  });

  it("parses arrays of records with inline first key + continuation lines", () => {
    // The tricky path documented in skills.ts L465-485 / portability.ts L2113-2133:
    // the first key:value sits on the `- ` line, follow-up keys are indented
    // two spaces past the dash.
    const raw = [
      "agents:",
      "  - name: alice",
      "    role: ceo",
      "  - name: bob",
      "    role: cto",
    ].join("\n");
    expect(parseYamlFrontmatter(raw)).toEqual({
      agents: [
        { name: "alice", role: "ceo" },
        { name: "bob", role: "cto" },
      ],
    });
  });

  it("parses arrays of records with no inline key (all keys indented)", () => {
    const raw = [
      "agents:",
      "  -",
      "    name: alice",
      "    role: ceo",
    ].join("\n");
    expect(parseYamlFrontmatter(raw)).toEqual({
      agents: [{ name: "alice", role: "ceo" }],
    });
  });

  it("returns empty object when top-level content is non-record (e.g. bare scalar)", () => {
    // Mercury manifests are always record-shaped at top level; bare values
    // resolve to an empty record by design.
    expect(parseYamlFrontmatter("just-a-string")).toEqual({});
  });
});

describe("parseFrontmatterMarkdown", () => {
  it("returns empty frontmatter when input has no frontmatter delimiters", () => {
    const result = parseFrontmatterMarkdown("# Just a heading\n\nSome body text.");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("# Just a heading\n\nSome body text.");
  });

  it("parses standard frontmatter + body", () => {
    const raw = [
      "---",
      "name: Mercury",
      "version: 1",
      "---",
      "# Body heading",
      "",
      "Body paragraph.",
      "",
    ].join("\n");
    const result = parseFrontmatterMarkdown(raw);
    expect(result.frontmatter).toEqual({ name: "Mercury", version: 1 });
    expect(result.body).toBe("# Body heading\n\nBody paragraph.");
  });

  it("returns empty frontmatter when closing `---` is missing", () => {
    const raw = "---\nname: Mercury\nversion: 1\n";
    const result = parseFrontmatterMarkdown(raw);
    expect(result.frontmatter).toEqual({});
    // The whole string (trimmed) becomes the body when frontmatter is malformed.
    expect(result.body).toBe(raw.trim());
  });

  it("returns empty body when input is just frontmatter", () => {
    const raw = "---\nname: Mercury\n---\n";
    const result = parseFrontmatterMarkdown(raw);
    expect(result.frontmatter).toEqual({ name: "Mercury" });
    expect(result.body).toBe("");
  });

  it("normalizes CRLF line endings before parsing", () => {
    const raw = "---\r\nname: Mercury\r\nversion: 1\r\n---\r\nBody.\r\n";
    const result = parseFrontmatterMarkdown(raw);
    expect(result.frontmatter).toEqual({ name: "Mercury", version: 1 });
    expect(result.body).toBe("Body.");
  });

  it("returns the MarkdownDoc shape (typed exported alias)", () => {
    const result: MarkdownDoc = parseFrontmatterMarkdown("---\nk: 1\n---\nbody");
    expect(result).toEqual({ frontmatter: { k: 1 }, body: "body" });
  });
});

describe("parseYamlFrontmatter — golden round-trips", () => {
  // Behavior captured from the pre-extraction implementations in
  // server/src/services/{company-skills,company-portability}.ts. Any drift
  // here means the extraction changed parsing semantics — investigate before
  // landing.

  it("parses a representative skill SKILL.md frontmatter", () => {
    const raw = [
      "key: research-summary",
      "slug: research-summary",
      "name: Research Summary",
      "trustLevel: markdown_only",
      "metadata:",
      "  origin: local",
      "  fileInventory:",
      "    - path: SKILL.md",
      "      kind: markdown",
      "      bytes: 1024",
    ].join("\n");
    expect(parseYamlFrontmatter(raw)).toEqual({
      key: "research-summary",
      slug: "research-summary",
      name: "Research Summary",
      trustLevel: "markdown_only",
      metadata: {
        origin: "local",
        fileInventory: [
          { path: "SKILL.md", kind: "markdown", bytes: 1024 },
        ],
      },
    });
  });

  it("parses a representative portability .mercury.yaml extension", () => {
    const raw = [
      "schema: mercury.company/v1",
      "company:",
      "  brandColor: \"#0a84ff\"",
      "  budgetMonthlyCents: 50000",
      "agents:",
      "  ceo:",
      "    adapterType: claude_local",
      "    permissions:",
      "      - read",
      "      - write",
    ].join("\n");
    expect(parseYamlFrontmatter(raw)).toEqual({
      schema: "mercury.company/v1",
      company: {
        brandColor: "#0a84ff",
        budgetMonthlyCents: 50000,
      },
      agents: {
        ceo: {
          adapterType: "claude_local",
          permissions: ["read", "write"],
        },
      },
    });
  });
});
