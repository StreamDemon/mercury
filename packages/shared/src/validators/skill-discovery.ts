import { z } from "zod";

export const availableSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  isMercuryManaged: z.boolean(),
});
export type AvailableSkill = z.infer<typeof availableSkillSchema>;

export const availableSkillsResponseSchema = z.object({
  skills: z.array(availableSkillSchema),
});
export type AvailableSkillsResponse = z.infer<typeof availableSkillsResponseSchema>;
