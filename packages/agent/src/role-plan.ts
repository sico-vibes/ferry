import { z } from 'zod';
import path from 'node:path';
import { WorkspaceJail } from '@ferry/workspace';

export const EditPlanSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), intent: z.string().min(1) })).min(1),
  changes: z.array(z.object({ path: z.string().min(1), instructions: z.string().min(1) })).min(1),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;

export async function validateEditPlanPaths(
  plan: EditPlan,
  workspace: string,
): Promise<{ plan: EditPlan | null; rejectedCount: number }> {
  const jail = new WorkspaceJail(workspace);
  const canonical = new Map<string, string>();
  let rejectedCount = 0;
  const resolveRelative = async (value: string): Promise<string | null> => {
    if (
      !value.trim() ||
      path.isAbsolute(value) ||
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      /^[a-z]:/i.test(value) ||
      /^(?:\\\\|\/\/)/.test(value) ||
      value.split(/[\\/]/).includes('..')
    )
      return null;
    try {
      const resolved = await jail.resolve(value, { allowMissing: true });
      const relative = jail.relative(resolved).split(path.sep).join('/');
      return relative && relative !== '.' ? relative : null;
    } catch {
      return null;
    }
  };

  const files = [];
  for (const file of plan.files) {
    const relative = await resolveRelative(file.path);
    if (!relative) {
      rejectedCount++;
      continue;
    }
    canonical.set(file.path, relative);
    files.push({ ...file, path: relative });
  }
  const allowedFiles = new Set(files.map(({ path: filePath }) => filePath));
  const changes = [];
  for (const change of plan.changes) {
    const relative = await resolveRelative(change.path);
    const declared = canonical.get(change.path);
    if (!relative || !declared || !allowedFiles.has(relative) || relative !== declared) {
      rejectedCount++;
      continue;
    }
    changes.push({ ...change, path: relative });
  }
  if (rejectedCount > 0 || files.length === 0 || changes.length === 0)
    return { plan: null, rejectedCount: rejectedCount || 1 };
  return { plan: { files, changes }, rejectedCount: 0 };
}

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
