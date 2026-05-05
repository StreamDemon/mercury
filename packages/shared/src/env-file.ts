import { existsSync, readFileSync } from "node:fs";

const DEFAULT_HEADER_LINES = ["# Mercury environment variables"];

export function parseEnvFile(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value) {
      entries[key] = "";
      continue;
    }
    if (value.startsWith("#")) {
      entries[key] = "";
      continue;
    }

    const quote = value.startsWith("\"") ? "\"" : value.startsWith("'") ? "'" : null;
    if (quote) {
      const closeIdx = value.indexOf(quote, 1);
      if (closeIdx > 0) {
        // Quoted value — slice between the quotes; trailing content (including
        // inline comments after the close quote) is dropped.
        entries[key] = value.slice(1, closeIdx);
        continue;
      }
      // Unmatched opening quote — fall through and treat as a bareword.
    }

    entries[key] = value.replace(/\s+#.*$/, "").trim();
  }

  return entries;
}

export function readEnvEntries(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  return parseEnvFile(readFileSync(envPath, "utf8"));
}

export function loadEnvFileIntoProcessEnv(
  envPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const entries = readEnvEntries(envPath);
  for (const [key, value] of Object.entries(entries)) {
    const existing = env[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    env[key] = value;
  }
}

export function formatEnvEntries(
  entries: Record<string, string>,
  options?: { headerLines?: string[] },
): string {
  const headerLines = options?.headerLines ?? DEFAULT_HEADER_LINES;
  return [
    ...headerLines,
    ...Object.entries(entries).map(([key, value]) => `${key}="${value}"`),
    "",
  ].join("\n");
}
