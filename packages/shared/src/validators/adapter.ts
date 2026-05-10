import { z } from "zod";

export const adapterCapabilitiesSchema = z.object({
  supportsInstructionsBundle: z.boolean(),
  supportsSkills: z.boolean(),
  supportsLocalAgentJwt: z.boolean(),
  requiresMaterializedRuntimeSkills: z.boolean(),
});
export type AdapterCapabilities = z.infer<typeof adapterCapabilitiesSchema>;

export const adapterInfoSchema = z.object({
  type: z.string(),
  label: z.string(),
  source: z.enum(["builtin", "external"]),
  modelsCount: z.number().int().nonnegative(),
  loaded: z.boolean(),
  disabled: z.boolean(),
  capabilities: adapterCapabilitiesSchema,
  version: z.string().optional(),
  packageName: z.string().optional(),
  isLocalPath: z.boolean().optional(),
  overriddenBuiltin: z.boolean().optional(),
  overridePaused: z.boolean().optional(),
});
export type AdapterInfo = z.infer<typeof adapterInfoSchema>;
