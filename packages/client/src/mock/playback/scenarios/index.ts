import type { Scenario, Step } from '../script.js';

const output = (text: string, originalTokens: number | null = null) => ({
  text,
  filtered: true,
  originalTokens,
  filteredTokens: text.split(/\s+/).length,
  recoveryHandle: null,
});
const change = {
  path: 'src/payments/retry.ts',
  status: 'modified' as const,
  additions: 4,
  deletions: 2,
  before:
    'export function retryDelay(attempt: number) {\n  return Math.min(500 * 2 ** attempt, 8_000);\n}\n\nexport function shouldRetry(status: number) {\n  return status >= 500;\n}',
  after:
    'export function retryDelay(attempt: number) {\n  const boundedAttempt = Math.max(0, attempt);\n  const exponential = 500 * 2 ** boundedAttempt;\n  const jitter = Math.min(boundedAttempt * 37, 250);\n  return Math.min(exponential + jitter, 8_000);\n}\n\nexport function shouldRetry(status: number) {\n  return status >= 500;\n}',
};

const fixTests: Step[] = [
  {
    kind: 'plan',
    goal: 'Fix the flaky payment retry tests',
    items: [
      { text: 'Trace the retry policy and current test expectations', status: 'doing' },
      { text: 'Confirm the backoff edge case in the implementation', status: 'todo' },
      { text: 'Apply a bounded jitter fix', status: 'todo' },
      { text: 'Run the focused test suite after approval', status: 'todo' },
    ],
    nextStep: 'Inspect retryPolicy references',
  },
  {
    kind: 'tool',
    tool: 'grep',
    title: 'Search retry policy references',
    args: { pattern: 'retryPolicy', path: 'src' },
    runMs: 320,
    output: output(
      'src/payments/retry.ts:18\n tests/payments/retry.test.ts:42\n tests/payments/retry.test.ts:87',
      1860,
    ),
  },
  {
    kind: 'tool',
    tool: 'read_file',
    title: 'Read payment retry implementation',
    args: { path: 'src/payments/retry.ts' },
    runMs: 280,
    output: output(
      'retryDelay doubles without normalizing negative attempts; the tests cover the cap but not jitter bounds.',
      910,
    ),
    touched: [{ path: 'src/payments/retry.ts', purpose: 'Review retry backoff behavior' }],
  },
  {
    kind: 'reasoning',
    text: 'The flaky assertion comes from unbounded input reaching the exponent calculation. I can make the delay monotonic for valid attempts while keeping the existing 8 second cap; the test command is the only step that needs approval.',
  },
  {
    kind: 'tool',
    tool: 'edit_file',
    title: 'Bound retry delay and add jitter',
    args: { path: 'src/payments/retry.ts' },
    runMs: 460,
    output: output('Applied a focused retry backoff change.', 1440),
    changes: [change],
    touched: [
      { path: 'src/payments/retry.ts', purpose: 'Normalize attempts and add bounded jitter' },
    ],
  },
  {
    kind: 'text',
    text: 'The implementation change is in place. I’m ready to run the test suite to check the backoff behavior and surrounding payment tests.',
  },
  {
    kind: 'approval',
    approvalKind: 'command',
    summary: 'Run `pnpm test`',
    detail: 'Execute the repository test suite to verify the retry change.',
    risk: 'low',
    then: [
      {
        kind: 'tool',
        tool: 'run_command',
        title: 'Run test suite',
        args: { command: 'pnpm test' },
        runMs: 900,
        output: {
          text: '✓ 212 passed (4.1s)',
          filtered: true,
          originalTokens: 4823,
          filteredTokens: 11,
          recoveryHandle: 'out_test_retry_01',
        },
      },
      { kind: 'checkpoint', label: 'After fixing retry backoff' },
      {
        kind: 'text',
        text: 'The retry path now normalizes negative attempts and adds bounded jitter before applying the existing 8 second ceiling. That keeps retries spread out without changing the maximum wait.\n\nThe full suite passed: 212 tests in 4.1 seconds.\n\n- Updated `src/payments/retry.ts`\n- Verified with `pnpm test`\n- No unrelated files changed.',
      },
    ],
    ifDenied: [
      {
        kind: 'tool',
        tool: 'run_command',
        title: 'Run test suite',
        args: { command: 'pnpm test' },
        runMs: 0,
        output: output('Not run: approval denied.'),
        denied: true,
      },
      {
        kind: 'text',
        text: "Okay — I won't run the tests. The fix is in place; run `pnpm test` when ready.",
      },
    ],
  },
];

