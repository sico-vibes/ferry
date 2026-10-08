import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractRequirements, refinePlan, taskGoal } from '../src/domain/plan.js';
import { RunReportSchema, formatRunReport } from '../src/domain/run-report.js';
import { PlanItemSchema } from '../src/domain/session.js';

describe('requirements checklist', () => {
  it('keeps the blog prompt bullet wording and all four requirements', () => {
    const prompt = readFileSync(new URL('../../../.dev/blog-prompt.txt', import.meta.url), 'utf8');
    const bullets = prompt
      .split(/\r?\n/)
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2));
    expect(extractRequirements(prompt).map((item) => item.text)).toEqual(bullets);
    expect(extractRequirements(prompt)).toHaveLength(4);
  });
  it('leaves plain questions and single sentences without a checklist', () => {
    expect(extractRequirements('Explain X and Y.')).toEqual([]);
    expect(extractRequirements('What is a closure?')).toEqual([]);
  });
  it('handles numbered requirements, section conjunctions and the fifteen-item cap', () => {
    expect(
      extractRequirements('1. Add a header\n2) Add a footer').map((item) => item.text),
    ).toEqual(['Add a header', 'Add a footer']);
    expect(
      extractRequirements('Requirements: add a header and a footer; support phones').map(
        (item) => item.text,
      ),
    ).toEqual(['add a header', 'a footer', 'support phones']);
    expect(
      extractRequirements(
        Array.from({ length: 20 }, (_, i) => `${String(i + 1)}. Item ${String(i)}`).join('\n'),
      ),
    ).toHaveLength(15);
  });
  it('trims full goals and summarizes long requests deterministically', () => {
    const request =
      'Create a single self-contained file named blog.html in this folder with an accessible admin section.';
    expect(taskGoal(`  ${request} \n`)).toBe(request);
    const long = `Build the site.\n\n${'Context '.repeat(400)}\nRequirements:\n- Mobile layout\n- Safe headings`;
    expect(taskGoal(long)).toBe(
      'Build the site.\n\nRequirements:\n- Mobile layout\n- Safe headings',
    );
  });
  it('preserves originals, round-trips evidence and requires a skip reason', () => {
    const original = extractRequirements('- Safe Markdown\n- No overflow');
    expect(refinePlan(original, [])).toEqual(original);
    const done = {
      id: 'requirement_1',
      text: 'Refined wording',
      status: 'done' as const,
      evidence: 'read_file: escapes HTML',
    };
    expect(refinePlan(original, [done])[0]).toEqual({ ...done, text: 'Safe Markdown' });
    expect(PlanItemSchema.parse(done)).toEqual(done);
    expect(PlanItemSchema.parse({ id: 'old', text: 'Legacy', status: 'todo' }).status).toBe('todo');
    expect(() => refinePlan(original, [{ ...done, status: 'skipped', evidence: '' }])).toThrow(
      'needs evidence',
    );
  });
  it('reports checklist status and evidence and reads legacy reports', () => {
    const report = RunReportSchema.parse({
      durationMs: 0,
      steps: 1,
      ownerModel: null,
      modelsUsed: [],
      switches: [],
      waits: [],
      failedAttempts: [],
      tokens: { input: 0, output: 0, reasoning: 0 },
      filesChanged: [],
      outcome: 'completed',
      warnings: [],
    });
    expect(report.checklist).toBeUndefined();
    report.checklist = [
      { id: 'a', text: 'Safe headings', status: 'done', evidence: 'Verified escaping' },
      { id: 'b', text: 'Phone layout', status: 'failed', evidence: 'Overflow at 375px' },
      { id: 'c', text: 'Screenshot', status: 'skipped', evidence: 'Browser unavailable' },
    ];
    expect(formatRunReport(RunReportSchema.parse(report))).toEqual(
      expect.arrayContaining([
        '✓ Safe headings — Verified escaping',
        '✗ Phone layout — Overflow at 375px',
        '– Screenshot — Browser unavailable',
      ]),
    );
  });
});
