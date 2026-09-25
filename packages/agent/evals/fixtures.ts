export type AgentEvalTemplate = 'typescript' | 'crlf' | 'large' | 'monorepo';

export interface AgentEvalFixture {
  id: string;
  title: string;
  prompt: string;
  template: AgentEvalTemplate;
  acceptance: readonly string[];
}

export const AGENT_EVALS: readonly AgentEvalFixture[] = [
  {
    id: 'fix-failing-test',
    title: 'Fix failing TypeScript test',
    prompt: 'Fix the failing test in this repository.',
    template: 'typescript',
    acceptance: ['test command exits successfully'],
  },
  {
    id: 'add-function-test',
    title: 'Add function and test',
    prompt: 'Add a function that doubles a number and a test for it.',
    template: 'typescript',
    acceptance: ['function exists', 'test covers the function'],
  },
  {
    id: 'rename-symbol',
    title: 'Rename symbol across files',
    prompt: 'Rename the exported answer symbol to result in all files.',
    template: 'typescript',
    acceptance: ['all references use result'],
  },
  {
    id: 'read-explain',
    title: 'Read and explain',
    prompt: 'Read the repository and explain why its test fails.',
    template: 'typescript',
    acceptance: ['explanation identifies intentional assertion failure', 'no files changed'],
  },
  {
    id: 'crlf-edit',
    title: 'Edit CRLF file',
    prompt: 'Change the second line in README.md to say updated.',
    template: 'crlf',
    acceptance: ['README.md retains CRLF line endings'],
  },
  {
    id: 'large-targeted-edit',
    title: 'Targeted large-file edit',
    prompt: 'Change line 50000 in large.txt to say updated.',
    template: 'large',
    acceptance: ['only the requested line changed'],
  },
  {
    id: 'diagnose-build',
    title: 'Diagnose failing build',
    prompt: 'Diagnose the failing test without making changes.',
    template: 'typescript',
    acceptance: ['correct failure diagnosis', 'working tree remains unchanged'],
  },
  {
    id: 'multi-file-refactor',
    title: 'Multi-file refactor',
    prompt: 'Move the answer constant to a new module and update its import and test.',
    template: 'monorepo',
    acceptance: ['all imports resolve', 'tests pass'],
  },
];

export interface EvalMeasurement {
  success: boolean;
  steps: number;
  tokens: number;
}

export interface EvalRunOptions {
  live?: boolean;
  run(fixture: AgentEvalFixture): Promise<EvalMeasurement>;
}

export interface EvalReport {
  mode: 'fake' | 'live';
  results: (AgentEvalFixture & EvalMeasurement)[];
  passed: number;
  total: number;
}

/** CI uses a supplied FakeOpenAIServer-backed runner; live providers can be connected later. */
export async function runAgentEvals(options: EvalRunOptions): Promise<EvalReport> {
  const results: EvalReport['results'] = [];
  for (const fixture of AGENT_EVALS) {
    const measurement = await options.run(fixture);
    results.push({ ...fixture, ...measurement });
  }
  return {
    mode: options.live ? 'live' : 'fake',
    results,
    passed: results.filter((result) => result.success).length,
    total: results.length,
  };
}