const scenarios: Scenario[] = [
  { id: 'fix-tests', match: /test|flaky|failing|fix/i, title: 'Fix flaky tests', steps: fixTests },
  {
    id: 'handoff',
    match: /switch|quota|handoff|long/i,
    title: 'Continue after quota handoff',
    steps: [
      {
        kind: 'plan',
        goal: 'Complete the cross-module change without losing context',
        items: [
          'Inspect request flow',
          'Update retry and client paths',
          'Verify behavior',
          'Summarize changes',
        ].map((text, i) => ({ text, status: i === 0 ? ('doing' as const) : ('todo' as const) })),
      },
      {
        kind: 'tool',
        tool: 'repo_map',
        title: 'Map request modules',
        args: {},
        runMs: 300,
        output: output('src/api → src/retry → src/transport', 2200),
      },
      {
        kind: 'tool',
        tool: 'read_file',
        title: 'Inspect transport boundary',
        args: { path: 'src/transport/client.ts' },
        runMs: 350,
        output: output('Request retries are owned by the transport adapter.', 1200),
      },
      {
        kind: 'handoff',
        from: 'cerebras/gpt-oss-120b' as never,
        to: 'nvidia/nemotron-3-ultra' as never,
        reason: 'quota',
        briefingTokens: 3100,
        explanation:
          'Cerebras daily tokens exhausted · task briefed in 3.1K tokens (plan, 3 files, 2 decisions)',
      },
      {
        kind: 'tool',
        tool: 'edit_file',
        title: 'Update retry boundary',
        args: { path: 'src/retry/policy.ts' },
        runMs: 420,
        output: output('Retry policy now owns the bounded backoff.', 1750),
        touched: [{ path: 'src/retry/policy.ts', purpose: 'Centralize retry behavior' }],
      },
      {
        kind: 'tool',
        tool: 'read_file',
        title: 'Check client integration',
        args: { path: 'src/api/client.ts' },
        runMs: 300,
        output: output('The API client now passes the normalized attempt count.', 820),
      },
      {
        kind: 'text',
        text: 'The work continued on Nemotron after Cerebras reached its daily token limit. The plan and relevant file context stayed attached to the session.\n\nThe retry policy is now centralized, and the API boundary passes normalized attempts. The focused checks are ready to run.',
      },
    ],
  },
  {
    id: 'delegate',
    match: /delegate|codex|opencode|refactor/i,
    title: 'Delegate a bounded refactor',
    steps: [
      {
        kind: 'plan',
        goal: 'Refactor the adapter boundary safely',
        items: [
          'Map adapter responsibilities',
          'Delegate isolated implementation',
          'Review changes',
          'Re-run gates',
        ].map((text, i) => ({ text, status: i === 0 ? ('doing' as const) : ('todo' as const) })),
      },
      {
        kind: 'tool',
        tool: 'repo_map',
        title: 'Map adapter modules',
        args: {},
        runMs: 300,
        output: output('src/adapters/{base,git,terminal}.ts · tests/adapters/*', 2100),
      },
      {
        kind: 'text',
        text: 'The adapter implementations share a small lifecycle contract. I can delegate the isolated cleanup while keeping the public interface and tests under review.',
      },
      {
        kind: 'delegation',
        lane: 'impl',
        brief:
          'Refactor the adapter implementations behind the existing lifecycle contract.\nPreserve exported types and runtime behavior.\nInspect the base adapter and two concrete adapters first.\nKeep the change limited to adapter internals.\nAdd or update focused tests for cleanup behavior.\nDo not change package boundaries or dependencies.\nRun the adapter test suite and lint.\nReport changed files and any follow-up risks.',
      },
      {
        kind: 'text',
        text: 'Gates re-run: 2/2 passing. The delegated change stayed within the adapter boundary, and the existing lifecycle contract remains intact.\n\nI reviewed the touched files and found no package boundary changes.',
      },
      {
        kind: 'text',
        text: 'The refactor is complete and verified. The implementation and focused tests are ready for review.',
      },
    ],
  },
  {
    id: 'exhausted',
    match: /exhaust|out of|no capacity|limit/i,
    title: 'Handle free capacity exhaustion',
    steps: [
      {
        kind: 'text',
        text: 'I have one remaining free-model step. I’ll finish the current inspection, then ask before continuing on a paid model.',
      },
      { kind: 'capacity', steps: 100000 },
      {
        kind: 'approval',
        approvalKind: 'paid_model',
        summary: 'Continue on OpenCode Go (glm-5.3)? ~$0.02 for this step',
        detail:
          'The free providers are exhausted. Continuing uses the configured OpenCode Go model.',
        risk: 'medium',
        then: [
          {
            kind: 'handoff',
            from: 'gemini/gemini-3.8-flash' as never,
            to: 'opencode-go/glm-5.3' as never,
            reason: 'quota',
            briefingTokens: 420,
            explanation: 'Free capacity exhausted; continuing with the approved paid model.',
          },
          {
            kind: 'text',
            text: 'Approved. I switched to OpenCode Go and will keep the remaining work to the requested scope.',
          },
        ],
        ifDenied: [
          {
            kind: 'text',
            text: 'I stopped before using a paid model. Free capacity next resets at {nextReset}.',
          },
        ],
      },
    ],
  },
  {
    id: 'explain',
    match: /.*/,
    title: 'Explain the repository',
    steps: [
      {
        kind: 'reasoning',
        text: 'I’ll trace the package boundary and inspect representative implementation and test files before summarizing the architecture.',
      },
      {
        kind: 'tool',
        tool: 'repo_map',
        title: 'Map repository packages',
        args: {},
        runMs: 250,
        output: output(
          'packages/shared → contracts · packages/client → mock and domains · packages/ui → desktop surfaces',
          2400,
        ),
      },
      {
        kind: 'tool',
        tool: 'read_file',
        title: 'Read architecture entry point',
        args: { path: 'packages/client/src/index.ts' },
        runMs: 260,
        output: output(
          'The public entry exports FerryClient contracts and the mock client factory.',
          610,
        ),
      },
      {
        kind: 'tool',
        tool: 'read_file',
        title: 'Read session domain',
        args: { path: 'packages/client/src/mock/domains/sessions.ts' },
        runMs: 280,
        output: output(
          'Session operations coordinate storage, events, and ScenarioRunner execution.',
          870,
        ),
      },
      {
        kind: 'text',
        text: '# Repository overview\n\n## Package boundaries\n\n| Package | Responsibility |\n| --- | --- |\n| `shared` | Runtime schemas and domain types |\n| `client` | FerryClient API and mock implementation |\n| `ui` | Desktop interface |\n\n## Session flow\n\nA session send stores the user message and starts the configured runner.\n\n```ts\nawait client.sessions.send(sessionId, { text });\n```\n\nThe mock runner reports progress through typed events:\n\n```ts\nclient.on("session.part", ({ part }) => render(part));\n```\n\n1. The client updates session state.\n2. The runner emits message parts and task updates.\n3. Approval responses resume gated steps.',
      },
    ],
  },
];

export default scenarios;
