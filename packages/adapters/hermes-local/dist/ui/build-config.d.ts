/**
 * Build adapter configuration from UI form values.
 *
 * Translates Mercury's CreateConfigValues into the adapterConfig
 * object stored in the agent record.
 */
import type { CreateConfigValues } from "@mercuryai/adapter-utils";
/**
 * Build a Hermes Agent adapter config from the Mercury UI form values.
 */
export declare function buildHermesConfig(v: CreateConfigValues): Record<string, unknown>;
