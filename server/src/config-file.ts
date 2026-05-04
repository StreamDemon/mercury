import fs from "node:fs";
import { mercuryConfigSchema, type MercuryConfig } from "@mercuryai/shared";
import { resolveMercuryConfigPath } from "./paths.js";

export function readConfigFile(): MercuryConfig | null {
  const configPath = resolveMercuryConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return mercuryConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
