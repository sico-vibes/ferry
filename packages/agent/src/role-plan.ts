import { z } from 'zod';

export const EditPlanSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), intent: z.string().min(1) })).min(1),
  changes: z.array(z.object({ path: z.string().min(1), instructions: z.string().min(1) })).min(1),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;

export function parseEditPlan(text: string): EditPlan | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return EditPlanSchema.parse(JSON.parse(candidate));
  } catch {
    return null;
  }
}

export function formatEditPlan(plan: EditPlan): string {
  return JSON.stringify(plan, null, 2);
}
