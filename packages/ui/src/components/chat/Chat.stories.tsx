import {
  ApprovalCard,
  AssistantMessage,
  CheckpointMarker,
  DelegationCard,
  HandoffMarker,
  MarkdownPart,
  ReasoningPart,
  ToolCallBlock,
  UserMessage,
} from './index';
import { AnimatedList } from '../data/AnimatedList';
export default { title: 'Chat/Session transcript' };
const output = {
  text: 'src/retry.ts: retry delay resets on every attempt\npackages/api/src/retry.ts: exponentialBackoff()',
  filtered: true,
  originalTokens: 4823,
  filteredTokens: 11,
  recoveryHandle: 'full-grep-1',
};
export const FlakyTests = () => (
  <main className="flex h-[900px] w-[756px] flex-col gap-5 overflow-y-auto bg-canvas p-7">
    <UserMessage>
      Fix the flaky retry tests. Find the source, make a focused fix, and run the relevant suite.
    </UserMessage>
    <AssistantMessage modelName="GLM-5.3">
      <ReasoningPart
        text="I will trace the retry path, inspect the failing test setup, then make a minimal fix and validate it."
        steps={[
          { label: 'Inspect retry tests', status: 'done' },
          { label: 'Trace retry implementation', status: 'active' },
          { label: 'Run focused tests', status: 'pending' },
        ]}
      />
      <AnimatedList className="space-y-3">
        <ToolCallBlock
          tool="update_plan"
          title="Plan: fix retry flakiness"
          args={{ goal: 'fix retry race' }}
          status="succeeded"
          output={{
            text: '1. Inspect flaky test\n2. Fix retry backoff\n3. Run tests',
            filtered: false,
            originalTokens: null,
            filteredTokens: null,
            recoveryHandle: null,
          }}
        />
        <ToolCallBlock
          tool="grep"
          title="Search retry implementation"
          args={{ pattern: 'retry|backoff', path: 'packages' }}
          status="succeeded"
          output={output}
        />
        <ToolCallBlock
          tool="edit_file"
          title="Update retry backoff"
          args={{ path: 'packages/api/src/retry.ts' }}
          status="succeeded"
          output={null}
          durationMs={821}
          changes={[
            {
              path: 'packages/api/src/retry.ts',
              status: 'modified',
              additions: 8,
              deletions: 3,
              before: null,
              after: null,
            },
          ]}
        />
      </AnimatedList>
      <ApprovalCard
        kind="Run test command"
        summary="Run pnpm test"
        detail="pnpm --filter @ferry/api test"
        risk="low"
      />
      <ToolCallBlock
        tool="run_command"
        title="pnpm test"
        args={{ command: 'pnpm --filter @ferry/api test' }}
        status="succeeded"
        durationMs={4100}
        output={{
          text: '✓ 212 passed (4.1s)',
          filtered: true,
          originalTokens: 4823,
          filteredTokens: 11,
          recoveryHandle: 'test-output',
        }}
      />
      <HandoffMarker
        from="Cerebras gpt-oss-120b"
        to="NVIDIA Nemotron 3 Ultra"
        reason="quota"
        briefingTokens={3100}
        explanation="The free quota was nearly exhausted. Ferry carried the plan, inspected files, and current diff to the next available model."
      />
      <CheckpointMarker label="After fixing retry backoff" />
      <DelegationCard
        lane="Focused regression review"
        implementer="Codex"
        status="running"
        progress="Reviewing retry paths and test coverage"
        usage="1.8K tokens"
      />
      <MarkdownPart
        content={
          'The retry race is fixed by preserving the **original attempt timestamp** across retries.\n\n- Focused suite passes: 212 tests\n- Backoff now increases consistently\n\n```ts\nconst delay = baseDelay * 2 ** attempt;\nawait sleep(delay);\n```'
        }
      />
    </AssistantMessage>
  </main>
);
