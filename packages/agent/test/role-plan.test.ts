import { describe, expect, it } from 'vitest';
import { formatEditPlan, parseEditPlan } from '../src/role-plan.js';

describe('planner/editor contract', () => {
  it('parses a structured edit plan and fenced JSON', () => {
    const plan = {
      files: [{ path: 'src/app.ts', intent: 'Add the route handler.' }],
      changes: [{ path: 'src/app.ts', instructions: 'Add GET /status returning ok.' }],
    };
    expect(parseEditPlan(JSON.stringify(plan))).toEqual(plan);
    expect(parseEditPlan(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)).toEqual(plan);
    expect(parseEditPlan(formatEditPlan(plan))).toEqual(plan);
  });

  it('rejects malformed or incomplete edit plans', () => {
    expect(parseEditPlan('not json')).toBeNull();
    expect(parseEditPlan('{"files":[]}')).toBeNull();
  });
});
