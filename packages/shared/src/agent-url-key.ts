const AGENT_URL_KEY_DELIM_RE = /[^a-z0-9]+/g;
const AGENT_URL_KEY_DELIM_PRESERVE_RE = /[^A-Za-z0-9]+/g;
const AGENT_URL_KEY_TRIM_RE = /^-+|-+$/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NormalizeAgentUrlKeyOptions {
  preserveCase?: boolean;
}

export function isUuidLike(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return UUID_RE.test(value.trim());
}

export function normalizeAgentUrlKey(
  value: string | null | undefined,
  options?: NormalizeAgentUrlKeyOptions,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const cased = options?.preserveCase ? trimmed : trimmed.toLowerCase();
  const delimRe = options?.preserveCase ? AGENT_URL_KEY_DELIM_PRESERVE_RE : AGENT_URL_KEY_DELIM_RE;
  const normalized = cased
    .replace(delimRe, "-")
    .replace(AGENT_URL_KEY_TRIM_RE, "");
  return normalized.length > 0 ? normalized : null;
}

export function deriveAgentUrlKey(
  name: string | null | undefined,
  fallback?: string | null,
  options?: NormalizeAgentUrlKeyOptions,
): string {
  return normalizeAgentUrlKey(name, options) ?? normalizeAgentUrlKey(fallback, options) ?? "agent";
}
