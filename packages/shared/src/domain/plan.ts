import { z } from 'zod';

export const PlanItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  // Legacy work-plan statuses remain readable in stored sessions.
  status: z.enum(['todo', 'doing', 'done', 'blocked', 'pending', 'failed', 'skipped']),
  evidence: z.string().optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

/** Explicit lists only: ordinary questions and single-sentence requests stay unchanged. */
export function extractRequirements(request: string): PlanItem[] {
  const lines = request.trim().split(/\r?\n/);
  const items: string[] = [];
  let section = false;
  for (const line of lines) {
    const heading = /^\s*requirements\s*:\s*(.*)$/i.exec(line);
    if (heading) {
      section = true;
      if (heading[1]?.trim()) items.push(...splitRequirements(heading[1]));
      continue;
    }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet?.[1]) items.push(bullet[1].trim());
    else if (section && line.trim()) {
      if (/^(?:when done|finally|reply|respond)\b/i.test(line.trim())) section = false;
      else items.push(...splitRequirements(line.trim()));
    }
  }
  return [...new Set(items)].slice(0, 15).map((text, index) => ({
    id: `requirement_${String(index + 1)}`,
    text,
    status: 'pending',
  }));
}

function splitRequirements(text: string): string[] {
  return text
    .split(/\s*;\s*|\s+and\s+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function taskGoal(request: string): string {
  const trimmed = request.trim();
  if (trimmed.length <= 2_000) return trimmed;
  const paragraph = trimmed.split(/\n\s*\n/)[0] ?? '';
  const requirements = extractRequirements(trimmed).map((item) => `- ${item.text}`);
  const suffix = requirements.length ? `\n\nRequirements:\n${requirements.join('\n')}` : '';
  // Keep the deterministic list intact when it itself exceeds the approximate limit.
  return paragraph.slice(0, Math.max(200, 2_000 - suffix.length)) + suffix;
}

export function pendingRequirements(plan: readonly PlanItem[]): PlanItem[] {
  return plan.filter((item) => ['pending', 'todo', 'doing'].includes(item.status));
}

/** Refinements may add work, but cannot silently drop or rewrite original requirements. */
export function refinePlan(
  previous: readonly PlanItem[],
  incoming: readonly PlanItem[],
): PlanItem[] {
  const originals = previous.filter((item) => item.id.startsWith('requirement_'));
  const preserved = originals.map((item) => {
    const update = incoming.find(
      (candidate) => candidate.id === item.id || candidate.text === item.text,
    );
    if (!update) return item;
    if (['done', 'failed', 'skipped'].includes(update.status) && !update.evidence?.trim()) {
      throw new Error(`Requirement ${item.id} needs evidence (or a reason for skipping).`);
    }
    return { ...update, id: item.id, text: item.text };
  });
  return [
    ...preserved,
    ...incoming.filter(
      (item) =>
        !originals.some((original) => original.id === item.id || original.text === item.text),
    ),
  ];
}
